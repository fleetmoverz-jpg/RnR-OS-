export const fmtNum = (n: number) => n.toLocaleString("en-US");
export const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
export const fmtPos = (n: number | null | undefined) => (n == null ? "–" : n.toFixed(1));

export function timeAgo(iso: string | null) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

// Change between periods, with an arrow so direction never relies on color alone.
export function Delta({ cur, prev, invert = false, pct = true }: { cur: number; prev: number; invert?: boolean; pct?: boolean }) {
  const diff = cur - prev;
  if (diff === 0 || (pct && prev === 0 && cur === 0)) return <span className="text-xs text-muted">no change</span>;
  const good = invert ? diff < 0 : diff > 0;
  const label = pct && prev > 0 ? `${((Math.abs(diff) / prev) * 100).toFixed(0)}%` : Math.abs(diff).toLocaleString("en-US", { maximumFractionDigits: 1 });
  return (
    <span className={`text-xs font-medium tabular-nums ${good ? "text-good" : "text-bad"}`}>
      {diff > 0 ? "▲" : "▼"} {label}
    </span>
  );
}
