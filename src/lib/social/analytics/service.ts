// Social analytics for one workspace: what was made, approved, queued and published, how publishing
// went, what the platforms report, and what AI cost. A value the platform didn't report is null
// ("unavailable"), never zero.
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertCan } from "../policy";
import type { SocialContext } from "../repo";
import { DEFAULT_SETTINGS } from "../automation/queue";
import { utcDayStart, utcMonthStart } from "../automation/time";

export type Range = { from: Date; to: Date; label: string };
export type Filters = { brandId?: string | null; platform?: string | null };

const DAY = 864e5;
const ROW_CAP = 5000;

// ?range=7|30|90 or ?from=YYYY-MM-DD&to=YYYY-MM-DD (UTC days, inclusive), at most a year.
export function parseRange(sp: { range?: unknown; from?: unknown; to?: unknown }, now = new Date()): Range {
  const today = new Date(utcDayStart(now));
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? new Date(`${v}T00:00:00Z`) : null);
  const from = day(sp.from);
  const to = day(sp.to);
  if (from && to && from <= to && to.getTime() - from.getTime() <= 366 * DAY) {
    return { from, to: new Date(to.getTime() + DAY), label: `${sp.from} to ${sp.to}` };
  }
  const n = [7, 30, 90].includes(Number(sp.range)) ? Number(sp.range) : 30;
  return { from: new Date(today.getTime() - (n - 1) * DAY), to: new Date(today.getTime() + DAY), label: `Last ${n} days` };
}

export type MetricSummary = { key: string; total: number | null; reported: number; unavailable: number };
export type Dashboard = {
  range: { from: string; to: string; label: string };
  snapshot: { drafts: number; approved: number; scheduled: number; published: number; failed: number; rejected: number; queuedUpcoming: number; needsAttention: number };
  attempts: { total: number; success: number; reconciled: number; error: number; ambiguous: number; open: number; successRate: number | null; errorsByKind: Record<string, number>; truncated: boolean };
  published: { total: number; byBrandPlatform: { brandId: string; brand: string; platform: string; posts: number }[]; truncated: boolean };
  metrics: { platform: string; posts: number; notFetched: number; values: MetricSummary[] }[];
  ai: { calls: number; succeeded: number; failed: number; blocked: number; byPurpose: Record<string, number>; inputTokens: number; outputTokens: number; costUsd: number; unpricedCalls: number; truncated: boolean; brandFiltered: boolean };
  quotas: {
    ai: { month: string; generations: number; generationLimit: number; research: number; researchLimit: number; costUsd: number; costLimitUsd: number };
    posts: { today: number; dailyLimit: number; month: number; monthlyLimit: number };
  };
};

function check<T>({ data, error }: { data: T | null; error: { message: string } | null }): T {
  if (error) throw new Error(error.message);
  return data as T;
}

export function analyticsService(client: SupabaseClient, ctx: SocialContext, deps: { now?: () => Date } = {}) {
  const ws = ctx.workspaceId;
  const now = () => deps.now?.() ?? new Date();

  type Filter = ["eq" | "in" | "gte", string, string | string[]];
  async function count(table: string, filters: Filter[], select = "id") {
    let q = client.from(table).select(select, { count: "exact", head: true }).eq("workspace_id", ws);
    for (const [op, col, val] of filters) q = op === "eq" ? q.eq(col, val as string) : op === "in" ? q.in(col, val as string[]) : q.gte(col, val as string);
    const { count: n, error } = await q;
    if (error) throw new Error(error.message);
    return n ?? 0;
  }

  return {
    async dashboard(range: Range, f: Filters = {}): Promise<Dashboard> {
      assertCan(ctx.role, "workspace.view");
      const from = range.from.toISOString();
      const to = range.to.toISOString();
      const brand = f.brandId || null;
      const platform = f.platform || null;

      // ---- current state of the pipeline
      const postSelect = platform ? "id, post_variants!inner(platform)" : "id";
      const scope = (brandCol: string, platformCol: string): Filter[] => [...(brand ? [["eq", brandCol, brand] as Filter] : []), ...(platform ? [["eq", platformCol, platform] as Filter] : [])];
      const posts = (status: string[]) => count("posts", [["in", "status", status], ...scope("brand_id", "post_variants.platform")], postSelect);
      const jobSelect = platform ? "id, post_variants!inner(platform)" : "id";
      const jobs = (status: string[], upcoming: boolean) =>
        count("scheduled_jobs", [["in", "status", status], ...(upcoming ? [["gte", "run_at", now().toISOString()] as Filter] : []), ...scope("brand_id", "post_variants.platform")], jobSelect);
      const [drafts, approved, scheduled, publishedPosts, failed, rejected, queuedUpcoming, needsAttention] = await Promise.all([
        posts(["draft", "in_review"]), posts(["approved"]), posts(["scheduled"]), posts(["published"]), posts(["failed"]), posts(["rejected"]),
        jobs(["pending", "paused"], true), jobs(["needs_check", "dead"], false),
      ]);

      // ---- publishing attempts in the range
      let aq = client
        .from("publish_attempts")
        .select("outcome, error_kind, scheduled_jobs!inner(brand_id, post_variants!inner(platform))")
        .eq("workspace_id", ws)
        .gte("started_at", from)
        .lt("started_at", to)
        .limit(ROW_CAP);
      if (brand) aq = aq.eq("scheduled_jobs.brand_id", brand);
      if (platform) aq = aq.eq("scheduled_jobs.post_variants.platform", platform);
      const attempts = check(await aq) as unknown as { outcome: string | null; error_kind: string | null }[];
      const by = (o: string | null) => attempts.filter((a) => a.outcome === o).length;
      const a = { total: attempts.length, success: by("success"), reconciled: by("reconciled"), error: by("error"), ambiguous: by("ambiguous"), open: by(null) };
      const finished = a.success + a.reconciled + a.error + a.ambiguous;
      const errorsByKind: Record<string, number> = {};
      for (const x of attempts) if (x.outcome === "error" || x.outcome === "ambiguous") errorsByKind[x.error_kind ?? "unknown"] = (errorsByKind[x.error_kind ?? "unknown"] ?? 0) + 1;

      // ---- published versions in the range, and their metrics
      let pq = client
        .from("post_variants")
        .select("platform, metrics, metrics_fetched_at, posts!inner(brand_id, brands(name))")
        .eq("workspace_id", ws)
        .eq("status", "published")
        .gte("published_at", from)
        .lt("published_at", to)
        .limit(ROW_CAP);
      if (brand) pq = pq.eq("posts.brand_id", brand);
      if (platform) pq = pq.eq("platform", platform);
      const published = check(await pq) as unknown as { platform: string; metrics: Record<string, number | null> | null; metrics_fetched_at: string | null; posts: { brand_id: string; brands: { name: string } | null } }[];
      const groups = new Map<string, { brandId: string; brand: string; platform: string; posts: number }>();
      for (const p of published) {
        const k = `${p.posts.brand_id}:${p.platform}`;
        const g = groups.get(k) ?? { brandId: p.posts.brand_id, brand: p.posts.brands?.name ?? "Brand", platform: p.platform, posts: 0 };
        g.posts++;
        groups.set(k, g);
      }
      const metrics = [...new Set(published.map((p) => p.platform))].sort().map((pl) => {
        const rows = published.filter((p) => p.platform === pl);
        const fetched = rows.filter((r) => r.metrics);
        const keys = [...new Set(fetched.flatMap((r) => Object.keys(r.metrics!)))].sort();
        return {
          platform: pl,
          posts: rows.length,
          notFetched: rows.length - fetched.length,
          values: keys.map((key) => {
            const vals = fetched.map((r) => r.metrics![key]).filter((v): v is number => typeof v === "number");
            return { key, total: vals.length ? vals.reduce((s, v) => s + v, 0) : null, reported: vals.length, unavailable: fetched.length - vals.length };
          }),
        };
      });

      // ---- AI usage and cost in the range (AI calls belong to a brand, not a platform)
      let gq = client.from("ai_generations").select("purpose, status, input_tokens, output_tokens, cost_usd").eq("workspace_id", ws).gte("created_at", from).lt("created_at", to).limit(ROW_CAP);
      if (brand) gq = gq.eq("brand_id", brand);
      const gens = check(await gq) as { purpose: string; status: string; input_tokens: number | null; output_tokens: number | null; cost_usd: number | null }[];
      const ok = gens.filter((g) => g.status === "succeeded");
      const byPurpose: Record<string, number> = {};
      for (const g of ok) byPurpose[g.purpose] = (byPurpose[g.purpose] ?? 0) + 1;

      // ---- quotas this month
      const month = utcMonthStart(now());
      const [limitsRow, monthGens, settingsRow, postedToday, postedMonth] = await Promise.all([
        client.from("workspace_ai_limits").select("monthly_generation_limit, monthly_research_limit, monthly_cost_limit_usd").eq("workspace_id", ws).maybeSingle(),
        client.from("ai_generations").select("capability, cost_usd").eq("workspace_id", ws).eq("status", "succeeded").gte("created_at", month).limit(ROW_CAP),
        client.from("automation_settings").select("daily_post_limit, monthly_post_limit").eq("workspace_id", ws).maybeSingle(),
        count("publish_attempts", [["in", "outcome", ["success", "reconciled"]], ["gte", "finished_at", utcDayStart(now())]]),
        count("publish_attempts", [["in", "outcome", ["success", "reconciled"]], ["gte", "finished_at", month]]),
      ]);
      const limits = (check(limitsRow) as { monthly_generation_limit: number; monthly_research_limit: number; monthly_cost_limit_usd: number } | null) ?? { monthly_generation_limit: 300, monthly_research_limit: 100, monthly_cost_limit_usd: 25 };
      const mg = check(monthGens) as { capability: string; cost_usd: number | null }[];
      const settings = (check(settingsRow) as { daily_post_limit: number; monthly_post_limit: number } | null) ?? DEFAULT_SETTINGS;
      const round = (n: number) => Math.round(n * 100) / 100;

      return {
        range: { from, to, label: range.label },
        snapshot: { drafts, approved, scheduled, published: publishedPosts, failed, rejected, queuedUpcoming, needsAttention },
        attempts: { ...a, successRate: finished ? (a.success + a.reconciled) / finished : null, errorsByKind, truncated: attempts.length >= ROW_CAP },
        published: { total: published.length, byBrandPlatform: [...groups.values()].sort((x, y) => y.posts - x.posts), truncated: published.length >= ROW_CAP },
        metrics,
        ai: {
          calls: gens.length,
          succeeded: ok.length,
          failed: gens.filter((g) => g.status === "failed").length,
          blocked: gens.filter((g) => g.status === "blocked_by_limit").length,
          byPurpose,
          inputTokens: ok.reduce((s, g) => s + (g.input_tokens ?? 0), 0),
          outputTokens: ok.reduce((s, g) => s + (g.output_tokens ?? 0), 0),
          costUsd: round(ok.reduce((s, g) => s + Number(g.cost_usd ?? 0), 0)),
          unpricedCalls: ok.filter((g) => g.cost_usd == null).length,
          truncated: gens.length >= ROW_CAP,
          brandFiltered: Boolean(brand),
        },
        quotas: {
          ai: {
            month: month.slice(0, 7),
            generations: mg.filter((g) => g.capability === "text").length,
            generationLimit: limits.monthly_generation_limit,
            research: mg.filter((g) => g.capability === "research").length,
            researchLimit: limits.monthly_research_limit,
            costUsd: round(mg.reduce((s, g) => s + Number(g.cost_usd ?? 0), 0)),
            costLimitUsd: Number(limits.monthly_cost_limit_usd),
          },
          posts: { today: postedToday, dailyLimit: settings.daily_post_limit, month: postedMonth, monthlyLimit: settings.monthly_post_limit },
        },
      };
    },

    // ---- link tracking
    async linkTracking(brandId: string) {
      assertCan(ctx.role, "workspace.view");
      return check(await client.from("brand_link_tracking").select("enabled, utm_source, utm_medium, utm_campaign").eq("workspace_id", ws).eq("brand_id", brandId).maybeSingle()) as { enabled: boolean; utm_source: string; utm_medium: string; utm_campaign: string } | null;
    },

    async saveLinkTracking(brandId: string, input: { enabled: boolean; utm_source: string; utm_medium: string; utm_campaign: string }) {
      assertCan(ctx.role, "brand.edit");
      const b = check(await client.from("brands").select("id").eq("workspace_id", ws).eq("id", brandId).maybeSingle());
      if (!b) throw new Error("Brand not found.");
      check(await client.from("brand_link_tracking").upsert({ brand_id: brandId, workspace_id: ws, ...input, updated_by: ctx.email }, { onConflict: "brand_id" }));
      check(await client.from("audit_events").insert({ workspace_id: ws, actor_email: ctx.email, action: "brand.link_tracking_updated", entity_type: "brand", entity_id: brandId, details: input }));
    },

    // ---- audit log
    async audit(opts: { action?: string | null; actor?: string | null; before?: number | null; limit?: number } = {}) {
      assertCan(ctx.role, "workspace.view");
      let q = client.from("audit_events").select("*").eq("workspace_id", ws).order("id", { ascending: false }).limit(Math.min(opts.limit ?? 100, 200));
      if (opts.action) q = q.like("action", `${opts.action.replace(/[%_]/g, "")}%`);
      if (opts.actor) q = q.eq("actor_email", opts.actor);
      if (opts.before) q = q.lt("id", opts.before);
      return check(await q) as { id: number; actor_email: string; action: string; entity_type: string; entity_id: string | null; details: Record<string, unknown>; created_at: string }[];
    },
  };
}
