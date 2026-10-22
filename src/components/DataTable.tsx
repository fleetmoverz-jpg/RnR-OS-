"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ExternalLink, Search, SearchX } from "lucide-react";
import { Sparkline } from "./charts/Sparkline";
import { Delta, fmtNum, fmtPct, fmtPos } from "./format";
import { cn, EmptyState } from "./ui";

// Rows are plain data so server pages can pass them straight in.
export type Row = {
  key: string;
  label?: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
  prev_clicks?: number;
  prev_impressions?: number;
  prev_ctr?: number;
  prev_position?: number | null;
  trend?: number[];
};

export type Column = "clicks" | "impressions" | "ctr" | "position" | "clicksChange" | "positionChange" | "trend";

const HEAD: Record<Column, { label: string; title?: string }> = {
  clicks: { label: "Clicks" },
  impressions: { label: "Impressions" },
  ctr: { label: "CTR", title: "Click-through rate: clicks divided by impressions" },
  position: { label: "Position", title: "Average position in Google. Lower is better." },
  clicksChange: { label: "Clicks Δ", title: "Change in clicks versus the previous period" },
  positionChange: { label: "Position Δ", title: "Change in average position. A drop in the number is an improvement." },
  trend: { label: "Trend", title: "Daily clicks in the selected period" },
};

function sortValue(r: Row, c: Column): number {
  switch (c) {
    case "clicksChange":
      return r.clicks - (r.prev_clicks ?? 0);
    case "positionChange":
      return r.position != null && r.prev_position != null ? r.position - r.prev_position : Number.POSITIVE_INFINITY;
    case "trend":
      return r.clicks;
    case "position":
      return r.position ?? Number.POSITIVE_INFINITY;
    default:
      return r[c];
  }
}

function Cell({ r, c }: { r: Row; c: Column }) {
  const hasPrev = (r.prev_impressions ?? 0) > 0;
  switch (c) {
    case "clicks":
      return <>{fmtNum(r.clicks)}</>;
    case "impressions":
      return <>{fmtNum(r.impressions)}</>;
    case "ctr":
      return <>{fmtPct(r.ctr)}</>;
    case "position":
      return <>{fmtPos(r.position)}</>;
    case "clicksChange":
      return <Delta cur={r.clicks} prev={r.prev_clicks ?? 0} mode="absolute" hasPrev={hasPrev || r.clicks > 0} />;
    case "positionChange":
      return r.position != null && r.prev_position != null ? (
        <Delta cur={r.position} prev={r.prev_position} mode="absolute" digits={1} lowerIsBetter />
      ) : (
        <span className="text-xs text-ink-3">{r.prev_position == null && r.position != null ? "new" : "–"}</span>
      );
    case "trend":
      return r.trend ? <Sparkline values={r.trend} width={80} height={22} color="var(--chart-clicks)" /> : <span className="text-ink-3">–</span>;
  }
}

export function DataTable({
  rows,
  columns,
  keyLabel,
  isUrl = false,
  pageSize = 25,
  defaultSort = "clicks",
  searchPlaceholder = "Search…",
  emptyTitle = "No data for this period",
  emptyText,
  dense = false,
}: {
  rows: Row[];
  columns: Column[];
  keyLabel: string;
  isUrl?: boolean;
  pageSize?: number;
  defaultSort?: Column;
  searchPlaceholder?: string;
  emptyTitle?: string;
  emptyText?: string;
  dense?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ col: Column | "key"; desc: boolean }>({ col: defaultSort, desc: defaultSort !== "position" });
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? rows.filter((r) => (r.label ?? r.key).toLowerCase().includes(q)) : rows;
    const dir = sort.desc ? -1 : 1;
    return [...list].sort((a, b) =>
      sort.col === "key"
        ? dir * (a.label ?? a.key).localeCompare(b.label ?? b.key)
        : dir * (sortValue(a, sort.col) - sortValue(b, sort.col)) || b.impressions - a.impressions,
    );
  }, [rows, query, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * pageSize, (current + 1) * pageSize);

  function sortBy(col: Column | "key") {
    setPage(0);
    setSort((s) => (s.col === col ? { col, desc: !s.desc } : { col, desc: col !== "key" && col !== "position" }));
  }

  const sortIcon = (col: Column | "key") =>
    sort.col === col ? sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" /> : null;

  return (
    <div>
      {rows.length > 8 && (
        <div className="flex items-center justify-between gap-3 px-5 py-3">
          <label className="relative block w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
              placeholder={searchPlaceholder}
              className="h-9 w-full rounded-lg border border-line bg-card pl-8 pr-3 text-[13px] placeholder:text-ink-3 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15"
            />
          </label>
          <p className="hidden shrink-0 text-xs text-ink-3 sm:block">{fmtNum(filtered.length)} rows</p>
        </div>
      )}
      {visible.length === 0 ? (
        <EmptyState icon={SearchX} title={query ? "No matches" : emptyTitle}>
          {query ? `Nothing matches “${query}”.` : emptyText}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-y border-line bg-subtle/50 text-left text-xs text-ink-2">
                <th className="px-5 py-2.5 font-medium">
                  <button onClick={() => sortBy("key")} className="inline-flex items-center gap-1 hover:text-ink">
                    {keyLabel} {sortIcon("key")}
                  </button>
                </th>
                {columns.map((c) => (
                  <th key={c} className="whitespace-nowrap px-4 py-2.5 text-right font-medium last:pr-5">
                    <button onClick={() => sortBy(c)} title={HEAD[c].title} className="inline-flex items-center gap-1 hover:text-ink">
                      {sortIcon(c)}
                      {HEAD[c].label}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.key} className="border-b border-line/70 transition-colors last:border-0 hover:bg-brand-soft/40">
                  <td className={cn("max-w-[28rem] px-5", dense ? "py-2" : "py-2.5")}>
                    {isUrl ? (
                      <a href={r.key} target="_blank" rel="noreferrer" className="group inline-flex max-w-full items-center gap-1 text-ink hover:text-brand">
                        <span className="truncate">{r.label ?? r.key}</span>
                        <ExternalLink className="size-3 shrink-0 opacity-0 group-hover:opacity-100" />
                      </a>
                    ) : (
                      <span className="block truncate" title={r.label ?? r.key}>{r.label ?? r.key}</span>
                    )}
                  </td>
                  {columns.map((c) => (
                    <td key={c} className={cn("whitespace-nowrap px-4 text-right tabular-nums last:pr-5", dense ? "py-2" : "py-2.5")}>
                      <span className="inline-flex justify-end"><Cell r={r} c={c} /></span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="flex items-center justify-between border-t border-line px-5 py-3 text-xs text-ink-2">
          <span>
            {fmtNum(current * pageSize + 1)}–{fmtNum(Math.min(filtered.length, (current + 1) * pageSize))} of {fmtNum(filtered.length)}
          </span>
          <div className="flex gap-1">
            <button disabled={current === 0} onClick={() => setPage(current - 1)} className="flex size-8 items-center justify-center rounded-lg border border-line hover:bg-subtle disabled:opacity-40" aria-label="Previous page">
              <ChevronLeft className="size-4" />
            </button>
            <button disabled={current >= pages - 1} onClick={() => setPage(current + 1)} className="flex size-8 items-center justify-center rounded-lg border border-line hover:bg-subtle disabled:opacity-40" aria-label="Next page">
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
