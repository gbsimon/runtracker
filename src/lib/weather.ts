/**
 * Weather for a run, from Open-Meteo (free, no key).
 *
 * Two APIs cover the timeline: the forecast endpoint keeps the last few days
 * of actuals behind `past_days`, and the archive (ERA5) endpoint holds
 * everything older — but the archive lags real time by about five days, so a
 * fresh run has to come from the forecast side.
 */

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

const HOURLY = ["temperature_2m", "relative_humidity_2m", "wind_speed_10m", "precipitation", "weather_code"].join(",");

/** Beyond this the archive has the hour; below it, only the forecast API does. */
const ARCHIVE_LAG_DAYS = 5;

/** Open-Meteo's own caps on how far either window reaches. */
const MAX_PAST_DAYS = 92;
const MAX_FORECAST_DAYS = 16;

const DAY_MS = 86_400_000;

export type WeatherSource = "apple" | "open-meteo" | "apple+open-meteo";

export type RunWeather = {
	tempC: number | null;
	humidityPct: number | null;
	windKmh?: number | null;
	precipMm?: number | null;
	weatherCode?: number | null;
	source: WeatherSource;
};

type HourlyBlock = {
	time?: unknown;
	temperature_2m?: unknown;
	relative_humidity_2m?: unknown;
	wind_speed_10m?: unknown;
	precipitation?: unknown;
	weather_code?: unknown;
};

function finiteOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberAt(series: unknown, index: number): number | null {
	return Array.isArray(series) ? finiteOrNull(series[index]) : null;
}

/** `timezone=UTC` makes every `time` entry a naive UTC `YYYY-MM-DDTHH:mm`. */
function hourIndex(times: unknown, at: Date): number | null {
	if (!Array.isArray(times) || times.length === 0) return null;

	let best: number | null = null;
	let bestDelta = Number.POSITIVE_INFINITY;
	for (let i = 0; i < times.length; i++) {
		const raw = times[i];
		if (typeof raw !== "string") continue;
		const parsed = Date.parse(`${raw}${raw.endsWith("Z") ? "" : ":00Z"}`);
		if (Number.isNaN(parsed)) continue;
		const delta = Math.abs(parsed - at.getTime());
		if (delta < bestDelta) {
			bestDelta = delta;
			best = i;
		}
	}
	// An hour that far from the run is a different day's weather.
	return bestDelta <= 90 * 60_000 ? best : null;
}

function isoDate(at: Date): string {
	return at.toISOString().slice(0, 10);
}

function requestUrl(startedAt: Date, lat: number, lng: number, now: Date): string {
	const ageDays = (now.getTime() - startedAt.getTime()) / DAY_MS;
	const params = new URLSearchParams({
		latitude: lat.toFixed(4),
		longitude: lng.toFixed(4),
		hourly: HOURLY,
		timezone: "UTC",
		wind_speed_unit: "kmh",
	});

	if (ageDays < ARCHIVE_LAG_DAYS) {
		// `past_days` counts whole days back from today, so a run 2.1 days old
		// needs 3 to be sure its hour is inside the window. A clock skew — or a
		// run whose start reads as tomorrow — walks forward instead.
		params.set("past_days", String(Math.min(MAX_PAST_DAYS, Math.max(1, Math.ceil(ageDays) + 1))));
		params.set("forecast_days", String(Math.min(MAX_FORECAST_DAYS, Math.max(1, Math.ceil(-ageDays) + 1))));
		return `${FORECAST_URL}?${params}`;
	}

	// A run can start late and end after midnight UTC; ask for both days.
	params.set("start_date", isoDate(new Date(startedAt.getTime() - DAY_MS)));
	params.set("end_date", isoDate(new Date(startedAt.getTime() + DAY_MS)));
	return `${ARCHIVE_URL}?${params}`;
}

export type FetchWeatherOptions = {
	timeoutMs?: number;
	now?: Date;
	/** Injected by the unit checks so the failure path can be exercised offline. */
	fetchImpl?: typeof fetch;
};

/**
 * Best-effort: any failure resolves to `null` rather than throwing, because
 * ingest must never lose a run over the weather. The nightly sweep (item 20)
 * picks up whatever comes back empty.
 */
export async function fetchRunWeather(
	startedAt: Date,
	lat: number,
	lng: number,
	options: FetchWeatherOptions = {},
): Promise<RunWeather | null> {
	const { timeoutMs = 4000, now = new Date(), fetchImpl = fetch } = options;

	try {
		const response = await fetchImpl(requestUrl(startedAt, lat, lng, now), {
			signal: AbortSignal.timeout(timeoutMs),
			headers: { accept: "application/json" },
		});
		if (!response.ok) return null;

		const body = (await response.json()) as { hourly?: HourlyBlock };
		const hourly = body.hourly;
		if (!hourly) return null;

		const index = hourIndex(hourly.time, startedAt);
		if (index === null) return null;

		const weather: RunWeather = {
			tempC: numberAt(hourly.temperature_2m, index),
			humidityPct: numberAt(hourly.relative_humidity_2m, index),
			windKmh: numberAt(hourly.wind_speed_10m, index),
			precipMm: numberAt(hourly.precipitation, index),
			weatherCode: numberAt(hourly.weather_code, index),
			source: "open-meteo",
		};
		// All-null means the hour exists but carries no data — no better than nothing.
		return weather.tempC === null && weather.humidityPct === null && weather.windKmh === null ? null : weather;
	} catch {
		return null;
	}
}

/**
 * The watch measures temperature and humidity at the wrist, which beats a
 * gridded model for what the runner actually felt; Open-Meteo supplies the
 * fields Apple never sends (wind, precipitation, conditions).
 */
export function mergeWeather(apple: RunWeather | null, remote: RunWeather | null): RunWeather | null {
	if (!apple) return remote;
	if (!remote) return apple;

	return {
		...remote,
		tempC: apple.tempC ?? remote.tempC,
		humidityPct: apple.humidityPct ?? remote.humidityPct,
		source: "apple+open-meteo",
	};
}

// ---------------------------------------------------------------------------
// Reading it back for display
// ---------------------------------------------------------------------------

/** WMO 4677 codes, as Open-Meteo returns them in `weather_code`. */
const WEATHER_CODES: Record<number, { label: string; emoji: string }> = {
	0: { label: "Clear", emoji: "☀️" },
	1: { label: "Mainly clear", emoji: "🌤️" },
	2: { label: "Partly cloudy", emoji: "⛅" },
	3: { label: "Overcast", emoji: "☁️" },
	45: { label: "Fog", emoji: "🌫️" },
	48: { label: "Freezing fog", emoji: "🌫️" },
	51: { label: "Light drizzle", emoji: "🌦️" },
	53: { label: "Drizzle", emoji: "🌦️" },
	55: { label: "Heavy drizzle", emoji: "🌧️" },
	56: { label: "Freezing drizzle", emoji: "🌧️" },
	57: { label: "Freezing drizzle", emoji: "🌧️" },
	61: { label: "Light rain", emoji: "🌦️" },
	63: { label: "Rain", emoji: "🌧️" },
	65: { label: "Heavy rain", emoji: "🌧️" },
	66: { label: "Freezing rain", emoji: "🌨️" },
	67: { label: "Freezing rain", emoji: "🌨️" },
	71: { label: "Light snow", emoji: "🌨️" },
	73: { label: "Snow", emoji: "❄️" },
	75: { label: "Heavy snow", emoji: "❄️" },
	77: { label: "Snow grains", emoji: "❄️" },
	80: { label: "Light showers", emoji: "🌦️" },
	81: { label: "Showers", emoji: "🌧️" },
	82: { label: "Heavy showers", emoji: "⛈️" },
	85: { label: "Snow showers", emoji: "🌨️" },
	86: { label: "Heavy snow showers", emoji: "❄️" },
	95: { label: "Thunderstorm", emoji: "⛈️" },
	96: { label: "Thunderstorm, hail", emoji: "⛈️" },
	99: { label: "Thunderstorm, hail", emoji: "⛈️" },
};

export function weatherCodeLabel(code: number | null | undefined): { label: string; emoji: string } | null {
	if (code === null || code === undefined || !Number.isFinite(code)) return null;
	return WEATHER_CODES[code] ?? null;
}

export type WeatherDisplay = {
	tempC: number | null;
	humidityPct: number | null;
	windKmh: number | null;
	precipMm: number | null;
	condition: { label: string; emoji: string } | null;
	source: string | null;
};

/** `runs.weather` is untyped jsonb, so every field is checked rather than cast. */
export function readWeather(raw: unknown): WeatherDisplay | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const weather = raw as Partial<RunWeather>;

	const display: WeatherDisplay = {
		tempC: finiteOrNull(weather.tempC),
		humidityPct: finiteOrNull(weather.humidityPct),
		windKmh: finiteOrNull(weather.windKmh),
		precipMm: finiteOrNull(weather.precipMm),
		condition: weatherCodeLabel(finiteOrNull(weather.weatherCode)),
		source: typeof weather.source === "string" ? weather.source : null,
	};

	const empty =
		display.tempC === null &&
		display.humidityPct === null &&
		display.windKmh === null &&
		display.precipMm === null &&
		display.condition === null;
	return empty ? null : display;
}

/** Apple-only weather still deserves the model's wind and conditions. */
export function needsRemoteWeather(weather: unknown): boolean {
	if (weather === null || typeof weather !== "object") return true;
	const source = (weather as RunWeather).source;
	return source === "apple";
}
