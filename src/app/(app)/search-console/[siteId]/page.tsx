import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getSiteInsights, type Compared, type Movement } from "@/lib/gsc/insights";
import { latestReport, type Recommendation } from "@/lib/ai/recommendations";
import type { Site } from "@/lib/gsc/sync";
import { ActionButton } from "@/components/ActionButton";
import { TrendChart } from "@/components/TrendChart";
import { Delta, fmtNum, fmtPct, fmtPos, timeAgo } from "@/components/format";
import { generateReportAction, syncSiteAction } from "../../actions";

export const maxDuration = 300;

const SECTIONS = [
  ["recommendations", "Recommendations"],
  ["declining", "Declining queries"],
  ["improving", "Improving queries"],
  ["pages", "Pages losing clicks"],
  ["ctr", "Low CTR"],
  ["striking", "Page 2"],
  ["cannibalization", "Cannibalization"],
  ["indexing", "Indexing"],
] as const;

export default async function SitePage({ params }: PageProps<"/search-console/[siteId]">) {
  const { siteId } = await params;
  const { data: site } = await db().from("sites").select("*").eq("id", siteId).maybeSingle();
  if (!site) notFound();
  const s = site as Site;
  const [insights, report] = await Promise.all([getSiteInsights(s.id), latestReport(s.id)]);

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/search-console" className="text-sm text-ink-2 hover:underline">← All properties</Link>
      <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="break-all text-2xl font-semibold">{s.site_url}</h1>
          <p className="mt-1 text-sm text-ink-2">
            {insights
              ? `${insights.window.curStart} to ${insights.window.curEnd}, compared with the 28 days before. Last synced ${timeAgo(s.last_synced_at)}.`
              : "No data yet. Run the first sync to pull Search Console data."}
          </p>
          {s.last_sync_error && <p className="mt-1 text-sm text-bad">Last sync failed: {s.last_sync_error.slice(0, 300)}</p>}
        </div>
        <ActionButton action={syncSiteAction.bind(null, s.id)} label="Sync now" pendingLabel="Syncing… (can take a few minutes)" />
      </div>

      {insights && (
        <>
          <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Clicks" value={fmtNum(insights.totals.clicks)} delta={<Delta cur={insights.totals.clicks} prev={insights.prevTotals.clicks} />} />
            <Tile label="Impressions" value={fmtNum(insights.totals.impressions)} delta={<Delta cur={insights.totals.impressions} prev={insights.prevTotals.impressions} />} />
            <Tile label="CTR" value={fmtPct(insights.totals.ctr)} delta={<Delta cur={insights.totals.ctr} prev={insights.prevTotals.ctr} />} />
            <Tile
              label="Avg position"
              value={fmtPos(insights.totals.position)}
              delta={insights.totals.position != null && insights.prevTotals.position != null ? <Delta cur={insights.totals.position} prev={insights.prevTotals.position} invert pct={false} /> : undefined}
            />
          </dl>

          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <TrendChart title="Clicks per day" color="var(--series-1)" points={insights.daily.map((d) => ({ date: d.date, value: d.clicks }))} />
            <TrendChart title="Impressions per day" color="var(--series-2)" points={insights.daily.map((d) => ({ date: d.date, value: d.impressions }))} />
          </div>

          <nav className="sticky top-0 z-10 -mx-4 mt-6 flex gap-1 overflow-x-auto border-b border-line bg-bg/95 px-4 py-2 backdrop-blur md:mx-0 md:px-0">
            {SECTIONS.map(([id, label]) => (
              <a key={id} href={`#${id}`} className="whitespace-nowrap rounded-md px-2.5 py-1 text-sm text-ink-2 hover:bg-surface hover:text-ink">
                {label}
              </a>
            ))}
          </nav>

          <Section id="recommendations" title="Recommendations" hint="Written by Claude from the data below. Refreshed automatically every week.">
            <div className="mb-3">
              <ActionButton action={generateReportAction.bind(null, s.id)} label={report ? "Regenerate" : "Generate recommendations"} pendingLabel="Thinking… (up to a minute)" variant="secondary" />
            </div>
            {report ? (
              <div>
                <p className="text-sm leading-relaxed">{report.summary}</p>
                <p className="mt-1 text-xs text-muted">Generated {timeAgo(report.created_at)}</p>
                <div className="mt-4 grid gap-3">
                  {report.recommendations.map((r, i) => <RecommendationCard key={i} r={r} />)}
                </div>
              </div>
            ) : (
              <Empty>No recommendations yet.</Empty>
            )}
          </Section>

          <Section id="declining" title="Declining queries" hint="Queries that lost the most clicks.">
            <MovementTable rows={insights.decliningQueries} keyLabel="Query" />
          </Section>
          <Section id="improving" title="Improving queries" hint="Queries that gained the most clicks.">
            <MovementTable rows={insights.improvingQueries} keyLabel="Query" />
          </Section>
          <Section id="pages" title="Pages losing clicks" hint="Pages down at least 20% and 5 clicks.">
            <MovementTable rows={insights.pagesLosingClicks} keyLabel="Page" />
          </Section>
          <Section id="ctr" title="High impressions, low CTR" hint="Top-10 queries getting under half the clicks their position usually earns. Better titles and meta descriptions often fix these.">
            <Table
              head={["Query", "Impr.", "CTR", "Expected", "Pos.", "Missed clicks"]}
              rows={insights.lowCtr.map((q) => [q.key, fmtNum(q.impressions), fmtPct(q.ctr), fmtPct(q.expectedCtr), fmtPos(q.position), fmtNum(q.missedClicks)])}
            />
          </Section>
          <Section id="striking" title="Page 2 striking distance" hint="Queries ranking 11–20. A push to page 1 is often the cheapest traffic win.">
            <ComparedTable rows={insights.strikingDistance} />
          </Section>
          <Section id="cannibalization" title="Cannibalization" hint="Queries where two or more of your pages each take at least 10% of impressions.">
            {insights.cannibalization.length === 0 ? (
              <Empty>No cannibalization found.</Empty>
            ) : (
              <div className="grid gap-3">
                {insights.cannibalization.map((c) => (
                  <div key={c.query} className="rounded-lg border border-line p-3">
                    <p className="font-medium">{c.query} <span className="text-xs font-normal text-muted">{fmtNum(c.impressions)} impressions</span></p>
                    <ul className="mt-2 grid gap-1 text-sm">
                      {c.pages.map((p) => (
                        <li key={p.page} className="flex flex-wrap justify-between gap-x-4">
                          <span className="break-all text-ink-2">{p.page}</span>
                          <span className="tabular-nums text-muted">{fmtPct(p.share)} · pos {fmtPos(p.position)} · {fmtNum(p.clicks)} clicks</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </Section>
          <Section id="indexing" title="Indexing issues" hint={`From the URL Inspection API. ${insights.inspectedCount} of your top pages inspected so far; more are checked each day.`}>
            <Table
              head={["Page", "Verdict", "Coverage", "Robots", "Last crawl"]}
              rows={insights.indexIssues.map((i) => [i.page, i.verdict ?? "–", i.coverage_state ?? "–", i.robots_state ?? "–", i.last_crawl_time ? i.last_crawl_time.slice(0, 10) : "never"])}
              empty="All inspected pages are indexed."
            />
          </Section>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, delta }: { label: string; value: string; delta?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
      <dd className="mt-0.5">{delta}</dd>
    </div>
  );
}

function Section({ id, title, hint, children }: { id: string; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-8 scroll-mt-14">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mb-3 text-sm text-ink-2">{hint}</p>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed border-line p-4 text-sm text-muted">{children}</p>;
}

function Table({ head, rows, empty = "Nothing here right now." }: { head: string[]; rows: (string | React.ReactNode)[][]; empty?: string }) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            {head.map((h, i) => (
              <th key={h} className={`px-3 py-2 font-medium ${i ? "text-right" : ""}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-line last:border-0">
              {r.map((c, ci) => (
                <td key={ci} className={`px-3 py-2 ${ci ? "whitespace-nowrap text-right tabular-nums" : "max-w-md break-all"}`}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MovementTable({ rows, keyLabel }: { rows: Movement[]; keyLabel: string }) {
  return (
    <Table
      head={[keyLabel, "Clicks", "Before", "Change", "Pos.", "Pos. before"]}
      rows={rows.map((r) => [
        r.key,
        fmtNum(r.clicks),
        fmtNum(r.prev_clicks),
        <Delta key="d" cur={r.clicks} prev={r.prev_clicks} pct={false} />,
        fmtPos(r.position),
        fmtPos(r.prev_position),
      ])}
    />
  );
}

function ComparedTable({ rows }: { rows: Compared[] }) {
  return (
    <Table
      head={["Query", "Impr.", "Clicks", "CTR", "Pos."]}
      rows={rows.map((r) => [r.key, fmtNum(r.impressions), fmtNum(r.clicks), fmtPct(r.ctr), fmtPos(r.position)])}
    />
  );
}

const PRIORITY: Record<Recommendation["priority"], string> = {
  high: "bg-bad/10 text-bad",
  medium: "bg-warn/10 text-warn",
  low: "bg-bg text-ink-2",
};

function RecommendationCard({ r }: { r: Recommendation }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${PRIORITY[r.priority]}`}>{r.priority} priority</span>
        <span className="text-xs text-muted">{r.category}</span>
      </div>
      <h3 className="mt-2 font-medium">{r.title}</h3>
      <p className="mt-1 text-sm text-ink-2">{r.why}</p>
      <ul className="mt-2 list-disc pl-5 text-sm">
        {r.actions.map((a, i) => <li key={i}>{a}</li>)}
      </ul>
      {r.targets.length > 0 && (
        <p className="mt-2 break-all text-xs text-muted">Applies to: {r.targets.join(" · ")}</p>
      )}
    </div>
  );
}
