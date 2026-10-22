import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "./ui";

export const fmtNum = (n: number) => n.toLocaleString("en-US");
export const fmtCompact = (n: number) =>
  n >= 10_000 ? n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 }) : fmtNum(n);
export const fmtPct = (n: number) => `${(n * 100).toFixed(n < 0.1 ? 2 : 1)}%`;
export const fmtPos = (n: number | null | undefined) => (n == null ? "–" : n.toFixed(1));
export const fmtDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export const fmtShortDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function timeAgo(iso: string | null) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * Change between periods. `lowerIsBetter` flips the color for average position, where a
 * smaller number is a better ranking. `mode` picks percent change or the absolute difference.
 * With no previous data there is nothing to compare, so it says "new" rather than inventing a change.
 */
export function Delta({
  cur,
  prev,
  lowerIsBetter = false,
  mode = "percent",
  digits = 0,
  hasPrev = true,
  className,
}: {
  cur: number;
  prev: number;
  lowerIsBetter?: boolean;
  mode?: "percent" | "absolute" | "points";
  digits?: number;
  hasPrev?: boolean;
  className?: string;
}) {
  if (!hasPrev) return <span className={cn("text-xs text-ink-3", className)}>new</span>;
  const diff = cur - prev;
  const tiny = mode === "points" ? Math.abs(diff) < 0.00005 : Math.abs(diff) < 0.5 * 10 ** -digits;
  if (tiny || (mode === "percent" && prev === 0 && cur === 0)) {
    return (
      <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium text-ink-3", className)}>
        <Minus className="size-3" /> 0
      </span>
    );
  }
  const good = lowerIsBetter ? diff < 0 : diff > 0;
  let label: string;
  if (mode === "percent") label = prev > 0 ? `${((Math.abs(diff) / prev) * 100).toFixed(1)}%` : "new";
  else if (mode === "points") label = `${(Math.abs(diff) * 100).toFixed(2)} pts`;
  else label = Math.abs(diff).toLocaleString("en-US", { maximumFractionDigits: digits });
  const Arrow = diff > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium tabular-nums", good ? "text-success-ink" : "text-danger-ink", className)}>
      <Arrow className="size-3.5" />
      {label}
    </span>
  );
}
