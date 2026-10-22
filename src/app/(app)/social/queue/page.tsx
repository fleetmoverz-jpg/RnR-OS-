import Link from "next/link";
import { AlertTriangle, Bell, BellOff, CheckCheck, Info, ListOrdered, Pause, Play, Search, SkipForward, X, XCircle, Zap } from "lucide-react";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/social/workspace";
import { can } from "@/lib/social/policy";
import { platformLabel } from "@/lib/social/platforms";
import { publishService } from "@/lib/social/publish/service";
import { publishDeps } from "@/lib/social/publish/server";
import { queueService, VIEWS, type QueueItem, type QueueView } from "@/lib/social/automation/queue";
import { Badge, Card, CardHeader, cn, EmptyState, inputClass, PageHeader } from "@/components/ui";
import { ActionButton } from "@/components/ActionButton";
import { ActionForm } from "@/components/ActionForm";
import { Stat, StatusBadge, fmtDateTime } from "@/components/social";
import { timeAgo } from "@/components/format";
import {
  cancelJobAction,
  checkJobAction,
  markNotificationsReadAction,
  pauseJobAction,
  rescheduleJobAction,
  resumeJobAction,
  runWorkerNowAction,
  setPauseAllAction,
  skipJobAction,
} from "../actions";

export const metadata = { title: "Publishing Queue" };

const VIEW_LABEL: Record<QueueView, string> = { upcoming: "Upcoming", attention: "Needs attention", done: "Done" };
const SOURCE_LABEL: Record<string, string> = { manual: "Published by hand", schedule: "Scheduled by hand", automation: "Automation" };
const SEVERITY_ICON = { error: XCircle, warning: AlertTriangle, info: Info };
const SEVERITY_TONE = { error: "text-danger-ink", warning: "text-warning-ink", info: "text-ink-3" };

// The scheduler runs every 5 minutes; this long without a run means it isn't set up or is failing.
const STALE_WORKER_MINUTES = 15;
const minutesSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 60_000;

function Reschedule({ item }: { item: QueueItem }) {
  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-xs font-medium text-brand hover:underline">Reschedule</summary>
      <ActionForm action={rescheduleJobAction.bind(null, item.id)} submitLabel="Save" variant="secondary" className="mt-2 flex flex-wrap items-end gap-2 space-y-0">
        <input type="datetime-local" name="when" required defaultValue={item.local_time?.replace(" ", "T") ?? ""} className={cn(inputClass, "h-9 w-52 py-0")} aria-label={`New time in ${item.timezone}`} />
      </ActionForm>
      <p className="mt-1 text-[11px] text-ink-3">In {item.timezone}</p>
    </details>
  );
}

function Actions({ item, manage }: { item: QueueItem; manage: boolean }) {
  if (!manage) return null;
  const s = item.status;
  return (
    <div className="flex flex-wrap items-start gap-1">
      {s === "pending" && <ActionButton action={pauseJobAction.bind(null, item.id)} label="Pause" pendingLabel="Pausing…" variant="ghost" icon={<Pause className="size-4" />} align="start" />}
      {s === "paused" && <ActionButton action={resumeJobAction.bind(null, item.id)} label="Resume" pendingLabel="Resuming…" variant="ghost" icon={<Play className="size-4" />} align="start" />}
      {["pending", "paused"].includes(s) && <ActionButton action={skipJobAction.bind(null, item.id)} label="Skip" pendingLabel="Skipping…" variant="ghost" icon={<SkipForward className="size-4" />} align="start" />}
      {s === "needs_check" && <ActionButton action={checkJobAction.bind(null, item.id)} label="Check if it posted" pendingLabel="Checking…" variant="secondary" icon={<Search className="size-4" />} align="start" />}
      {["pending", "paused", "skipped", "dead", "failed"].includes(s) && <ActionButton action={cancelJobAction.bind(null, item.id)} label="Cancel" pendingLabel="Cancelling…" variant="ghost" icon={<X className="size-4" />} align="start" />}
    </div>
  );
}

export default async function QueuePage({ searchParams }: PageProps<"/social/queue">) {
  const sp = await searchParams;
  const view: QueueView = typeof sp.view === "string" && sp.view in VIEWS ? (sp.view as QueueView) : "upcoming";
  const { repo } = await requireWorkspace();
  const manage = can(repo.ctx.role, "post.publish");
  const admin = can(repo.ctx.role, "automation.manage");
  const q = queueService(db(), repo.ctx, { publish: publishService(db(), repo.ctx, publishDeps()) });
  const [items, counts, settings, published, alerts, lastRun, brands] = await Promise.all([q.list(view), q.counts(), q.settings(), q.published(), q.notifications({ unreadOnly: true, limit: 20 }), q.lastWorkerRun(), repo.listBrands({ includeArchived: true })]);
  const brandName = new Map(brands.map((b) => [b.id, b.name]));
  const minutesSinceRun = lastRun ? minutesSince(lastRun.started_at) : null;
  const workerStale = minutesSinceRun === null || minutesSinceRun > STALE_WORKER_MINUTES;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Publishing Queue"
        description="Scheduled posts and what happened to them. Times show in each brand's time zone, with UTC underneath."
        actions={
          admin && (
            <div className="flex flex-wrap items-start gap-2">
              <ActionButton action={runWorkerNowAction} label="Run now" pendingLabel="Running…" icon={<Zap className="size-4" />} />
              <ActionButton action={setPauseAllAction.bind(null, !settings.paused)} label={settings.paused ? "Resume everything" : "Pause everything"} pendingLabel="Saving…" variant={settings.paused ? "primary" : "secondary"} icon={settings.paused ? <Play className="size-4" /> : <Pause className="size-4" />} />
            </div>
          )
        }
      />

      {settings.paused && (
        <div className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning-ink">
          Everything is paused{settings.paused_by ? ` by ${settings.paused_by}` : ""}{settings.paused_at ? ` ${timeAgo(settings.paused_at)}` : ""}. Nothing is published or generated until you resume.
        </div>
      )}
      {workerStale && (
        <div className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning-ink">
          {lastRun ? `The scheduler last ran ${timeAgo(lastRun.started_at)}.` : "The scheduler has never run."} Scheduled posts only go out when it runs every few minutes. Setup steps are in docs/automation.md.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Upcoming" value={counts.upcoming} />
        <Stat label="Needs attention" value={counts.attention} />
        <Stat label="Published today (UTC)" value={`${published.today} / ${settings.daily_post_limit}`} hint="Daily limit" />
        <Stat label="Published this month" value={`${published.month} / ${settings.monthly_post_limit}`} hint={lastRun && !workerStale ? `Scheduler ran ${timeAgo(lastRun.started_at)}` : "Monthly limit"} />
      </div>

      <Card>
        <CardHeader
          icon={Bell}
          title="Alerts"
          description={alerts.length ? `${alerts.length} unread` : "Nothing needs you right now"}
          action={alerts.length > 0 && <ActionButton action={markNotificationsReadAction.bind(null, "all")} label="Mark all read" pendingLabel="Saving…" variant="ghost" icon={<CheckCheck className="size-4" />} />}
        />
        {alerts.length === 0 ? (
          <EmptyState icon={BellOff} title="No alerts">Failed posts, disconnected accounts, limits and drafts waiting for review show up here.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {alerts.map((n) => {
              const Icon = SEVERITY_ICON[n.severity];
              return (
                <li key={n.id} className="flex items-start gap-3 px-5 py-3">
                  <Icon className={cn("mt-0.5 size-4 shrink-0", SEVERITY_TONE[n.severity])} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium">{n.title}</p>
                    {n.body && <p className="text-xs text-ink-2">{n.body}</p>}
                    <p className="mt-0.5 text-[11px] text-ink-3">{n.brand_id ? `${brandName.get(n.brand_id) ?? "Brand"} · ` : ""}{timeAgo(n.created_at)}</p>
                  </div>
                  <ActionButton action={markNotificationsReadAction.bind(null, n.id)} label="Dismiss" pendingLabel="…" variant="ghost" />
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader icon={ListOrdered} title="Queue" description={view === "upcoming" ? "Soonest first" : "Most recently changed first"} />
        <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line px-3">
          {(Object.keys(VIEWS) as QueueView[]).map((v) => (
            <Link key={v} role="tab" aria-selected={v === view} href={v === "upcoming" ? "/social/queue" : `/social/queue?view=${v}`} className={cn("relative flex items-center gap-1.5 whitespace-nowrap px-3 py-3 text-[13px] font-medium", v === view ? "text-brand" : "text-ink-2 hover:text-ink")}>
              {VIEW_LABEL[v]}
              <span className={cn("rounded-full px-1.5 text-[11px] tabular-nums", v === view ? "bg-brand-soft" : "bg-subtle text-ink-3")}>{counts[v]}</span>
              {v === view && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand" />}
            </Link>
          ))}
        </div>
        {items.length === 0 ? (
          <EmptyState icon={ListOrdered} title={view === "upcoming" ? "Nothing scheduled" : view === "attention" ? "Nothing needs attention" : "Nothing here yet"}>
            {view === "upcoming" ? "Schedule an approved post from Content Studio, or switch on automation for a brand." : "Posts move here as the queue works through them."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((item) => {
              const post = item.post_variants?.posts;
              return (
                <li key={item.id} className="grid gap-3 px-5 py-4 md:grid-cols-[11rem_1fr_auto]">
                  <div className="text-[13px]">
                    <p className="font-medium tabular-nums">{item.local_time ?? fmtDateTime(item.run_at, item.timezone)}</p>
                    <p className="text-xs text-ink-3">{item.timezone}</p>
                    <p className="text-xs tabular-nums text-ink-3">{fmtDateTime(item.run_at, "UTC")} UTC</p>
                  </div>
                  <div className="min-w-0 space-y-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{post?.title ?? "Deleted post"}</span>
                      <StatusBadge status={item.status} />
                      <Badge>{SOURCE_LABEL[item.source] ?? item.source}</Badge>
                    </p>
                    <p className="text-xs text-ink-3">
                      {item.brand_id ? brandName.get(item.brand_id) ?? "Brand" : "No brand"} · {platformLabel(item.post_variants?.platform ?? "")}
                      {item.social_accounts && ` · ${item.social_accounts.display_name}`}
                      {item.social_accounts && item.social_accounts.status !== "connected" && <span className="text-warning-ink"> (needs reconnect)</span>}
                      {item.attempts > 0 && ` · attempt ${item.attempts} of ${item.max_attempts}`}
                    </p>
                    {item.post_variants?.body && <p className="line-clamp-2 text-[13px] text-ink-2">{item.post_variants.body}</p>}
                    {item.last_error && item.status !== "succeeded" && <p className={cn("text-xs", ["dead", "failed"].includes(item.status) ? "text-danger-ink" : "text-warning-ink")}>{item.last_error}</p>}
                    <p className="flex flex-wrap gap-3 text-xs">
                      {item.post_variants?.external_url && <a href={item.post_variants.external_url} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">View post</a>}
                      {item.brand_id && item.status !== "succeeded" && <Link href={`/social/content?brand=${item.brand_id}`} className="font-medium text-brand hover:underline">Edit in Content Studio</Link>}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Actions item={item} manage={manage} />
                    {manage && ["pending", "paused", "skipped", "cancelled", "dead", "failed"].includes(item.status) && <Reschedule item={item} />}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
