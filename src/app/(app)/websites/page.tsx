import { Globe, Pause, Play, RefreshCw } from "lucide-react";
import { db } from "@/lib/db";
import { getCachedInsights } from "@/lib/gsc/insights";
import type { Site } from "@/lib/gsc/sync";
import { displaySite } from "@/lib/selection";
import { ActionButton } from "@/components/ActionButton";
import { Badge, buttonClass, Card, PageHeader } from "@/components/ui";
import { Delta, fmtNum, timeAgo } from "@/components/format";
import { NoSiteState } from "@/components/analytics";
import { discoverSitesAction, setSiteEnabledAction, syncSiteAction } from "../actions";

export const metadata = { title: "Websites" };
export const maxDuration = 300;

export default async function WebsitesPage() {
  const { data } = await db().from("sites").select("*").order("site_url");
  const sites = (data ?? []) as Site[];
  const rows = await Promise.all(sites.map(async (s) => ({ site: s, i: s.enabled ? await getCachedInsights(s, 28) : null })));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Websites"
        description="Your Google Search Console properties. Active websites sync every day at 06:00 UTC."
        actions={<ActionButton action={discoverSitesAction} label="Refresh list from Google" pendingLabel="Loading…" icon={<RefreshCw className="size-4" />} />}
      />
      {sites.length === 0 ? (
        <NoSiteState />
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {rows.map(({ site, i }) => (
              <li key={site.id} className="flex flex-col gap-4 px-5 py-4 lg:flex-row lg:items-center">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                    <Globe className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{displaySite(site.site_url)}</span>
                      {site.enabled ? <Badge tone="success">Active</Badge> : <Badge>Paused</Badge>}
                      {site.site_url.startsWith("sc-domain:") && <Badge>Domain property</Badge>}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-3">
                      Last synced {timeAgo(site.last_synced_at)}
                      {site.permission_level && ` · ${site.permission_level.replace("site", "").toLowerCase()}`}
                    </p>
                    {site.last_sync_error && <p className="mt-1 text-xs text-danger-ink">Last sync failed: {site.last_sync_error.slice(0, 200)}</p>}
                  </div>
                </div>
                {i && (
                  <dl className="grid grid-cols-2 gap-6 text-[13px] sm:w-72">
                    <div>
                      <dt className="text-xs text-ink-3">Clicks · 28d</dt>
                      <dd className="mt-0.5 flex items-center gap-2 font-semibold tabular-nums">{fmtNum(i.totals.clicks)} <Delta cur={i.totals.clicks} prev={i.prevTotals.clicks} hasPrev={i.prevTotals.impressions > 0} /></dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-3">Impressions · 28d</dt>
                      <dd className="mt-0.5 flex items-center gap-2 font-semibold tabular-nums">{fmtNum(i.totals.impressions)} <Delta cur={i.totals.impressions} prev={i.prevTotals.impressions} hasPrev={i.prevTotals.impressions > 0} /></dd>
                    </div>
                  </dl>
                )}
                <div className="flex items-start gap-2">
                  {site.enabled && <ActionButton action={syncSiteAction.bind(null, site.id)} label="Sync now" pendingLabel="Syncing…" icon={<RefreshCw className="size-4" />} />}
                  <form action={setSiteEnabledAction.bind(null, site.id, !site.enabled)}>
                    <button className={buttonClass("ghost")}>
                      {site.enabled ? <><Pause className="size-4" /> Pause</> : <><Play className="size-4" /> Resume</>}
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
