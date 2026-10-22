import Link from "next/link";
import { ArrowRight, Download, FileText, LineChart, Sparkles, Target, TrendingDown, TriangleAlert } from "lucide-react";
import { getSelection, displaySite } from "@/lib/selection";
import { getCachedInsights } from "@/lib/gsc/insights";
import { latestReport } from "@/lib/ai/recommendations";
import { PerformanceChart } from "@/components/charts/PerformanceChart";
import { DataTable } from "@/components/DataTable";
import { Tabs } from "@/components/Tabs";
import {
  countryName,
  currentOnly,
  deviceName,
  hasFullComparison,
  KpiGrid,
  NoDataState,
  NoSiteState,
  PeriodLine,
  SyncButton,
  toRows,
  topRows,
} from "@/components/analytics";
import { RecommendationCard } from "@/components/recommendations";
import { Badge, buttonClass, Card, CardHeader, PageHeader } from "@/components/ui";
import { fmtNum } from "@/components/format";

export const metadata = { title: "SEO Overview" };
export const maxDuration = 300;

export default async function OverviewPage() {
  const { site, days } = await getSelection();
  if (!site) return <><PageHeader title="SEO Overview" /><div className="mt-6"><NoSiteState /></div></>;

  const [i, report] = await Promise.all([getCachedInsights(site, days), latestReport(site.id)]);
  const header = (
    <PageHeader
      eyebrow={<>Welcome back · <span className="font-medium text-ink">{displaySite(site.site_url)}</span></>}
      title="SEO Overview"
      description={i ? <PeriodLine i={i} /> : undefined}
      actions={
        i && (
          <>
            <a href={`/api/export?type=queries`} className={buttonClass("secondary")}>
              <Download className="size-4" /> Export CSV
            </a>
            <SyncButton site={site} />
          </>
        )
      }
    />
  );
  if (!i) return <>{header}<div className="mt-6"><NoDataState site={site} /></div></>;

  const topPages = topRows(currentOnly(i.pages), 100);
  const trends = i.pageTrends;
  const opportunityCount = i.lowCtr.length + i.strikingDistance.length;
  const riskCount = i.pagesLosingClicks.length + i.decliningQueries.length;
  const technicalCount = i.cannibalization.length + i.indexIssues.length;

  return (
    <div className="space-y-6">
      {header}
      <KpiGrid i={i} />

      <Card>
        <CardHeader icon={LineChart} title="Search performance" description={`Daily results for the last ${days} days`} />
        <PerformanceChart current={i.daily} previous={i.prevDaily} hasPrevious={hasFullComparison(i) || i.prevDaily.length > 0} />
      </Card>

      <div className="grid items-start gap-6 xl:grid-cols-3">
        <Card className="min-w-0 xl:col-span-2">
          <CardHeader title="Search performance breakdown" description="Top results for the selected period. Open the full reports for everything." />
          <Tabs
            tabs={[
              {
                id: "queries",
                label: "Top queries",
                panel: (
                  <>
                    <DataTable rows={toRows(topRows(currentOnly(i.queries), 100))} keyLabel="Query" columns={["clicks", "impressions", "ctr", "position", "clicksChange"]} pageSize={10} searchPlaceholder="Filter queries…" dense />
                    <FooterLink href="/queries">All search queries</FooterLink>
                  </>
                ),
              },
              {
                id: "pages",
                label: "Top pages",
                panel: (
                  <>
                    <DataTable rows={toRows(topPages).map((r) => ({ ...r, label: r.key.replace(/^https?:\/\/[^/]+/, "") || "/", trend: trends[r.key] }))} keyLabel="Page" isUrl columns={["clicks", "impressions", "ctr", "position", "trend"]} pageSize={10} searchPlaceholder="Filter pages…" dense />
                    <FooterLink href="/pages">All pages</FooterLink>
                  </>
                ),
              },
              {
                id: "countries",
                label: "Countries",
                panel: <DataTable rows={toRows(currentOnly(i.countries), countryName)} keyLabel="Country" columns={["clicks", "impressions", "ctr", "position", "clicksChange"]} pageSize={10} emptyText="Country data appears after the next sync." dense />,
              },
              {
                id: "devices",
                label: "Devices",
                panel: <DataTable rows={toRows(currentOnly(i.devices), deviceName)} keyLabel="Device" columns={["clicks", "impressions", "ctr", "position", "clicksChange"]} emptyText="Device data appears after the next sync." dense />,
              },
            ]}
          />
        </Card>

        <div className="min-w-0 space-y-6">
          <Card className="overflow-hidden">
            <div className="border-b border-line bg-gradient-to-br from-brand-soft via-ai-soft to-card px-5 py-4">
              <div className="flex items-center gap-2">
                <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand to-ai text-white shadow-sm">
                  <Sparkles className="size-4" />
                </span>
                <div>
                  <h2 className="text-[15px] font-semibold tracking-tight">AI recommendations</h2>
                  <p className="text-xs text-ink-2">Written by Claude from your Search Console data</p>
                </div>
              </div>
            </div>
            <div className="space-y-3 p-4">
              {report ? (
                <>
                  <p className="text-[13px] leading-relaxed text-ink-2">{report.summary}</p>
                  {report.recommendations.slice(0, 2).map((r, n) => <RecommendationCard key={n} r={r} compact />)}
                </>
              ) : (
                <p className="text-[13px] text-ink-2">No recommendations yet. Generate them from the Opportunities page.</p>
              )}
              <Link href="/opportunities" className={buttonClass("ghost", "w-full justify-between text-brand")}>
                {report ? `See all ${report.recommendations.length} recommendations` : "Go to Opportunities"} <ArrowRight className="size-4" />
              </Link>
            </div>
          </Card>

          <Card>
            <CardHeader title="Opportunities at a glance" />
            <ul className="divide-y divide-line/70">
              <Glance icon={Target} tone="brand" label="Ranking opportunities" detail="Low CTR and page-2 queries" count={opportunityCount} />
              <Glance icon={TrendingDown} tone="danger" label="Losing ground" detail="Declining queries and pages" count={riskCount} />
              <Glance icon={TriangleAlert} tone="warning" label="Technical issues" detail="Cannibalization and indexing" count={technicalCount} />
              <Glance icon={FileText} tone="neutral" label="Pages in search" detail={`In the last ${days} days`} count={i.pageCount} />
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-line px-5 py-3">
      <Link href={href} className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline">
        {children} <ArrowRight className="size-3.5" />
      </Link>
    </div>
  );
}

function Glance({ icon: Icon, tone, label, detail, count }: { icon: typeof Target; tone: "brand" | "danger" | "warning" | "neutral"; label: string; detail: string; count: number }) {
  const tones = { brand: "bg-brand-soft text-brand", danger: "bg-danger-soft text-danger-ink", warning: "bg-warning-soft text-warning-ink", neutral: "bg-subtle text-ink-2" };
  return (
    <li>
      <Link href="/opportunities" className="flex items-center gap-3 px-5 py-3 hover:bg-subtle/60">
        <span className={`flex size-8 items-center justify-center rounded-lg ${tones[tone]}`}>
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">{label}</span>
          <span className="block text-xs text-ink-3">{detail}</span>
        </span>
        <Badge tone={count > 0 && tone !== "neutral" ? tone : "neutral"}>{fmtNum(count)}</Badge>
      </Link>
    </li>
  );
}
