import { CheckCircle2, Sparkles } from "lucide-react";
import type { Recommendation } from "@/lib/ai/recommendations";
import { Badge, cn } from "./ui";

const PRIORITY: Record<Recommendation["priority"], { tone: "danger" | "warning" | "neutral"; label: string }> = {
  high: { tone: "danger", label: "High impact" },
  medium: { tone: "warning", label: "Medium impact" },
  low: { tone: "neutral", label: "Low impact" },
};

const CATEGORY: Record<Recommendation["category"], string> = {
  content: "Content",
  ctr: "Click-through rate",
  rankings: "Rankings",
  cannibalization: "Cannibalization",
  indexing: "Indexing",
  technical: "Technical",
};

export function RecommendationCard({ r, compact = false }: { r: Recommendation; compact?: boolean }) {
  const p = PRIORITY[r.priority];
  return (
    <div className={cn("rounded-xl border border-line bg-card", compact ? "p-3.5" : "p-5 shadow-card")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="ai"><Sparkles className="size-3" />{CATEGORY[r.category]}</Badge>
        <Badge tone={p.tone}>{p.label}</Badge>
      </div>
      <h3 className={cn("mt-2.5 font-semibold tracking-tight", compact ? "text-[13px]" : "text-[15px]")}>{r.title}</h3>
      <p className={cn("mt-1 text-ink-2", compact ? "line-clamp-2 text-xs" : "text-[13px] leading-relaxed")}>{r.why}</p>
      {!compact && (
        <>
          <ul className="mt-3 space-y-1.5">
            {r.actions.map((a, i) => (
              <li key={i} className="flex gap-2 text-[13px]">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                <span>{a}</span>
              </li>
            ))}
          </ul>
          {r.targets.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {r.targets.slice(0, 8).map((t) => (
                <span key={t} className="max-w-full truncate rounded-md bg-subtle px-2 py-0.5 text-[11px] text-ink-2 ring-1 ring-line">
                  {t.replace(/^https?:\/\/[^/]+/, "") || t}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
