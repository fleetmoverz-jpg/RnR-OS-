import "server-only";
import { unstable_cache } from "next/cache";
import { db, fetchAll } from "../db";
import { comparisonWindows, type Windows } from "./dates";

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

export type Totals = { clicks: number; impressions: number; ctr: number; position: number | null };

export type SiteInsights = {
  window: Windows;
  /** Earliest day with data; when after window.prevStart the comparison period is incomplete. */
  firstDate: string;
  totals: Totals;
  prevTotals: Totals;
  daily: DailyPoint[];
  prevDaily: DailyPoint[];
  queries: Compared[];
  pages: Compared[];
  countries: Compared[];
  devices: Compared[];
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

async function compare(fn: "gsc_query_compare" | "gsc_page_compare", siteId: string, w: Windows) {
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

async function dimensionCompare(dimension: "country" | "device", siteId: string, w: Windows): Promise<Compared[]> {
  const { data, error } = await db().rpc("gsc_dimension_compare", {
    p_dimension: dimension,
    p_site: siteId,
    cur_start: w.curStart,
    cur_end: w.curEnd,
    prev_start: w.prevStart,
    prev_end: w.prevEnd,
  });
  // Older databases may not have run migration 0002 yet; show the tab as empty instead of failing.
  if (error) return [];
  return (data ?? []) as Compared[];
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

async function firstDataDate(siteId: string) {
  const { data } = await db()
    .from("gsc_site_daily")
    .select("date")
    .eq("site_id", siteId)
    .order("date", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data?.date as string | undefined) ?? null;
}

export async function getSiteInsights(siteId: string, days = 28): Promise<SiteInsights | null> {
  const [latest, first] = await Promise.all([latestDataDate(siteId), firstDataDate(siteId)]);
  if (!latest || !first) return null;
  const w = comparisonWindows(latest, days);

  const [dailyRes, queries, pages, countries, devices, pairs, inspections] = await Promise.all([
    db()
      .from("gsc_site_daily")
      .select("date, clicks, impressions, ctr, position")
      .eq("site_id", siteId)
      .gte("date", w.prevStart)
      .order("date"),
    compare("gsc_query_compare", siteId, w),
    compare("gsc_page_compare", siteId, w),
    dimensionCompare("country", siteId, w),
    dimensionCompare("device", siteId, w),
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
    firstDate: first,
    totals: sumTotals(daily),
    prevTotals: sumTotals(prevDaily),
    daily,
    prevDaily,
    queries,
    pages,
    countries,
    devices,
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

// Daily clicks for a handful of pages, for the trend sparklines in the pages table.
export async function getPageTrends(siteId: string, pages: string[], w: Windows) {
  const trends: Record<string, number[]> = {};
  if (pages.length === 0) return trends;
  const rows = await fetchAll<{ page: string; date: string; clicks: number }>((from, to) =>
    db()
      .from("gsc_page_daily")
      .select("page, date, clicks")
      .eq("site_id", siteId)
      .in("page", pages)
      .gte("date", w.curStart)
      .lte("date", w.curEnd)
      .order("page")
      .order("date")
      .range(from, to),
  );
  const dayIndex = (date: string) =>
    Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${w.curStart}T00:00:00Z`)) / 86_400_000);
  for (const p of pages) trends[p] = new Array(w.days).fill(0);
  for (const r of rows) trends[r.page][dayIndex(r.date)] = r.clicks;
  return trends;
}

export type CachedInsights = SiteInsights & {
  queryCount: number;
  pageCount: number;
  /** Daily clicks for the top 100 pages by clicks. */
  pageTrends: Record<string, number[]>;
};

const QUERY_CAP = 3000;
const PAGE_CAP = 1500;

// Insights for the pages, cached until the site's next sync (the key includes last_synced_at),
// so moving between pages doesn't recompute everything. Long lists are capped to keep the
// cache entry small; the CSV export and AI report use the full, uncached data.
export function getCachedInsights(site: { id: string; last_synced_at: string | null }, days: number) {
  return unstable_cache(
    async (): Promise<CachedInsights | null> => {
      const i = await getSiteInsights(site.id, days);
      if (!i) return null;
      const withImpressions = (list: Compared[]) => list.filter((r) => r.impressions > 0 || r.prev_impressions > 0);
      const queries = withImpressions(i.queries).sort((a, b) => b.impressions - a.impressions);
      const pages = withImpressions(i.pages).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
      const pageTrends = await getPageTrends(
        site.id,
        pages.filter((p) => p.impressions > 0).slice(0, 100).map((p) => p.key),
        i.window,
      );
      return {
        ...i,
        queries: queries.slice(0, QUERY_CAP),
        pages: pages.slice(0, PAGE_CAP),
        queryCount: queries.filter((q) => q.impressions > 0).length,
        pageCount: pages.filter((p) => p.impressions > 0).length,
        pageTrends,
      };
    },
    ["site-insights-v1", site.id, String(days), site.last_synced_at ?? "never"],
    { revalidate: 60 * 60 * 24, tags: [`site:${site.id}`] },
  )();
}
