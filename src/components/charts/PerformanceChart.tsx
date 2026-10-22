"use client";

import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn } from "../ui";

export type ChartDay = { date: string; clicks: number; impressions: number; ctr: number; position: number };

type MetricKey = "clicks" | "impressions" | "ctr" | "position";
const METRICS: { key: MetricKey; label: string; color: string; fmt: (v: number) => string }[] = [
  { key: "clicks", label: "Clicks", color: "var(--chart-clicks)", fmt: (v) => Math.round(v).toLocaleString("en-US") },
  { key: "impressions", label: "Impressions", color: "var(--chart-impressions)", fmt: (v) => Math.round(v).toLocaleString("en-US") },
  { key: "ctr", label: "CTR", color: "var(--chart-ctr)", fmt: (v) => `${(v * 100).toFixed(2)}%` },
  { key: "position", label: "Avg. position", color: "var(--chart-position)", fmt: (v) => v.toFixed(1) },
];

const short = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const axisNum = (v: number) => (v >= 1000 ? `${(v / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k` : String(v));

// One metric at a time (no dual axes), with the previous period as a dashed line aligned by day.
export function PerformanceChart({ current, previous, hasPrevious }: { current: ChartDay[]; previous: ChartDay[]; hasPrevious: boolean }) {
  const [metric, setMetric] = useState<MetricKey>("clicks");
  const [showPrev, setShowPrev] = useState(true);
  const m = METRICS.find((x) => x.key === metric)!;

  const data = useMemo(
    () =>
      current.map((d, i) => {
        const p = previous[previous.length - current.length + i];
        // Search Console reports no position on days without impressions.
        const valid = (day: ChartDay | undefined) => day && !(metric === "position" && day.impressions === 0);
        return {
          date: d.date,
          value: valid(d) ? d[metric] : null,
          prevDate: p?.date ?? null,
          prev: valid(p) ? p![metric] : null,
        };
      }),
    [current, previous, metric],
  );

  return (
    <div>
      <div className="flex flex-col gap-3 px-5 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div role="tablist" aria-label="Metric" className="inline-flex max-w-full self-start overflow-x-auto rounded-lg bg-subtle p-1">
          {METRICS.map((x) => (
            <button
              key={x.key}
              role="tab"
              aria-selected={metric === x.key}
              onClick={() => setMetric(x.key)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
                metric === x.key ? "bg-card text-ink shadow-card" : "text-ink-2 hover:text-ink",
              )}
            >
              <span className="size-2 rounded-full" style={{ background: x.color }} />
              {x.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-4 text-xs text-ink-2">
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded" style={{ background: m.color }} /> Selected period
          </span>
          {hasPrevious && (
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={showPrev} onChange={(e) => setShowPrev(e.target.checked)} className="accent-[var(--brand)]" />
              <span className="h-0 w-4 border-t-2 border-dashed border-ink-3" /> Previous period
            </label>
          )}
        </div>
      </div>
      {metric === "position" && <p className="px-5 pt-2 text-xs text-ink-3">Lower is better, so the axis is flipped: up means a better ranking.</p>}
      <div className="h-72 px-2 pb-3 pt-4">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 16, left: 4, bottom: 0 }}>
            <defs>
              <linearGradient id="perf-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={m.color} stopOpacity={0.18} />
                <stop offset="100%" stopColor={m.color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis
              dataKey="date"
              tickFormatter={short}
              tick={{ fontSize: 11, fill: "var(--ink-3)" }}
              axisLine={false}
              tickLine={false}
              minTickGap={28}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "var(--ink-3)" }}
              axisLine={false}
              tickLine={false}
              width={44}
              reversed={metric === "position"}
              domain={metric === "position" ? ["dataMin - 1", "dataMax + 1"] : [0, "auto"]}
              allowDecimals={metric !== "clicks" && metric !== "impressions"}
              tickFormatter={(v: number) => (metric === "ctr" ? `${(v * 100).toFixed(1)}%` : metric === "position" ? v.toFixed(1) : axisNum(v))}
            />
            <Tooltip
              cursor={{ stroke: "var(--ink-3)", strokeDasharray: "3 3" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0].payload as (typeof data)[number];
                return (
                  <div className="rounded-lg border border-line bg-card px-3 py-2 text-xs shadow-pop">
                    <p className="font-medium text-ink">{m.label}</p>
                    <p className="mt-1 flex items-center justify-between gap-6 text-ink-2">
                      <span className="flex items-center gap-1.5">
                        <span className="size-2 rounded-full" style={{ background: m.color }} />
                        {short(row.date)}
                      </span>
                      <span className="font-semibold tabular-nums text-ink">{row.value == null ? "–" : m.fmt(row.value)}</span>
                    </p>
                    {hasPrevious && showPrev && row.prevDate && (
                      <p className="mt-0.5 flex items-center justify-between gap-6 text-ink-2">
                        <span className="flex items-center gap-1.5">
                          <span className="size-2 rounded-full bg-ink-3" />
                          {short(row.prevDate)}
                        </span>
                        <span className="tabular-nums">{row.prev == null ? "–" : m.fmt(row.prev)}</span>
                      </p>
                    )}
                  </div>
                );
              }}
            />
            {hasPrevious && showPrev && (
              <Line type="monotone" dataKey="prev" stroke="var(--chart-prev)" strokeWidth={1.5} strokeDasharray="4 4" dot={false} activeDot={false} isAnimationActive={false} connectNulls />
            )}
            <Area
              type="monotone"
              dataKey="value"
              stroke={m.color}
              strokeWidth={2}
              fill={metric === "position" ? "none" : "url(#perf-fill)"}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)", fill: m.color }}
              isAnimationActive={false}
              connectNulls
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
