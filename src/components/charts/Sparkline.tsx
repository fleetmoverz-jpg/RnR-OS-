// Tiny inline trend line. Server-renderable; no axes, just the shape.
export function Sparkline({
  values,
  color = "var(--brand)",
  width = 96,
  height = 28,
  invert = false,
  area = true,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  invert?: boolean;
  area?: boolean;
}) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 2;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const t = (v - min) / span;
    const y = pad + (invert ? t : 1 - t) * (height - pad * 2);
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="overflow-visible">
      {area && <path d={`${line}L${width},${height}L0,${height}Z`} fill={color} opacity={0.08} />}
      <path d={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
