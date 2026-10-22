import { Globe2, LineChart, MonitorSmartphone, Table2 } from "lucide-react";
import { getSelection, displaySite } from "@/lib/selection";
import { getCachedInsights } from "@/lib/gsc/insights";
import { PerformanceChart } from "@/components/charts/PerformanceChart";
import { countryName, deviceName, hasFullComparison, KpiGrid, NoDataState, NoSiteState, PeriodLine, ShareList, SyncButton } from "@/components/analytics";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { Delta, fmtNum, fmtPct, fmtPos, fmtShortDate } from "@/components/format";

export const metadata = { title: "SEO Analytics" };
export const maxDuration = 300;

export default async function AnalyticsPage() {
  const { site, days } = await getSelection();
  if (!site) return <><PageHeader title="SEO Analytics" /><div className="mt-6"><NoSiteState /></div></>;
  const i = await getCachedInsights(site, days);
  if (!i) return <><PageHeader title="SEO Analytics" /><div className="mt-6"><NoDataState site={site} /></div></>;

  const t = i.totals;
  const p = i.prevTotals;
  const hasPrev = p.impressions > 0;
  const comparison = [
    { label: "Clicks", cur: fmtNum(t.clicks), prev: fmtNum(p.clicks), delta: <Delta cur={t.clicks} prev={p.clicks} hasPrev={hasPrev} /> },
    { label: "Impressions", cur: fmtNum(t.impressions), prev: fmtNum(p.impressions), delta: <Delta cur={t.impressions} prev={p.impressions} hasPrev={hasPrev} /> },
    { label: "CTR", cur: fmtPct(t.ctr), prev: fmtPct(p.ctr), delta: <Delta cur={t.ctr} prev={p.ctr} mode="points" hasPrev={hasPrev} /> },
    {
      label: "Avg. position",
      cur: fmtPos(t.position),
      prev: fmtPos(p.position),
      delta: t.position != null && p.position != null ? <Delta cur={t.position} prev={p.position} mode="absolute" digits={1} lowerIsBetter /> : null,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={displaySite(site.site_url)} title="SEO Analytics" description={<PeriodLine i={i} />} actions={<SyncButton site={site} />} />
      <KpiGrid i={i} />
      <Card>
        <CardHeader icon={LineChart} title="Performance over time" description="Switch metrics to compare each one against the previous period." />
        <PerformanceChart current={i.daily} previous={i.prevDaily} hasPrevious={hasFullComparison(i) || i.prevDaily.length > 0} />
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader icon={Globe2} title="Countries" description="Share of clicks, with change versus the previous period" />
          <ShareList rows={i.countries} label={countryName} />
        </Card>
        <Card>
          <CardHeader icon={MonitorSmartphone} title="Devices" description="Share of clicks, with change versus the previous period" />
          <ShareList rows={i.devices} label={deviceName} />
        </Card>
      </div>

      <Card>
        <CardHeader icon={Table2} title="Period comparison" />
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line bg-subtle/50 text-left text-xs text-ink-2">
                <th className="px-5 py-2.5 font-medium">Metric</th>
                <th className="px-4 py-2.5 text-right font-medium">{fmtShortDate(i.window.curStart)} – {fmtShortDate(i.window.curEnd)}</th>
                <th className="px-4 py-2.5 text-right font-medium">{fmtShortDate(i.window.prevStart)} – {fmtShortDate(i.window.prevEnd)}</th>
                <th className="px-5 py-2.5 text-right font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {comparison.map((r) => (
                <tr key={r.label} className="border-b border-line/70 last:border-0">
                  <td className="px-5 py-3 font-medium">{r.label}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.cur}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-2">{hasPrev ? r.prev : "–"}</td>
                  <td className="px-5 py-3 text-right">{r.delta ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-5 py-3 text-xs text-ink-3">
          Last {days} days. Search Console publishes data with a delay of about two days.
        </p>
      </Card>
    </div>
  );
}
