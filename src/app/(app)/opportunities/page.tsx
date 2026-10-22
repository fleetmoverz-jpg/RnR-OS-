import { Copy, FileSearch, MousePointerClick, Sparkles, Target, TrendingDown } from "lucide-react";
import { getSelection, displaySite } from "@/lib/selection";
import { getSiteInsights } from "@/lib/gsc/insights";
import { latestReport } from "@/lib/ai/recommendations";
import { env } from "@/lib/env";
import { DataTable } from "@/components/DataTable";
import { NoDataState, NoSiteState, PeriodLine, toRows } from "@/components/analytics";
import { RecommendationCard } from "@/components/recommendations";
import { ActionButton } from "@/components/ActionButton";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { fmtNum, fmtPct, fmtPos, timeAgo } from "@/components/format";
import { generateReportAction } from "../actions";

export const metadata = { title: "Opportunities & Recommendations" };
export const maxDuration = 300;

const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, "") || "/";

export default async function OpportunitiesPage() {
  const { site, days } = await getSelection();
  if (!site) return <><PageHeader title="Opportunities" /><div className="mt-6"><NoSiteState /></div></>;
  const [i, report] = await Promise.all([getSiteInsights(site.id, days), latestReport(site.id)]);
  if (!i) return <><PageHeader title="Opportunities" /><div className="mt-6"><NoDataState site={site} /></div></>;

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={displaySite(site.site_url)} title="Opportunities & Recommendations" description={<PeriodLine i={i} />} />

      {/* AI recommendations */}
      <section className="overflow-hidden rounded-xl border border-ai/20 bg-card shadow-card">
        <div className="flex flex-col gap-4 bg-gradient-to-br from-brand-soft via-ai-soft to-card px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand to-ai text-white shadow-sm">
              <Sparkles className="size-5" />
            </span>
            <div>
              <h2 className="text-base font-semibold tracking-tight">AI recommendations</h2>
              <p className="mt-0.5 max-w-xl text-[13px] text-ink-2">
                {report
                  ? `Generated ${timeAgo(report.created_at)} from the last 28 days. Refreshed automatically every week.`
                  : "Claude reads your Search Console data and writes a short plan in plain English."}
              </p>
            </div>
          </div>
          {env.anthropicApiKey() ? (
            <ActionButton action={generateReportAction.bind(null, site.id)} label={report ? "Regenerate" : "Generate recommendations"} pendingLabel="Analysing… up to a minute" icon={<Sparkles className="size-4" />} variant="ai" />
          ) : (
            <Badge tone="warning">Add ANTHROPIC_API_KEY to enable</Badge>
          )}
        </div>
        {report ? (
          <div className="p-5">
            <p className="max-w-3xl text-[14px] leading-relaxed">{report.summary}</p>
            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              {report.recommendations.map((r, n) => <RecommendationCard key={n} r={r} />)}
            </div>
          </div>
        ) : (
          <EmptyState icon={Sparkles} title="No recommendations yet">Generate them to get a prioritised to-do list for this site.</EmptyState>
        )}
      </section>

      <h2 className="pt-2 text-[13px] font-semibold uppercase tracking-wide text-ink-3">Ranking opportunities</h2>
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader icon={MousePointerClick} title="High impressions, low CTR" description="Top-10 rankings earning under half the usual clicks. Rewrite the title and meta description." action={<Badge tone="brand">{i.lowCtr.length}</Badge>} />
          <SimpleTable
            head={["Query", "Impr.", "CTR", "Expected", "Pos.", "Missed"]}
            rows={i.lowCtr.map((q) => [q.key, fmtNum(q.impressions), fmtPct(q.ctr), fmtPct(q.expectedCtr), fmtPos(q.position), `~${fmtNum(q.missedClicks)}`])}
            empty="No low-CTR queries in this period."
          />
        </Card>
        <Card>
          <CardHeader icon={Target} title="Page 2 striking distance" description="Ranking 11–20. Improve the content and internal links to reach page one." action={<Badge tone="brand">{i.strikingDistance.length}</Badge>} />
          <DataTable rows={toRows(i.strikingDistance)} keyLabel="Query" columns={["impressions", "clicks", "position"]} defaultSort="impressions" pageSize={10} emptyTitle="No page-2 queries" dense />
        </Card>
      </div>

      <h2 className="pt-2 text-[13px] font-semibold uppercase tracking-wide text-ink-3">Losing ground</h2>
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader icon={TrendingDown} title="Pages losing clicks" description="Down at least 20% and 5 clicks versus the previous period." action={<Badge tone="danger">{i.pagesLosingClicks.length}</Badge>} />
          <DataTable rows={toRows(i.pagesLosingClicks, path)} keyLabel="Page" isUrl columns={["clicks", "clicksChange", "positionChange"]} defaultSort="clicksChange" pageSize={10} emptyTitle="No pages losing clicks" dense />
        </Card>
        <Card>
          <CardHeader icon={TrendingDown} title="Declining queries" description="Queries that lost the most clicks." action={<Badge tone="danger">{i.decliningQueries.length}</Badge>} />
          <DataTable rows={toRows(i.decliningQueries)} keyLabel="Query" columns={["clicks", "clicksChange", "positionChange"]} defaultSort="clicksChange" pageSize={10} emptyTitle="No declining queries" dense />
        </Card>
      </div>

      <h2 className="pt-2 text-[13px] font-semibold uppercase tracking-wide text-ink-3">Technical</h2>
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader icon={Copy} title="Cannibalization" description="Two or more of your pages each take 10%+ of a query's impressions (last 28 days)." action={<Badge tone="warning">{i.cannibalization.length}</Badge>} />
          {i.cannibalization.length === 0 ? (
            <EmptyState icon={Copy} title="No cannibalization found" />
          ) : (
            <ul className="divide-y divide-line/70">
              {i.cannibalization.slice(0, 8).map((c) => (
                <li key={c.query} className="px-5 py-3.5">
                  <p className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">{c.query}</span>
                    <span className="shrink-0 text-xs text-ink-3 tabular-nums">{fmtNum(c.impressions)} impr.</span>
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {c.pages.map((p) => (
                      <li key={p.page} className="flex items-center gap-3 text-xs">
                        <span className="min-w-0 flex-1 truncate text-ink-2" title={p.page}>{path(p.page)}</span>
                        <span className="relative h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-subtle">
                          <span className="absolute inset-y-0 left-0 rounded-full bg-warning" style={{ width: `${p.share * 100}%` }} />
                        </span>
                        <span className="w-28 shrink-0 whitespace-nowrap text-right tabular-nums text-ink-3">{fmtPct(p.share)} · pos {fmtPos(p.position)}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader
            icon={FileSearch}
            title="Indexing issues"
            description={`From Google's URL Inspection. ${fmtNum(i.inspectedCount)} of your top pages checked so far, more each day.`}
            action={<Badge tone={i.indexIssues.length ? "danger" : "success"}>{i.indexIssues.length}</Badge>}
          />
          <SimpleTable
            head={["Page", "Verdict", "Coverage", "Last crawl"]}
            rows={i.indexIssues.map((x) => [path(x.page), x.verdict ?? "–", x.coverage_state ?? "–", x.last_crawl_time ? x.last_crawl_time.slice(0, 10) : "never"])}
            empty={i.inspectedCount ? "Every inspected page is indexed." : "Pages are inspected during the daily sync."}
          />
        </Card>
      </div>
      <p className="text-xs text-ink-3">Lists use the {days}-day range from the top bar, except cannibalization, which always uses the last 28 days.</p>
    </div>
  );
}

function SimpleTable({ head, rows, empty }: { head: string[]; rows: string[][]; empty: string }) {
  if (rows.length === 0) return <EmptyState icon={FileSearch} title={empty} />;
  return (
    <div className="max-h-[26rem] overflow-auto">
      <table className="w-full text-[13px]">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b border-line text-left text-xs text-ink-2">
            {head.map((h, n) => (
              <th key={h} className={`px-4 py-2.5 font-medium first:pl-5 last:pr-5 ${n ? "text-right" : ""}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-line/70 last:border-0 hover:bg-brand-soft/40">
              {r.map((c, ci) => (
                <td key={ci} className={`px-4 py-2.5 align-top first:pl-5 last:pr-5 ${ci ? "text-right tabular-nums" : "max-w-[13rem] truncate"}`} title={ci ? undefined : c}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
