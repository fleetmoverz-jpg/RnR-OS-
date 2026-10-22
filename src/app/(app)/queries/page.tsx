import { Download, Search, TrendingDown, TrendingUp } from "lucide-react";
import { getSelection, displaySite } from "@/lib/selection";
import { getCachedInsights } from "@/lib/gsc/insights";
import { DataTable } from "@/components/DataTable";
import { Tabs } from "@/components/Tabs";
import { currentOnly, NoDataState, NoSiteState, PeriodLine, toRows } from "@/components/analytics";
import { buttonClass, Card, CardHeader, PageHeader } from "@/components/ui";
import { fmtNum } from "@/components/format";

export const metadata = { title: "Search Queries" };
export const maxDuration = 300;
const LIMIT = 5000;

export default async function QueriesPage() {
  const { site, days } = await getSelection();
  if (!site) return <><PageHeader title="Search Queries" /><div className="mt-6"><NoSiteState /></div></>;
  const i = await getCachedInsights(site, days);
  if (!i) return <><PageHeader title="Search Queries" /><div className="mt-6"><NoDataState site={site} /></div></>;

  const all = currentOnly(i.queries).sort((a, b) => b.impressions - a.impressions);
  const shown = all.slice(0, LIMIT);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={displaySite(site.site_url)}
        title="Search Queries"
        description={<PeriodLine i={i} />}
        actions={<a href="/api/export?type=queries" className={buttonClass("secondary")}><Download className="size-4" /> Export CSV</a>}
      />
      <Card>
        <CardHeader
          icon={Search}
          title={`${fmtNum(i.queryCount)} queries with impressions`}
          description={i.queryCount > all.length || all.length > LIMIT ? `Showing the top ${fmtNum(shown.length)} by impressions. The CSV export has all of them.` : "Every query your site appeared for in this period."}
        />
        <Tabs
          tabs={[
            { id: "all", label: "All queries", count: shown.length, panel: <DataTable rows={toRows(shown)} keyLabel="Query" columns={["clicks", "impressions", "ctr", "position", "clicksChange", "positionChange"]} searchPlaceholder="Filter queries…" /> },
            { id: "up", label: "Improving", count: i.improvingQueries.length, panel: <DataTable rows={toRows(i.improvingQueries)} keyLabel="Query" columns={["clicks", "clicksChange", "position", "positionChange"]} defaultSort="clicksChange" emptyTitle="No improving queries" emptyText="Queries that gained at least a few clicks show up here." /> },
            { id: "down", label: "Declining", count: i.decliningQueries.length, panel: <DataTable rows={toRows(i.decliningQueries)} keyLabel="Query" columns={["clicks", "clicksChange", "position", "positionChange"]} defaultSort="clicksChange" emptyTitle="No declining queries" emptyText="Nice. No query lost a meaningful number of clicks." /> },
          ]}
        />
      </Card>
      <p className="flex items-center gap-4 text-xs text-ink-3">
        <span className="flex items-center gap-1"><TrendingUp className="size-3.5" /> Improving and declining lists need at least 5 clicks in either period.</span>
        <span className="hidden items-center gap-1 sm:flex"><TrendingDown className="size-3.5" /> Position Δ: a drop in the number means a better ranking.</span>
      </p>
    </div>
  );
}
