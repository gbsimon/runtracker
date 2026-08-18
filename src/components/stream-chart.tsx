"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import type { ChartSeries } from "@/lib/run-detail";
import { formatElapsed } from "@/lib/running";

/**
 * The one chart the run detail view draws — heart rate, cadence and elevation
 * are the same line with different axes.
 *
 * The app already hand-rolls its charts (`mileage-chart.tsx`), so this stays
 * dependency-free. The path is laid out in a fixed 1000×300 viewBox stretched
 * to the container with `preserveAspectRatio="none"`, which means no width
 * measurement is needed to render — `vector-effect: non-scaling-stroke` keeps
 * the line an even 2px however far it stretches. Anything that must not be
 * stretched (labels, the crosshair dot) is HTML positioned over the SVG.
 */

const VIEW_W = 1000;
const VIEW_H = 300;
/** Head-room above and below the line, as a share of the value range. */
const Y_PADDING = 0.12;

export type ValueFormat = "bpm" | "spm" | "metres";
export type AxisFormat = "elapsed" | "km";

export type ChartMarker = { y: number; label: string };

function formatValue(value: number, format: ValueFormat): string {
	switch (format) {
		case "bpm":
			return `${Math.round(value)} bpm`;
		case "spm":
			return `${Math.round(value)} spm`;
		case "metres":
			return `${Math.round(value)} m`;
	}
}

function formatAxis(value: number, format: AxisFormat): string {
	return format === "elapsed" ? formatElapsed(value) : `${value.toFixed(value < 10 ? 1 : 0)} km`;
}

export function StreamChart({
	title,
	series,
	color,
	valueFormat,
	axisFormat,
	markers = [],
	summary,
}: {
	title: string;
	series: ChartSeries;
	/** A CSS colour — the line, its glow and the area fill are all derived from it. */
	color: string;
	valueFormat: ValueFormat;
	axisFormat: AxisFormat;
	markers?: ChartMarker[];
	/** Shown in the header until the reader hovers a sample. */
	summary: string;
}) {
	const [hovered, setHovered] = useState<number | null>(null);
	const plotRef = useRef<HTMLDivElement>(null);

	const { points, xMin, xMax, min, max } = series;

	const domain = useMemo(() => {
		const span = max - min;
		// A flat line still needs a range, or every point lands on ±Infinity.
		const pad = span > 0 ? span * Y_PADDING : Math.max(1, Math.abs(max) * 0.05);
		return { low: min - pad, high: max + pad, xSpan: xMax - xMin || 1 };
	}, [min, max, xMin, xMax]);

	const toX = useCallback((x: number) => ((x - xMin) / domain.xSpan) * VIEW_W, [xMin, domain.xSpan]);
	const toY = useCallback(
		(y: number) => VIEW_H - ((y - domain.low) / (domain.high - domain.low)) * VIEW_H,
		[domain.low, domain.high],
	);

	const { line, area } = useMemo(() => {
		const commands = points.map((point, i) => `${i === 0 ? "M" : "L"}${toX(point.x).toFixed(1)},${toY(point.y).toFixed(1)}`);
		const path = commands.join("");
		const first = toX(points[0].x).toFixed(1);
		const last = toX(points[points.length - 1].x).toFixed(1);
		return { line: path, area: `${path}L${last},${VIEW_H}L${first},${VIEW_H}Z` };
	}, [points, toX, toY]);

	// `useId`, not a random string: the server and the client have to agree on it.
	const gradientId = `stream-fill-${useId()}`;

	const scrub = useCallback(
		(clientX: number) => {
			const box = plotRef.current?.getBoundingClientRect();
			if (!box || box.width === 0) return;
			const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
			const target = xMin + ratio * domain.xSpan;

			// The series is monotone in x, so a walk from the proportional guess
			// finds the nearest sample without scanning all 300.
			let index = Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))));
			while (index > 0 && points[index - 1].x > target) index -= 1;
			while (index < points.length - 1 && points[index + 1].x < target) index += 1;
			if (index < points.length - 1 && Math.abs(points[index + 1].x - target) < Math.abs(points[index].x - target)) {
				index += 1;
			}
			setHovered(index);
		},
		[points, xMin, domain.xSpan],
	);

	const active = hovered !== null ? points[hovered] : null;

	return (
		<div className="card p-4 sm:p-5">
			<div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<h3 className="flex items-center gap-2 text-sm font-bold text-gray-300">
					<span className="h-2 w-2 rounded-full" style={{ background: color }} aria-hidden="true" />
					{title}
				</h3>
				<p className="text-xs tabular-nums text-gray-400">
					{active ? (
						<>
							<span className="font-semibold text-white">{formatValue(active.y, valueFormat)}</span>
							<span className="text-gray-500"> at {formatAxis(active.x, axisFormat)}</span>
						</>
					) : (
						summary
					)}
				</p>
			</div>

			<div className="flex">
				<div className="relative w-11 shrink-0 text-right text-[10px] tabular-nums leading-none text-gray-600">
					<span className="absolute right-2 top-0 -translate-y-1/2">{Math.round(domain.high)}</span>
					<span className="absolute right-2 top-1/2 -translate-y-1/2">{Math.round((domain.high + domain.low) / 2)}</span>
					<span className="absolute bottom-0 right-2 translate-y-1/2">{Math.round(domain.low)}</span>
				</div>

				{/* The pointer readout is an enhancement; the summary in the header is what a screen reader gets. */}
				<div
					ref={plotRef}
					role="img"
					aria-label={`${title}. ${summary}`}
					className="relative h-40 min-w-0 flex-1 sm:h-48"
					style={{ touchAction: "pan-y" }}
					onPointerMove={(event) => scrub(event.clientX)}
					onPointerDown={(event) => scrub(event.clientX)}
					onPointerLeave={() => setHovered(null)}
				>
					<svg
						className="h-full w-full overflow-visible"
						viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
						preserveAspectRatio="none"
						aria-hidden="true"
					>
						<defs>
							<linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
								<stop offset="0%" stopColor={color} stopOpacity="0.28" />
								<stop offset="100%" stopColor={color} stopOpacity="0" />
							</linearGradient>
						</defs>

						{[0, 0.5, 1].map((fraction) => (
							<line
								key={fraction}
								x1="0"
								x2={VIEW_W}
								y1={fraction * VIEW_H}
								y2={fraction * VIEW_H}
								stroke="rgb(255 255 255 / 0.07)"
								strokeWidth="1"
								vectorEffect="non-scaling-stroke"
							/>
						))}

						{markers.map((marker) => (
							<line
								key={marker.label}
								x1="0"
								x2={VIEW_W}
								y1={toY(marker.y)}
								y2={toY(marker.y)}
								stroke={color}
								strokeOpacity="0.4"
								strokeWidth="1"
								strokeDasharray="4 4"
								vectorEffect="non-scaling-stroke"
							/>
						))}

						<path d={area} fill={`url(#${gradientId})`} />
						<path
							d={line}
							fill="none"
							stroke={color}
							strokeWidth="2"
							strokeLinejoin="round"
							strokeLinecap="round"
							vectorEffect="non-scaling-stroke"
						/>

						{active ? (
							<line
								x1={toX(active.x)}
								x2={toX(active.x)}
								y1="0"
								y2={VIEW_H}
								stroke="rgb(255 255 255 / 0.35)"
								strokeWidth="1"
								vectorEffect="non-scaling-stroke"
							/>
						) : null}
					</svg>

					{markers.map((marker) => (
						<span
							key={marker.label}
							className="pointer-events-none absolute left-1 -translate-y-1/2 rounded bg-dark-800/70 px-1 text-[10px] leading-tight text-gray-500"
							style={{ top: `${(toY(marker.y) / VIEW_H) * 100}%` }}
						>
							{marker.label}
						</span>
					))}

					{active ? (
						<span
							className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-dark-800"
							style={{
								left: `${(toX(active.x) / VIEW_W) * 100}%`,
								top: `${(toY(active.y) / VIEW_H) * 100}%`,
								background: color,
							}}
							aria-hidden="true"
						/>
					) : null}
				</div>
			</div>

			<div className="ml-11 mt-1.5 flex justify-between text-[10px] tabular-nums text-gray-600">
				<span>{formatAxis(xMin, axisFormat)}</span>
				<span>{formatAxis(xMin + domain.xSpan / 2, axisFormat)}</span>
				<span>{formatAxis(xMax, axisFormat)}</span>
			</div>
		</div>
	);
}
