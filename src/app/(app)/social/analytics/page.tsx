import Link from "next/link";
import { Activity, BarChart3, Bot, Gauge, Send, Share2 } from "lucide-react";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/social/workspace";
import { platformLabel, PLATFORMS } from "@/lib/social/platforms";
import { analyticsService, parseRange } from "@/lib/social/analytics/service";
import { buttonClass, Card, CardHeader, cn, EmptyState, inputClass, PageHeader } from "@/components/ui";
import { Stat } from "@/components/social";
import { fmtNum } from "@/components/format";

export const metadata = { title: "Social Analytics" };

const KIND_LABEL: Record<string, string> = { auth: "Login expired", permission: "Permission refused", rate_limit: "Rate limited", validation: "Content rejected", policy: "Policy block", media: "Image problem", transient: "Temporary error", ambiguous: "Unclear answer", unknown: "Other" };
const METRIC_LABEL: Record<string, string> = { reactions: "Reactions", comments: "Comments", shares: "Shares", likes: "Likes" };
const PURPOSE_LABEL: Record<string, string> = { topics: "Topic ideas", drafts: "Drafts", regenerate: "Rewrites", research: "Research" };
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

function Meter({ label, used, limit, money = false }: { label: string; used: number; limit: number; money?: boolean }) {
  const share = limit > 0 ? Math.min(1, used / limit) : used > 0 ? 1 : 0;
  const fmt = (n: number) => (money ? `$${n.toFixed(2)}` : fmtNum(n));
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="text-ink-2">{label}</span>
        <span className="tabular-nums font-medium">{fmt(used)} <span className="font-normal text-ink-3">of {fmt(limit)}</span></span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-subtle" role="meter" aria-label={label} aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit}>
        <div className={cn("h-full rounded-full", share >= 1 ? "bg-danger" : share >= 0.8 ? "bg-warning" : "bg-brand")} style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

export default async function SocialAnalyticsPage({ searchParams }: PageProps<"/social/analytics">) {
  const sp = await searchParams;
  const range = parseRange(sp);
  const { repo } = await requireWorkspace();
  const brands = await repo.listBrands({ includeArchived: true });
  const brandId = typeof sp.brand === "string" && brands.some((b) => b.id === sp.brand) ? sp.brand : null;
  const platform = typeof sp.platform === "string" && (PLATFORMS as readonly string[]).includes(sp.platform) ? sp.platform : null;
  const d = await analyticsService(db(), repo.ctx).dashboard(range, { brandId, platform });
  const custom = typeof sp.from === "string" && range.label.includes(" to ");
  const lastDay = new Date(range.to.getTime() - 864e5).toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      <PageHeader title="Social Analytics" description={`What was written, approved, queued and published, how publishing went, and what AI cost. ${range.label}, UTC days.`} />

      <Card>
        <form method="get" className="flex flex-wrap items-end gap-3 p-4 text-[13px]">
          <label className="space-y-1">
            <span className="block text-xs text-ink-3">Range</span>
            <select name="range" defaultValue={custom ? "" : String(sp.range ?? "30")} className={cn(inputClass, "h-9 w-36 py-0")}>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="">Custom dates</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-ink-3">From</span>
            <input type="date" name="from" defaultValue={custom ? range.from.toISOString().slice(0, 10) : ""} className={cn(inputClass, "h-9 w-40 py-0")} />
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-ink-3">To</span>
            <input type="date" name="to" defaultValue={custom ? lastDay : ""} className={cn(inputClass, "h-9 w-40 py-0")} />
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-ink-3">Brand</span>
            <select name="brand" defaultValue={brandId ?? ""} className={cn(inputClass, "h-9 w-44 py-0")}>
              <option value="">All brands</option>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-ink-3">Platform</span>
            <select name="platform" defaultValue={platform ?? ""} className={cn(inputClass, "h-9 w-44 py-0")}>
              <option value="">All platforms</option>
              {PLATFORMS.map((p) => <option key={p} value={p}>{platformLabel(p)}</option>)}
            </select>
          </label>
          <button type="submit" className={buttonClass("secondary")}>Apply</button>
          {(brandId || platform || sp.range || sp.from) && <Link href="/social/analytics" className="self-center text-xs font-medium text-brand hover:underline">Reset</Link>}
        </form>
        <p className="border-t border-line px-4 py-2 text-xs text-ink-3">Custom dates are used when both are set; otherwise the range applies.</p>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Drafts awaiting approval" value={fmtNum(d.snapshot.drafts)} hint="Right now" />
        <Stat label="Queued to publish" value={fmtNum(d.snapshot.queuedUpcoming)} hint="Upcoming in the queue" />
        <Stat label="Published" value={fmtNum(d.published.total)} hint="Versions, in range" />
        <Stat label="Publishing success rate" value={d.attempts.successRate === null ? "Unavailable" : pct(d.attempts.successRate)} hint={d.attempts.successRate === null ? "No finished attempts in range" : `${d.attempts.success + d.attempts.reconciled} of ${d.attempts.total - d.attempts.open} attempts`} />
        <Stat label="Needs attention" value={fmtNum(d.snapshot.needsAttention)} hint="Unclear or failed jobs" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader icon={Activity} title="Posts by status" description="Every post in the workspace right now, for the brand and platform chosen." />
          <dl className="grid grid-cols-2 gap-px bg-line text-[13px] sm:grid-cols-3">
            {([["Drafts", d.snapshot.drafts], ["Approved", d.snapshot.approved], ["Scheduled", d.snapshot.scheduled], ["Published", d.snapshot.published], ["Failed", d.snapshot.failed], ["Rejected", d.snapshot.rejected]] as const).map(([k, v]) => (
              <div key={k} className="bg-card px-5 py-3">
                <dt className="text-xs text-ink-3">{k}</dt>
                <dd className="text-lg font-semibold tabular-nums">{fmtNum(v)}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card>
          <CardHeader icon={Send} title="Publishing attempts" description={`${fmtNum(d.attempts.total)} in range${d.attempts.truncated ? " (first 5,000 counted)" : ""}`} />
          {d.attempts.total === 0 ? (
            <EmptyState icon={Send} title="No attempts in this range">Attempts appear when a post is published or the queue runs.</EmptyState>
          ) : (
            <div className="space-y-3 p-5 text-[13px]">
              <p className="tabular-nums text-ink-2">
                {fmtNum(d.attempts.success)} published · {fmtNum(d.attempts.reconciled)} confirmed after checking · {fmtNum(d.attempts.error)} failed · {fmtNum(d.attempts.ambiguous)} unclear{d.attempts.open ? ` · ${fmtNum(d.attempts.open)} in progress` : ""}
              </p>
              {Object.keys(d.attempts.errorsByKind).length > 0 && (
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {Object.entries(d.attempts.errorsByKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => (
                    <li key={k} className="flex justify-between px-3 py-2"><span>{KIND_LABEL[k] ?? k}</span><span className="tabular-nums">{fmtNum(n)}</span></li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader icon={Share2} title="Published by brand and platform" description="Versions the platform confirmed, in range." />
        {d.published.byBrandPlatform.length === 0 ? (
          <EmptyState icon={Share2} title="Nothing published in this range">Change the range or filters, or publish an approved post.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-line text-xs text-ink-3">
                <tr><th className="px-5 py-2.5 font-medium">Brand</th><th className="px-5 py-2.5 font-medium">Platform</th><th className="px-5 py-2.5 text-right font-medium">Published</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.published.byBrandPlatform.map((g) => (
                  <tr key={`${g.brandId}:${g.platform}`}><td className="px-5 py-2.5">{g.brand}</td><td className="px-5 py-2.5">{platformLabel(g.platform)}</td><td className="px-5 py-2.5 text-right tabular-nums">{fmtNum(g.posts)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader icon={BarChart3} title="Platform metrics" description="Only what the platforms report for posts made by RnR Os: Facebook reactions, comments and shares; Instagram likes and comments. Read with Get metrics on each post." />
        {d.metrics.length === 0 ? (
          <EmptyState icon={BarChart3} title="No published posts in this range">Metrics appear for published posts after you read them.</EmptyState>
        ) : (
          <div className="grid gap-px bg-line md:grid-cols-2">
            {d.metrics.map((m) => (
              <div key={m.platform} className="space-y-2 bg-card p-5 text-[13px]">
                <p className="font-medium">{platformLabel(m.platform)} <span className="font-normal text-ink-3">· {fmtNum(m.posts)} posts{m.notFetched ? `, ${fmtNum(m.notFetched)} not read yet` : ""}</span></p>
                {m.values.length === 0 ? (
                  <p className="text-ink-3">Unavailable: no metrics have been read for these posts.</p>
                ) : (
                  <ul className="space-y-1">
                    {m.values.map((v) => (
                      <li key={v.key} className="flex justify-between gap-3">
                        <span>{METRIC_LABEL[v.key] ?? v.key}</span>
                        <span className="tabular-nums">
                          {v.total === null ? <span className="text-ink-3">Unavailable</span> : fmtNum(v.total)}
                          {v.unavailable > 0 && v.total !== null && <span className="text-xs text-ink-3"> ({v.reported} of {v.reported + v.unavailable} posts reported)</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader icon={Bot} title="AI usage and cost" description={`${range.label}${d.ai.brandFiltered ? ", this brand" : ""}. AI calls belong to a brand, so the platform filter doesn't apply.`} />
          {d.ai.calls === 0 ? (
            <EmptyState icon={Bot} title="No AI calls in this range">Topic ideas, research, drafts and rewrites are counted here.</EmptyState>
          ) : (
            <div className="space-y-3 p-5 text-[13px]">
              <div className="grid grid-cols-3 gap-3">
                <div><p className="text-xs text-ink-3">Calls</p><p className="text-lg font-semibold tabular-nums">{fmtNum(d.ai.succeeded)}</p></div>
                <div><p className="text-xs text-ink-3">Tokens in / out</p><p className="text-lg font-semibold tabular-nums">{fmtNum(d.ai.inputTokens)} / {fmtNum(d.ai.outputTokens)}</p></div>
                <div><p className="text-xs text-ink-3">Estimated cost</p><p className="text-lg font-semibold tabular-nums">${d.ai.costUsd.toFixed(2)}</p></div>
              </div>
              {d.ai.unpricedCalls > 0 && <p className="text-xs text-warning-ink">{fmtNum(d.ai.unpricedCalls)} calls have no price set, so the cost above leaves them out. Set the AI_PRICE_* variables to include them.</p>}
              <p className="text-ink-2">{Object.entries(d.ai.byPurpose).map(([k, n]) => `${PURPOSE_LABEL[k] ?? k}: ${fmtNum(n)}`).join(" · ")}</p>
              {(d.ai.failed > 0 || d.ai.blocked > 0) && <p className="text-xs text-ink-3">{fmtNum(d.ai.failed)} failed · {fmtNum(d.ai.blocked)} stopped by a limit</p>}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader icon={Gauge} title="Quotas" description={`This month (${d.quotas.ai.month}, UTC) and today. Change them in Social Settings and Automation.`} />
          <div className="space-y-4 p-5">
            <Meter label="AI generations this month" used={d.quotas.ai.generations} limit={d.quotas.ai.generationLimit} />
            <Meter label="Research calls this month" used={d.quotas.ai.research} limit={d.quotas.ai.researchLimit} />
            <Meter label="AI spending this month" used={d.quotas.ai.costUsd} limit={d.quotas.ai.costLimitUsd} money />
            <Meter label="Posts published today" used={d.quotas.posts.today} limit={d.quotas.posts.dailyLimit} />
            <Meter label="Posts published this month" used={d.quotas.posts.month} limit={d.quotas.posts.monthlyLimit} />
          </div>
        </Card>
      </div>
    </div>
  );
}
