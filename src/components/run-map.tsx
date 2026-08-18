"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as LeafletMap } from "leaflet";
import type { RouteDisplay } from "@/lib/run-detail";
import { formatDuration } from "@/lib/running";
import "leaflet/dist/leaflet.css";

/**
 * The route on an OpenStreetMap base layer.
 *
 * Leaflet touches `window` on import, so it is pulled in from an effect rather
 * than at module scope — that keeps it out of the server render and out of the
 * bundle until a run with a route is actually opened. The tiles are fetched by
 * the reader's own browser straight from openstreetmap.org; nothing about the
 * run is sent anywhere, and the attribution OSM's licence asks for is on the
 * map itself.
 */

/** Fastest → slowest. Green-to-red is what every runner already reads as pace. */
const PACE_BAND_COLORS = ["#34d399", "#a3e635", "#fbbf24", "#fb923c", "#f87171"];
/** Where GPS speed was unusable — a tunnel, a pause, a lost fix. */
const NO_PACE_COLOR = "#64748b";

export function RunMap({ route }: { route: RouteDisplay }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [ready, setReady] = useState(false);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		let map: LeafletMap | null = null;
		let cancelled = false;

		void (async () => {
			try {
				const L = (await import("leaflet")).default;
				if (cancelled) return;

				map = L.map(container, {
					// Scrolling the page past a full-width map must not zoom it.
					scrollWheelZoom: false,
					zoomControl: true,
					attributionControl: true,
				});

				L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
					maxZoom: 19,
					attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
				}).addTo(map);

				for (const segment of route.segments) {
					if (segment.points.length < 2) continue;
					L.polyline(segment.points, {
						color: segment.band === null ? NO_PACE_COLOR : PACE_BAND_COLORS[segment.band],
						weight: 4,
						opacity: 0.95,
						lineJoin: "round",
						lineCap: "round",
					}).addTo(map);
				}

				const pin = (at: [number, number], fill: string, label: string) =>
					L.circleMarker(at, { radius: 6, color: "#0c0c18", weight: 3, fillColor: fill, fillOpacity: 1 })
						.addTo(map as LeafletMap)
						.bindTooltip(label, { direction: "top", offset: [0, -8] });

				pin(route.start, "#34d399", "Start");
				pin(route.finish, "#3390ff", "Finish");

				map.fitBounds(route.bounds, { padding: [28, 28] });
				setReady(true);
			} catch {
				if (!cancelled) setFailed(true);
			}
		})();

		return () => {
			cancelled = true;
			map?.remove();
		};
	}, [route]);

	return (
		<div className="card overflow-hidden">
			<div className="relative">
				<div ref={containerRef} className="run-map h-72 w-full sm:h-[26rem]" />
				{ready ? null : (
					<div className="absolute inset-0 flex items-center justify-center bg-dark-800/80 text-xs text-gray-500">
						{failed ? "Map could not load." : "Loading map…"}
					</div>
				)}
			</div>

			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
				<div className="flex items-center gap-3 text-[11px] text-gray-500">
					<span className="flex items-center gap-1.5">
						<span className="h-2.5 w-2.5 rounded-full bg-emerald-400" aria-hidden="true" />
						Start
					</span>
					<span className="flex items-center gap-1.5">
						<span className="h-2.5 w-2.5 rounded-full bg-brand-500" aria-hidden="true" />
						Finish
					</span>
				</div>

				{route.bandBounds.length > 0 ? (
					<div className="flex items-center gap-2">
						<span className="text-[11px] text-gray-500">
							{route.fastestPaceSPerKm ? `${formatDuration(route.fastestPaceSPerKm)}/km` : "faster"}
						</span>
						<span className="flex overflow-hidden rounded-full" aria-hidden="true">
							{PACE_BAND_COLORS.map((color) => (
								<span key={color} className="h-2 w-6" style={{ background: color }} />
							))}
						</span>
						<span className="text-[11px] text-gray-500">
							{route.slowestPaceSPerKm ? `${formatDuration(route.slowestPaceSPerKm)}/km` : "slower"}
						</span>
					</div>
				) : null}
			</div>
		</div>
	);
}
