"use client";

import { useState } from "react";

type Point = { date: string; value: number };

const W = 640;
const H = 160;
const PAD = { top: 12, right: 8, bottom: 22, left: 40 };

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / p) * p;
}

const fmt = (n: number, digits = 0) => n.toLocaleString("en-US", { maximumFractionDigits: digits });
const shortDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// One series per chart (no dual axes); hover shows a crosshair and the day's value.
export function TrendChart({
  title,
  points,
  color,
  digits = 0,
}: {
  title: string;
  points: Point[];
  color: string;
  digits?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return null;

  const max = niceMax(Math.max(...points.map((p) => p.value)));
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => PAD.top + ih - (v / max) * ih;
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const area = `${line}L${x(points.length - 1)},${PAD.top + ih}L${x(0)},${PAD.top + ih}Z`;
  const ticks = [0, max / 2, max];
  const h = hover != null ? points[hover] : null;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.left) / iw) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  }

  return (
    <figure className="rounded-xl border border-line bg-surface p-4">
      <figcaption className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{title}</span>
        <span className="text-ink-2">
          {h ? `${shortDate(h.date)}: ${fmt(h.value, digits)}` : `${shortDate(points[0].date)} – ${shortDate(points[points.length - 1].date)}`}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-2 w-full touch-none"
        role="img"
        aria-label={`${title} by day`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill="var(--muted)">
              {fmt(t, digits)}
            </text>
          </g>
        ))}
        <path d={area} fill={color} opacity={0.1} />
        <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <text x={PAD.left} y={H - 6} fontSize={10} fill="var(--muted)">{shortDate(points[0].date)}</text>
        <text x={W - PAD.right} y={H - 6} fontSize={10} fill="var(--muted)" textAnchor="end">
          {shortDate(points[points.length - 1].date)}
        </text>
        {h && hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + ih} stroke="var(--muted)" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(h.value)} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
      </svg>
    </figure>
  );
}
