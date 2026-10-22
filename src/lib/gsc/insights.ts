import "server-only";
import { db, fetchAll } from "../db";
import { comparisonWindows } from "./dates";

export type Compared = {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
  prev_clicks: number;
  prev_impressions: number;
  prev_ctr: number;
  prev_position: number | null;
};

export type Movement = Compared & { clickDelta: number; positionDelta: number | null };
export type LowCtr = Compared & { expectedCtr: number; missedClicks: number };
export type Cannibal = {
  query: string;
  impressions: number;
  pages: { page: string; clicks: number; impressions: number; position: number; share: number }[];
};
export type IndexIssue = {
  page: string;
  verdict: string | null;
  coverage_state: string | null;
  indexing_state: string | null;
  robots_state: string | null;
  fetch_state: string | null;
  google_canonical: string | null;
  user_canonical: string | null;
  last_crawl_time: string | null;
  inspected_at: string;
};

export type DailyPoint = { date: string; clicks: number; impressions: number; ctr: number; position: number };

export type SiteInsights = {
  window: ReturnType<typeof comparisonWindows>;
  totals: { clicks: number; impressions: number; ctr: number; position: number | null };
  prevTotals: { clicks: number; impressions: number; ctr: number; position: number | null };
  daily: DailyPoint[];
  improvingQueries: Movement[];
  decliningQueries: Movement[];
  pagesLosingClicks: Movement[];
  lowCtr: LowCtr[];
  strikingDistance: Compared[];
  cannibalization: Cannibal[];
  indexIssues: IndexIssue[];
  inspectedCount: number;
};

// Thresholds that keep each list to things worth acting on.
const T = {
  movementMinClicks: 5, // either period
  listSize: 25,
  pageLossMinClicks: 5,
  pageLossMinPct: 0.2,
  lowCtrMinImpressions: 100,
  lowCtrRatio: 0.5, // CTR below half the expected CTR for its position
  strikingMinImpressions: 30,
  cannibalMinImpressions: 50,
  cannibalMinShare: 0.1,
};

// Rough organic CTR by rounded position, used only to flag outliers.
const EXPECTED_CTR = [0, 0.28, 0.15, 0.1, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.018];
export const expectedCtr = (position: number) => EXPECTED_CTR[Math.min(10, Math.max(1, Math.round(position)))];

async function compare(fn: "gsc_query_compare" | "gsc_page_compare", siteId: string, w: ReturnType<typeof comparisonWindows>) {
  const keyField = fn === "gsc_query_compare" ? "query" : "page";
  const rows = await fetchAll<Record<string, unknown>>((from, to) =>
    db()
      .rpc(fn, {
        p_site: siteId,
        cur_start: w.curStart,
        cur_end: w.curEnd,
        prev_start: w.prevStart,
        prev_end: w.prevEnd,
      })
      .range(from, to),
  );
  return rows.map((r) => ({ ...(r as Omit<Compared, "key">), key: r[keyField] as string }));
}

const movement = (r: Compared): Movement => ({
  ...r,
  clickDelta: r.clicks - r.prev_clicks,
  positionDelta: r.position != null && r.prev_position != null ? r.position - r.prev_position : null,
});

function sumTotals(points: DailyPoint[]) {
  const clicks = points.reduce((s, p) => s + p.clicks, 0);
  const impressions = points.reduce((s, p) => s + p.impressions, 0);
  const weighted = points.reduce((s, p) => s + p.position * p.impressions, 0);
  return {
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : 0,
    position: impressions ? weighted / impressions : null,
  };
}

export async function latestDataDate(siteId: string) {
  const { data } = await db()
    .from("gsc_site_daily")
    .select("date")
    .eq("site_id", siteId)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.date as string | undefined) ?? null;
}

export async function getSiteInsights(siteId: string): Promise<SiteInsights | null> {
  const latest = await latestDataDate(siteId);
  if (!latest) return null;
  const w = comparisonWindows(latest);

  const [dailyRes, queries, pages, pairs, inspections] = await Promise.all([
    db()
      .from("gsc_site_daily")
      .select("date, clicks, impressions, ctr, position")
      .eq("site_id", siteId)
      .gte("date", w.prevStart)
      .order("date"),
    compare("gsc_query_compare", siteId, w),
    compare("gsc_page_compare", siteId, w),
    fetchAll<{ query: string; page: string; clicks: number; impressions: number; position: number }>((from, to) =>
      db()
        .from("gsc_query_page_window")
        .select("query, page, clicks, impressions, position")
        .eq("site_id", siteId)
        .order("query")
        .order("page")
        .range(from, to),
    ),
    fetchAll<IndexIssue>((from, to) =>
      db()
        .from("url_inspections")
        .select("page, verdict, coverage_state, indexing_state, robots_state, fetch_state, google_canonical, user_canonical, last_crawl_time, inspected_at")
        .eq("site_id", siteId)
        .order("page")
        .range(from, to),
    ),
  ]);
  if (dailyRes.error) throw new Error(dailyRes.error.message);
  const allDaily = (dailyRes.data ?? []) as DailyPoint[];
  const daily = allDaily.filter((d) => d.date >= w.curStart);
  const prevDaily = allDaily.filter((d) => d.date <= w.prevEnd);

  const moved = queries
    .filter((q) => Math.max(q.clicks, q.prev_clicks) >= T.movementMinClicks)
    .map(movement);
  const improvingQueries = moved
    .filter((q) => q.clickDelta > 0)
    .sort((a, b) => b.clickDelta - a.clickDelta)
    .slice(0, T.listSize);
  const decliningQueries = moved
    .filter((q) => q.clickDelta < 0)
    .sort((a, b) => a.clickDelta - b.clickDelta)
    .slice(0, T.listSize);

  const pagesLosingClicks = pages
    .map(movement)
    .filter(
      (p) =>
        p.prev_clicks >= T.pageLossMinClicks &&
        p.clickDelta < 0 &&
        -p.clickDelta / p.prev_clicks >= T.pageLossMinPct,
    )
    .sort((a, b) => a.clickDelta - b.clickDelta)
    .slice(0, T.listSize);

  const lowCtr = queries
    .filter((q) => q.position != null && q.position <= 10 && q.impressions >= T.lowCtrMinImpressions)
    .map((q) => {
      const exp = expectedCtr(q.position!);
      return { ...q, expectedCtr: exp, missedClicks: Math.round(q.impressions * exp - q.clicks) };
    })
    .filter((q) => q.ctr < q.expectedCtr * T.lowCtrRatio)
    .sort((a, b) => b.missedClicks - a.missedClicks)
    .slice(0, T.listSize);

  const strikingDistance = queries
    .filter((q) => q.position != null && q.position > 10 && q.position <= 20 && q.impressions >= T.strikingMinImpressions)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, T.listSize);

  const byQuery = new Map<string, typeof pairs>();
  for (const p of pairs) {
    const list = byQuery.get(p.query) ?? [];
    list.push(p);
    byQuery.set(p.query, list);
  }
  const cannibalization: Cannibal[] = [];
  for (const [query, list] of byQuery) {
    const impressions = list.reduce((s, p) => s + p.impressions, 0);
    if (impressions < T.cannibalMinImpressions) continue;
    const competing = list
      .map((p) => ({ page: p.page, clicks: p.clicks, impressions: p.impressions, position: p.position, share: p.impressions / impressions }))
      .filter((p) => p.share >= T.cannibalMinShare)
      .sort((a, b) => b.impressions - a.impressions);
    if (competing.length >= 2) cannibalization.push({ query, impressions, pages: competing });
  }
  cannibalization.sort((a, b) => b.impressions - a.impressions);

  const indexIssues = inspections
    .filter((i) => i.verdict && i.verdict !== "PASS")
    .sort((a, b) => (a.verdict === "FAIL" ? -1 : 0) - (b.verdict === "FAIL" ? -1 : 0));

  return {
    window: w,
    totals: sumTotals(daily),
    prevTotals: sumTotals(prevDaily),
    daily,
    improvingQueries,
    decliningQueries,
    pagesLosingClicks,
    lowCtr,
    strikingDistance,
    cannibalization: cannibalization.slice(0, T.listSize),
    indexIssues,
    inspectedCount: inspections.length,
  };
}
