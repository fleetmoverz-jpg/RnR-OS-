import "server-only";
import { db, upsertInBatches } from "../db";
import { env } from "../env";
import { inspectUrl, listSites, searchAnalytics, type GscRow } from "../google/gsc";
import { generateReport } from "../ai/recommendations";
import { addDays, chunks, comparisonWindows, today } from "./dates";

export type Site = {
  id: string;
  site_url: string;
  permission_level: string | null;
  enabled: boolean;
  last_synced_at: string | null;
  last_sync_error: string | null;
};

// Search Console revises the last few days after first reporting them, so re-fetch them.
const REFETCH_DAYS = 5;
const CHUNK_DAYS = 7;

export async function discoverSites() {
  const sites = await listSites();
  if (sites.length === 0) return 0;
  const { error } = await db()
    .from("sites")
    .upsert(
      sites.map((s) => ({ site_url: s.siteUrl, permission_level: s.permissionLevel })),
      { onConflict: "site_url" },
    );
  if (error) throw new Error(error.message);
  return sites.length;
}

const metrics = (r: GscRow) => ({
  clicks: r.clicks,
  impressions: r.impressions,
  ctr: r.ctr,
  position: r.position,
});

async function dateBound(table: string, siteId: string, ascending: boolean): Promise<string | null> {
  const { data } = await db()
    .from(table)
    .select("date")
    .eq("site_id", siteId)
    .order("date", { ascending })
    .limit(1)
    .maybeSingle();
  return data?.date ?? null;
}

const latestDate = (siteId: string) => dateBound("gsc_site_daily", siteId, false);

// Which date ranges a table still needs: the full backfill when empty, otherwise the
// last few days again plus any older gap if the backfill window has grown.
async function rangesToFetch(table: string, siteId: string, end: string) {
  const backfillStart = addDays(end, -(env.backfillDays() - 1));
  const [first, last] = await Promise.all([dateBound(table, siteId, true), dateBound(table, siteId, false)]);
  if (!first || !last) return [{ start: backfillStart, end }];
  const ranges = [{ start: addDays(last, -REFETCH_DAYS), end }];
  if (first > backfillStart) ranges.push({ start: backfillStart, end: addDays(first, -1) });
  return ranges;
}

type Dataset = { table: string; dimension: string; conflict: string };
const DATASETS: Dataset[] = [
  { table: "gsc_query_daily", dimension: "query", conflict: "site_id,date,query" },
  { table: "gsc_page_daily", dimension: "page", conflict: "site_id,date,page" },
  { table: "gsc_country_daily", dimension: "country", conflict: "site_id,date,country" },
  { table: "gsc_device_daily", dimension: "device", conflict: "site_id,date,device" },
];

async function syncDataset(site: Site, ds: Dataset, end: string) {
  for (const range of await rangesToFetch(ds.table, site.id, end)) {
    for (const chunk of chunks(range.start, range.end, CHUNK_DAYS)) {
      const rows = await searchAnalytics(site.site_url, {
        startDate: chunk.start,
        endDate: chunk.end,
        dimensions: ["date", ds.dimension],
      });
      await upsertInBatches(
        ds.table,
        rows.map((r) => ({ site_id: site.id, date: r.keys[0], [ds.dimension]: r.keys[1], ...metrics(r) })),
        ds.conflict,
      );
    }
  }
}

async function syncSearchAnalytics(site: Site) {
  const end = addDays(today(), -1);
  const totalsRanges = await rangesToFetch("gsc_site_daily", site.id, end);
  const start = totalsRanges.reduce((min, r) => (r.start < min ? r.start : min), end);

  let totals = 0;
  for (const range of totalsRanges) {
    const rows = await searchAnalytics(site.site_url, { startDate: range.start, endDate: range.end, dimensions: ["date"] });
    totals += rows.length;
    await upsertInBatches(
      "gsc_site_daily",
      rows.map((r) => ({ site_id: site.id, date: r.keys[0], ...metrics(r) })),
      "site_id,date",
    );
  }

  await Promise.all(
    DATASETS.map((ds) =>
      syncDataset(site, ds, end).catch((e) => {
        // Country and device tables come from migration 0002; skip them until it has been run.
        const missingTable = /could not find the table|does not exist/i.test(String(e));
        if (missingTable && (ds.dimension === "country" || ds.dimension === "device")) return;
        throw e;
      }),
    ),
  );

  // Query x page for the latest 28 days, for cannibalization checks.
  const latest = (await latestDate(site.id)) ?? end;
  const w = comparisonWindows(latest);
  const pairs = await searchAnalytics(
    site.site_url,
    { startDate: w.curStart, endDate: w.curEnd, dimensions: ["query", "page"] },
    100_000,
  );
  await db().from("gsc_query_page_window").delete().eq("site_id", site.id);
  await upsertInBatches(
    "gsc_query_page_window",
    pairs.map((r) => ({
      site_id: site.id,
      query: r.keys[0],
      page: r.keys[1],
      clicks: r.clicks,
      impressions: r.impressions,
      position: r.position,
      window_start: w.curStart,
      window_end: w.curEnd,
    })),
    "site_id,query,page",
  );

  return { start, end, totals };
}

// Inspect the site's most visible pages, oldest inspection first. The API allows 2,000 calls per site per day.
async function syncInspections(site: Site) {
  const latest = await latestDate(site.id);
  if (!latest) return 0;
  const w = comparisonWindows(latest);

  const { data: pageRows, error } = await db().rpc("gsc_page_compare", {
    p_site: site.id,
    cur_start: w.curStart,
    cur_end: w.curEnd,
    prev_start: w.prevStart,
    prev_end: w.prevEnd,
  }).range(0, 4999);
  if (error) throw new Error(error.message);

  const candidates = (pageRows as { page: string; impressions: number; prev_impressions: number }[])
    .sort((a, b) => b.impressions + b.prev_impressions - (a.impressions + a.prev_impressions))
    .slice(0, 500)
    .map((p) => p.page);

  const { data: inspected } = await db()
    .from("url_inspections")
    .select("page, inspected_at")
    .eq("site_id", site.id);
  const lastInspected = new Map((inspected ?? []).map((r) => [r.page, new Date(r.inspected_at).getTime()]));
  const weekAgo = Date.now() - 7 * 86_400_000;

  const due = candidates
    .filter((p) => (lastInspected.get(p) ?? 0) < weekAgo)
    .sort((a, b) => (lastInspected.get(a) ?? 0) - (lastInspected.get(b) ?? 0))
    .slice(0, env.inspectLimit());

  let done = 0;
  for (const page of due) {
    try {
      const s = await inspectUrl(site.site_url, page);
      await db().from("url_inspections").upsert(
        {
          site_id: site.id,
          page,
          verdict: s.verdict ?? null,
          coverage_state: s.coverageState ?? null,
          indexing_state: s.indexingState ?? null,
          robots_state: s.robotsTxtState ?? null,
          fetch_state: s.pageFetchState ?? null,
          google_canonical: s.googleCanonical ?? null,
          user_canonical: s.userCanonical ?? null,
          last_crawl_time: s.lastCrawlTime ?? null,
          raw: s,
          inspected_at: new Date().toISOString(),
        },
        { onConflict: "site_id,page" },
      );
      done++;
    } catch (e) {
      // A quota error stops this round; the rest are picked up next sync.
      if (String(e).includes(" 429 ")) break;
    }
  }
  return done;
}

async function reportIsDue(siteId: string) {
  if (!env.anthropicApiKey()) return false;
  const { data } = await db()
    .from("ai_reports")
    .select("created_at")
    .eq("site_id", siteId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return true;
  return Date.now() - new Date(data.created_at).getTime() > env.aiReportEveryDays() * 86_400_000;
}

export async function syncSite(site: Site, trigger: "cron" | "manual") {
  const { data: run } = await db()
    .from("sync_runs")
    .insert({ site_id: site.id, trigger, status: "running" })
    .select("id")
    .single();

  try {
    const sa = await syncSearchAnalytics(site);
    const inspected = await syncInspections(site);
    let report = "skipped";
    if (await reportIsDue(site.id)) {
      try {
        await generateReport(site);
        report = "generated";
      } catch (e) {
        report = `failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    const detail = `${sa.start}..${sa.end}, ${sa.totals} days, ${inspected} URLs inspected, AI report ${report}`;
    await db().from("sites").update({ last_synced_at: new Date().toISOString(), last_sync_error: null }).eq("id", site.id);
    await db().from("sync_runs").update({ status: "ok", detail, finished_at: new Date().toISOString() }).eq("id", run?.id);
    return { ok: true as const, detail };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db().from("sites").update({ last_sync_error: message.slice(0, 2000) }).eq("id", site.id);
    await db().from("sync_runs").update({ status: "error", detail: message.slice(0, 2000), finished_at: new Date().toISOString() }).eq("id", run?.id);
    return { ok: false as const, detail: message };
  }
}

// Daily cron entry point. Sites synced longest ago go first, and the loop stops
// starting new sites once the time budget is spent; the rest go first tomorrow.
export async function syncAllSites(budgetMs: number) {
  const started = Date.now();
  await discoverSites();
  const { data: sites, error } = await db()
    .from("sites")
    .select("*")
    .eq("enabled", true)
    .order("last_synced_at", { ascending: true, nullsFirst: true });
  if (error) throw new Error(error.message);

  const results: { site: string; ok: boolean; detail: string }[] = [];
  for (const site of (sites ?? []) as Site[]) {
    if (Date.now() - started > budgetMs) {
      results.push({ site: site.site_url, ok: false, detail: "deferred: out of time this run" });
      continue;
    }
    const r = await syncSite(site, "cron");
    results.push({ site: site.site_url, ...r });
  }
  return results;
}
