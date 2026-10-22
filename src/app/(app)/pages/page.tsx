import { Download, FileText } from "lucide-react";
import { getSelection, displaySite } from "@/lib/selection";
import { getPageTrends, getSiteInsights } from "@/lib/gsc/insights";
import { DataTable } from "@/components/DataTable";
import { Tabs } from "@/components/Tabs";
import { currentOnly, NoDataState, NoSiteState, PeriodLine, toRows, topRows } from "@/components/analytics";
import { buttonClass, Card, CardHeader, PageHeader } from "@/components/ui";
import { fmtNum } from "@/components/format";

export const metadata = { title: "Page Performance" };
export const maxDuration = 300;

const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, "") || "/";

export default async function PagesPage() {
  const { site, days } = await getSelection();
  if (!site) return <><PageHeader title="Page Performance" /><div className="mt-6"><NoSiteState /></div></>;
  const i = await getSiteInsights(site.id, days);
  if (!i) return <><PageHeader title="Page Performance" /><div className="mt-6"><NoDataState site={site} /></div></>;

  const pages = topRows(currentOnly(i.pages), 2000);
  const trends = await getPageTrends(site.id, pages.slice(0, 100).map((p) => p.key), i.window);
  const rows = toRows(pages, path).map((r) => ({ ...r, trend: trends[r.key] }));
  const losing = toRows(i.pagesLosingClicks, path);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={displaySite(site.site_url)}
        title="Page Performance"
        description={<PeriodLine i={i} />}
        actions={<a href="/api/export?type=pages" className={buttonClass("secondary")}><Download className="size-4" /> Export CSV</a>}
      />
      <Card>
        <CardHeader icon={FileText} title={`${fmtNum(currentOnly(i.pages).length)} pages in search`} description="Trend lines show daily clicks for your top 100 pages." />
        <Tabs
          tabs={[
            { id: "all", label: "All pages", count: rows.length, panel: <DataTable rows={rows} keyLabel="Page" isUrl columns={["clicks", "impressions", "ctr", "position", "clicksChange", "trend"]} searchPlaceholder="Filter by URL…" /> },
            { id: "losing", label: "Losing clicks", count: losing.length, panel: <DataTable rows={losing} keyLabel="Page" isUrl columns={["clicks", "clicksChange", "position", "positionChange"]} defaultSort="clicksChange" emptyTitle="No pages losing clicks" emptyText="Pages down at least 20% and 5 clicks show up here." /> },
          ]}
        />
      </Card>
    </div>
  );
}
