import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "../db";
import { env } from "../env";
import { getSiteInsights, type SiteInsights } from "../gsc/insights";

export type Recommendation = {
  title: string;
  priority: "high" | "medium" | "low";
  category: "content" | "ctr" | "rankings" | "cannibalization" | "indexing" | "technical";
  why: string;
  actions: string[];
  targets: string[];
};

export type AiReport = {
  id: string;
  site_id: string;
  model: string;
  summary: string;
  recommendations: Recommendation[];
  created_at: string;
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "recommendations"],
  properties: {
    summary: { type: "string" },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "priority", "category", "why", "actions", "targets"],
        properties: {
          title: { type: "string" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          category: { type: "string", enum: ["content", "ctr", "rankings", "cannibalization", "indexing", "technical"] },
          why: { type: "string" },
          actions: { type: "array", items: { type: "string" } },
          targets: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const SYSTEM = `You are an SEO analyst reviewing one website's Google Search Console data for its owner, who runs local service businesses.
Write in plain English a busy owner can act on. No jargon without a short explanation.
Base every point on the numbers given; do not invent data. Quote the specific queries or URLs each recommendation is about in "targets".
"summary" is 2-4 sentences on how the site is doing over the last 28 days versus the 28 before.
Give 3-8 recommendations, most valuable first. Each has concrete "actions" (things to change on a page, content to write, technical fixes).`;

// Keep the prompt compact: the top rows of each insight are enough to reason about.
function digest(site: string, i: SiteInsights) {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const pos = (n: number | null) => (n == null ? "-" : n.toFixed(1));
  const top = <T,>(rows: T[], n = 12) => rows.slice(0, n);
  return {
    site,
    window: i.window,
    totals: { ...i.totals, ctr: pct(i.totals.ctr), position: pos(i.totals.position) },
    previousTotals: { ...i.prevTotals, ctr: pct(i.prevTotals.ctr), position: pos(i.prevTotals.position) },
    improvingQueries: top(i.improvingQueries).map((q) => ({ query: q.key, clicks: `${q.prev_clicks} -> ${q.clicks}`, position: `${pos(q.prev_position)} -> ${pos(q.position)}` })),
    decliningQueries: top(i.decliningQueries).map((q) => ({ query: q.key, clicks: `${q.prev_clicks} -> ${q.clicks}`, position: `${pos(q.prev_position)} -> ${pos(q.position)}` })),
    pagesLosingClicks: top(i.pagesLosingClicks).map((p) => ({ page: p.key, clicks: `${p.prev_clicks} -> ${p.clicks}`, position: `${pos(p.prev_position)} -> ${pos(p.position)}` })),
    highImpressionsLowCtr: top(i.lowCtr).map((q) => ({ query: q.key, impressions: q.impressions, ctr: pct(q.ctr), expectedCtr: pct(q.expectedCtr), position: pos(q.position) })),
    page2StrikingDistance: top(i.strikingDistance).map((q) => ({ query: q.key, impressions: q.impressions, clicks: q.clicks, position: pos(q.position) })),
    cannibalization: top(i.cannibalization, 8).map((c) => ({ query: c.query, impressions: c.impressions, pages: c.pages.map((p) => `${p.page} (${pct(p.share)} of impressions, pos ${pos(p.position)})`) })),
    indexingIssues: top(i.indexIssues, 15).map((x) => ({ page: x.page, verdict: x.verdict, coverage: x.coverage_state, robots: x.robots_state, fetch: x.fetch_state, googleCanonical: x.google_canonical })),
    urlsInspected: i.inspectedCount,
  };
}

export async function generateReport(site: { id: string; site_url: string }): Promise<AiReport> {
  const apiKey = env.anthropicApiKey();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const insights = await getSiteInsights(site.id);
  if (!insights) throw new Error("No Search Console data yet. Sync the site first.");

  const client = new Anthropic({ apiKey });
  const model = env.anthropicModel();
  const response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(digest(site.site_url, insights)) }],
  });

  if (response.stop_reason === "refusal") throw new Error("Claude declined to write this report");
  if (response.stop_reason === "max_tokens") throw new Error("Claude ran out of output tokens");
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const parsed = JSON.parse(text) as { summary: string; recommendations: Recommendation[] };

  const { data, error } = await db()
    .from("ai_reports")
    .insert({ site_id: site.id, model: response.model, summary: parsed.summary, recommendations: parsed.recommendations })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as AiReport;
}

export async function latestReport(siteId: string): Promise<AiReport | null> {
  const { data } = await db()
    .from("ai_reports")
    .select("*")
    .eq("site_id", siteId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as AiReport | null) ?? null;
}
