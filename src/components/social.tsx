import { CheckCircle2, CircleDashed, Clock, XCircle } from "lucide-react";
import { Badge } from "./ui";

export function VerificationBadge({ status }: { status: string }) {
  if (status === "verified") return <Badge tone="success"><CheckCircle2 className="size-3" /> Verified</Badge>;
  if (status === "pending") return <Badge tone="warning"><Clock className="size-3" /> Pending</Badge>;
  if (status === "failed") return <Badge tone="danger"><XCircle className="size-3" /> Failed</Badge>;
  return <Badge><CircleDashed className="size-3" /> Unverified</Badge>;
}

const POST_TONES: Record<string, "neutral" | "brand" | "ai" | "success" | "warning" | "danger" | "accent"> = {
  draft: "neutral",
  in_review: "warning",
  approved: "brand",
  scheduled: "accent",
  publishing: "accent",
  published: "success",
  failed: "danger",
  cancelled: "neutral",
  pending: "accent",
  claimed: "accent",
  succeeded: "success",
  connected: "success",
  needs_reconnect: "warning",
  revoked: "neutral",
  needs_check: "warning",
  ambiguous: "warning",
  reconciled: "success",
  rejected: "danger",
  error: "danger",
  paused: "warning",
  skipped: "neutral",
  dead: "danger",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={POST_TONES[status] ?? "neutral"}>{status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}</Badge>;
}

export function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-card p-4 shadow-card">
      <p className="text-xs text-ink-3">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      {hint && <p className="mt-0.5 truncate text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

export const fmtDateTime = (iso: string, timeZone?: string) =>
  new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(iso));
