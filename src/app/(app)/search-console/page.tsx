import Link from "next/link";
import { db } from "@/lib/db";
import { getSiteInsights } from "@/lib/gsc/insights";
import type { Site } from "@/lib/gsc/sync";
import { ActionButton } from "@/components/ActionButton";
import { Delta, fmtNum, timeAgo } from "@/components/format";
import { discoverSitesAction, setSiteEnabledAction, syncSiteAction } from "../actions";

export const maxDuration = 300;

export default async function SearchConsolePage() {
  const { data } = await db().from("sites").select("*").order("site_url");
  const sites = (data ?? []) as Site[];
  const summaries = await Promise.all(
    sites.map(async (s) => ({ site: s, insights: s.enabled ? await getSiteInsights(s.id) : null })),
  );

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Search Console</h1>
          <p className="mt-1 text-sm text-ink-2">
            Data syncs automatically every day. Figures are the last 28 days against the 28 before.
          </p>
        </div>
        <ActionButton action={discoverSitesAction} label="Refresh property list" pendingLabel="Loading…" variant="secondary" />
      </div>

      {sites.length === 0 && (
        <p className="mt-8 rounded-xl border border-line bg-surface p-6 text-sm text-ink-2">
          No properties yet. Click “Refresh property list” to load them from Search Console.
        </p>
      )}

      <div className="mt-6 grid gap-3">
        {summaries.map(({ site, insights }) => (
          <div key={site.id} className="rounded-xl border border-line bg-surface p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <Link href={`/search-console/${site.id}`} className="break-all font-medium hover:underline">
                  {site.site_url}
                </Link>
                <p className="mt-0.5 text-xs text-muted">
                  {site.enabled ? `Last synced ${timeAgo(site.last_synced_at)}` : "Paused, not synced daily"}
                </p>
                {site.last_sync_error && <p className="mt-1 text-xs text-bad">Last sync failed: {site.last_sync_error.slice(0, 200)}</p>}
              </div>
              <div className="flex items-start gap-2">
                {site.enabled && (
                  <ActionButton action={syncSiteAction.bind(null, site.id)} label="Sync now" pendingLabel="Syncing…" variant="secondary" />
                )}
                <form action={setSiteEnabledAction.bind(null, site.id, !site.enabled)}>
                  <button className="rounded-lg px-3 py-1.5 text-sm text-ink-2 hover:bg-bg">
                    {site.enabled ? "Pause" : "Resume"}
                  </button>
                </form>
              </div>
            </div>
            {insights && (
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <Stat label="Clicks" value={fmtNum(insights.totals.clicks)} delta={<Delta cur={insights.totals.clicks} prev={insights.prevTotals.clicks} />} />
                <Stat label="Impressions" value={fmtNum(insights.totals.impressions)} delta={<Delta cur={insights.totals.impressions} prev={insights.prevTotals.impressions} />} />
                <Stat label="Declining queries" value={String(insights.decliningQueries.length)} />
                <Stat label="Index issues" value={String(insights.indexIssues.length)} />
              </dl>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, delta }: { label: string; value: string; delta?: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 flex items-baseline gap-2">
        <span className="text-lg font-semibold tabular-nums">{value}</span>
        {delta}
      </dd>
    </div>
  );
}
