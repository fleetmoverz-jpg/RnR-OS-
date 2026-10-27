// Content planning, research and drafting for one workspace. Nothing here publishes: every post it
// creates is a draft, and approval only marks it ready for a later publishing phase.
import type { SupabaseClient } from "@supabase/supabase-js";
import { cancelPostJobs } from "../automation/jobs";
import { estimateCost, ProviderError, type Pricing, type ResearchProvider, type TextProvider, type TextRequest } from "../ai/providers";
import { assertCan, NotFound, type Permission } from "../policy";
import { socialRepo, type SocialContext } from "../repo";
import { draftsPrompt, draftsSchema, PROMPT_VERSIONS, topicsPrompt, TOPICS_SCHEMA, type BrandBrief, type SourceForPrompt } from "./prompts";
import {
  CATEGORIES,
  nearestDuplicate,
  normalizeHashtags,
  PLATFORM_RULES,
  TIME_SENSITIVE,
  titleSimilarity,
  validateVariant,
  type Category,
  type Facts,
  type Validation,
} from "./rules";

export type ContentDeps = {
  text: TextProvider | null;
  research: ResearchProvider | null;
  pricing: Pricing;
  textUnavailable?: string;
  researchUnavailable?: string;
  now?: () => Date;
};

export class UsageLimitReached extends Error {
  name = "UsageLimitReached";
}
export class ProfileNotApproved extends Error {
  name = "ProfileNotApproved";
}

export type Strategy = {
  brand_id: string;
  audience: string | null;
  goals: string | null;
  categories: Category[];
  platforms: string[];
  posts_per_week: number;
  preferred_days: number[];
  tone_override: string | null;
  avoid_topics: string[];
};

export type Topic = {
  id: string;
  brand_id: string;
  title: string;
  angle: string | null;
  service: string | null;
  location: string | null;
  category: Category | null;
  planned_for: string | null;
  needs_research: boolean;
  generation_id: string | null;
  status: "new" | "used" | "dismissed";
  created_at: string;
};

export type Source = { id: string; topic_id: string | null; url: string; title: string | null; publisher: string | null; published_at: string | null; retrieved_at: string; excerpt: string };

export type Variant = {
  id: string;
  post_id: string;
  platform: string;
  body: string;
  hashtags: string[];
  link_url: string | null;
  call_to_action: string | null;
  image_concept: string | null;
  status: string;
  validation: Validation;
  similar_to_variant_id: string | null;
  similarity: number | null;
  generation_id: string | null;
  edited_by: string | null;
  created_at: string;
};

export type DraftPost = {
  id: string;
  brand_id: string;
  topic_id: string | null;
  title: string;
  body: string;
  status: string;
  origin: string;
  category: string | null;
  rejected_reason: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  variants: Variant[];
  sources: Source[];
};

export type Usage = {
  month: string;
  generations: number;
  research: number;
  costUsd: number;
  unpricedCalls: number;
  limits: { monthly_generation_limit: number; monthly_research_limit: number; monthly_cost_limit_usd: number };
};

const DEFAULT_LIMITS = { monthly_generation_limit: 300, monthly_research_limit: 100, monthly_cost_limit_usd: 25 };
const DEFAULT_STRATEGY = { audience: null, goals: null, categories: ["educational", "faq", "maintenance_tips", "seasonal", "service_explainer"] as Category[], platforms: ["facebook_page"], posts_per_week: 3, preferred_days: [1, 3, 5], tone_override: null, avoid_topics: [] };

function check<T>({ data, error }: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as T;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// Next posting dates after `from`, on the strategy's preferred weekdays, `perWeek` at most per week.
export function nextSlots(from: Date, count: number, preferredDays: number[], perWeek: number): string[] {
  const days = preferredDays.length ? [...new Set(preferredDays)].sort() : [1, 3, 5];
  const out: string[] = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const weekCount = new Map<string, number>();
  const weekKey = (x: Date) => {
    const monday = new Date(x);
    monday.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
    return monday.toISOString().slice(0, 10);
  };
  for (let i = 0; out.length < count && i < 400; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!days.includes(d.getUTCDay())) continue;
    const wk = weekKey(d);
    if ((weekCount.get(wk) ?? 0) >= Math.max(1, perWeek)) continue;
    weekCount.set(wk, (weekCount.get(wk) ?? 0) + 1);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export function contentService(client: SupabaseClient, ctx: SocialContext, deps: ContentDeps) {
  const ws = ctx.workspaceId;
  const now = () => deps.now?.() ?? new Date();
  const repo = socialRepo(client, ctx);
  const can = (p: Permission) => assertCan(ctx.role, p);

  async function audit(action: string, entityType: string, entityId: string | null, details: Record<string, unknown> = {}) {
    check(await client.from("audit_events").insert({ workspace_id: ws, actor_email: ctx.email, action, entity_type: entityType, entity_id: entityId, details }));
  }

  // ---- usage and limits

  const monthStart = () => {
    const n = now();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)).toISOString();
  };

  async function usage(): Promise<Usage> {
    const [limitsRow, rows] = await Promise.all([
      client.from("workspace_ai_limits").select("*").eq("workspace_id", ws).maybeSingle(),
      client.from("ai_generations").select("capability, cost_usd, status").eq("workspace_id", ws).gte("created_at", monthStart()),
    ]);
    const limits = (check(limitsRow) as Usage["limits"] | null) ?? DEFAULT_LIMITS;
    const ok = (check(rows) as { capability: string; cost_usd: number | null; status: string }[]).filter((r) => r.status === "succeeded");
    return {
      month: monthStart().slice(0, 7),
      generations: ok.filter((r) => r.capability === "text").length,
      research: ok.filter((r) => r.capability === "research").length,
      costUsd: Math.round(ok.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0) * 100) / 100,
      unpricedCalls: ok.filter((r) => r.cost_usd == null).length,
      limits: { monthly_generation_limit: limits.monthly_generation_limit, monthly_research_limit: limits.monthly_research_limit, monthly_cost_limit_usd: Number(limits.monthly_cost_limit_usd) },
    };
  }

  async function record(row: { brand_id: string | null; purpose: string; capability: "text" | "research"; provider: string; model?: string | null; prompt_version?: string | null; input_tokens?: number | null; output_tokens?: number | null; cost_usd?: number | null; status: string; error?: string | null }) {
    const saved = check(await client.from("ai_generations").insert({ workspace_id: ws, created_by: ctx.email, ...row, error: row.error?.slice(0, 1000) ?? null }).select("id").single()) as { id: string };
    return saved.id;
  }

  async function guard(capability: "text" | "research", brandId: string | null, purpose: string, provider: string) {
    const u = await usage();
    const reason =
      capability === "text" && u.generations >= u.limits.monthly_generation_limit
        ? `This workspace has used its ${u.limits.monthly_generation_limit} AI generations for ${u.month}.`
        : capability === "research" && u.research >= u.limits.monthly_research_limit
          ? `This workspace has used its ${u.limits.monthly_research_limit} research calls for ${u.month}.`
          : u.costUsd >= u.limits.monthly_cost_limit_usd
            ? `This workspace has reached its $${u.limits.monthly_cost_limit_usd} AI spending limit for ${u.month}.`
            : null;
    if (reason) {
      await record({ brand_id: brandId, purpose, capability, provider, status: "blocked_by_limit", error: reason });
      throw new UsageLimitReached(`${reason} Raise the limit in Social Settings or wait for next month.`);
    }
  }

  async function runText(purpose: "topics" | "drafts" | "regenerate", brandId: string, req: TextRequest, version: string) {
    if (!deps.text) throw new Error(`AI drafting isn't configured: ${deps.textUnavailable ?? "no text provider"}.`);
    await guard("text", brandId, purpose, deps.text.id);
    try {
      const r = await deps.text.generate(req);
      const id = await record({
        brand_id: brandId, purpose, capability: "text", provider: deps.text.id, model: r.model, prompt_version: version,
        input_tokens: r.inputTokens, output_tokens: r.outputTokens, cost_usd: estimateCost(deps.pricing, r.inputTokens, r.outputTokens), status: "succeeded",
      });
      return { data: r.data as Record<string, unknown>, generationId: id };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await record({ brand_id: brandId, purpose, capability: "text", provider: deps.text.id, model: deps.text.model, prompt_version: version, status: "failed", error: message });
      throw e instanceof ProviderError ? e : new ProviderError(message);
    }
  }

  // ---- brand context

  async function brandContext(brandId: string) {
    const brand = await repo.getBrand(brandId);
    const [profileRes, factsRes] = await Promise.all([
      client.from("brand_profiles").select("*").eq("workspace_id", ws).eq("brand_id", brandId).maybeSingle(),
      client.from("brand_facts").select("kind, value, label, status").eq("workspace_id", ws).eq("brand_id", brandId).eq("status", "confirmed"),
    ]);
    const profile = check(profileRes) as Record<string, unknown> | null;
    if (!profile || profile.status !== "approved") throw new ProfileNotApproved("Approve this brand's profile before generating content, so only confirmed facts are used.");
    const facts = check(factsRes) as { kind: string; value: string; label: string | null }[];
    const strategy = await service.getStrategy(brandId);
    const s = (k: string) => (typeof profile[k] === "string" && profile[k] ? (profile[k] as string) : null);
    const claims = facts.filter((f) => ["claim", "certification", "offer"].includes(f.kind)).map((f) => f.value);
    const brief: BrandBrief = {
      name: s("business_name") ?? brand.name,
      website: s("website_url"),
      industry: s("industry"),
      niche: s("niche") ?? brand.niche,
      city: s("city"),
      region: s("region"),
      serviceAreas: (profile.service_areas as string[]) ?? [],
      services: (profile.services as string[]) ?? [],
      description: s("description"),
      valueProposition: s("value_proposition"),
      tone: strategy.tone_override ?? s("tone"),
      audience: strategy.audience,
      phone: s("phone"),
      confirmedClaims: claims,
      articles: facts.filter((f) => f.kind === "article").map((f) => ({ title: f.label ?? f.value, url: f.value })).slice(0, 15),
    };
    const domains = [s("canonical_domain"), s("website_url") && new URL(s("website_url")!).hostname].filter((d): d is string => Boolean(d)).map((d) => d.replace(/^www\./, ""));
    const facts4validation: Omit<Facts, "sourceUrls"> = { phones: brief.phone ? [brief.phone] : [], domains, credentials: claims };
    return { brand, brief, strategy, facts: facts4validation };
  }

  async function getTopic(topicId: string) {
    const t = check(await client.from("content_topics").select("*").eq("workspace_id", ws).eq("id", topicId).maybeSingle()) as Topic | null;
    if (!t) throw new NotFound("Topic");
    return t;
  }

  async function topicSources(topicId: string) {
    return check(await client.from("research_sources").select("*").eq("workspace_id", ws).eq("topic_id", topicId).order("retrieved_at")) as Source[];
  }

  async function recentVariants(brandId: string, excludeId?: string) {
    const since = new Date(now().getTime() - 120 * 86_400_000).toISOString();
    const posts = check(await client.from("posts").select("id").eq("workspace_id", ws).eq("brand_id", brandId).neq("status", "rejected").gte("created_at", since)) as { id: string }[];
    if (!posts.length) return [] as Variant[];
    const rows = check(await client.from("post_variants").select("*").eq("workspace_id", ws).in("post_id", posts.map((p) => p.id))) as Variant[];
    return rows.filter((r) => r.id !== excludeId);
  }

  function checkVariant(platform: string, v: { body: string; hashtags: string[]; link_url: string | null }, facts: Omit<Facts, "sourceUrls">, sources: Source[], others: Variant[]) {
    const validation = validateVariant(platform, v, { ...facts, sourceUrls: sources.map((s) => s.url) });
    const dup = nearestDuplicate(v.body, others);
    if (dup) validation.errors.push(`Too similar (${Math.round(dup.score * 100)}%) to another recent post. Edit or regenerate it.`);
    return { validation, similar_to_variant_id: dup?.item.id ?? null, similarity: dup ? Math.round(dup.score * 100) / 100 : null };
  }

  async function getPost(postId: string) {
    const p = check(await client.from("posts").select("*").eq("workspace_id", ws).eq("id", postId).maybeSingle()) as DraftPost | null;
    if (!p) throw new NotFound("Post");
    return p;
  }

  async function getVariant(variantId: string) {
    const v = check(await client.from("post_variants").select("*").eq("workspace_id", ws).eq("id", variantId).maybeSingle()) as Variant | null;
    if (!v) throw new NotFound("Variant");
    return v;
  }

  async function variantSources(variantId: string) {
    const links = check(await client.from("post_variant_sources").select("source_id").eq("workspace_id", ws).eq("variant_id", variantId)) as { source_id: string }[];
    if (!links.length) return [] as Source[];
    return check(await client.from("research_sources").select("*").eq("workspace_id", ws).in("id", links.map((l) => l.source_id))) as Source[];
  }

  const service = {
    usage: async () => {
      can("workspace.view");
      return usage();
    },

    async setLimits(input: Usage["limits"]) {
      can("workspace.manage");
      check(await client.from("workspace_ai_limits").upsert({ workspace_id: ws, ...input }, { onConflict: "workspace_id" }));
      await audit("ai_limits.updated", "workspace", ws, input);
    },

    async getStrategy(brandId: string): Promise<Strategy> {
      can("workspace.view");
      await repo.getBrand(brandId);
      const row = check(await client.from("content_strategies").select("*").eq("workspace_id", ws).eq("brand_id", brandId).maybeSingle()) as Strategy | null;
      return row ?? { brand_id: brandId, ...DEFAULT_STRATEGY };
    },

    async saveStrategy(brandId: string, input: Omit<Strategy, "brand_id">) {
      can("brand.edit");
      await repo.getBrand(brandId);
      check(await client.from("content_strategies").upsert({ brand_id: brandId, workspace_id: ws, ...input, updated_by: ctx.email }, { onConflict: "brand_id" }));
      await audit("content_strategy.updated", "brand", brandId, { categories: input.categories, platforms: input.platforms, posts_per_week: input.posts_per_week });
    },

    // Open topics planned between two dates, across the workspace's brands, for the calendar.
    async plannedTopics(from: string, to: string): Promise<(Topic & { brand_name: string })[]> {
      can("workspace.view");
      const rows = check(await client.from("content_topics").select("*, brands(name)").eq("workspace_id", ws).eq("status", "new").gte("planned_for", from).lt("planned_for", to).order("planned_for").limit(500)) as (Topic & { brands: { name: string } | null })[];
      return rows.map(({ brands, ...t }) => ({ ...t, brand_name: brands?.name ?? "" }));
    },

    async listTopics(brandId: string): Promise<(Topic & { sources: Source[] })[]> {
      can("workspace.view");
      await repo.getBrand(brandId);
      const topics = check(await client.from("content_topics").select("*").eq("workspace_id", ws).eq("brand_id", brandId).neq("status", "dismissed").order("planned_for", { ascending: true, nullsFirst: false }).limit(200)) as Topic[];
      const sources = topics.length ? (check(await client.from("research_sources").select("*").eq("workspace_id", ws).in("topic_id", topics.map((t) => t.id))) as Source[]) : [];
      return topics.map((t) => ({ ...t, sources: sources.filter((s) => s.topic_id === t.id) }));
    },

    // Asks the model for new topics, drops near-repeats of recent ones and places them on the calendar.
    async planTopics(brandId: string, opts: { count: number; categories?: Category[] }) {
      can("post.edit");
      const { brief, strategy } = await brandContext(brandId);
      const count = Math.min(Math.max(1, Math.floor(opts.count)), 10);
      const categories = (opts.categories?.length ? opts.categories : strategy.categories).filter((c) => (CATEGORIES as readonly string[]).includes(c));
      const since = new Date(now().getTime() - 180 * 86_400_000).toISOString();
      const [topicRows, postRows] = await Promise.all([
        client.from("content_topics").select("title, planned_for").eq("workspace_id", ws).eq("brand_id", brandId).gte("created_at", since),
        client.from("posts").select("title").eq("workspace_id", ws).eq("brand_id", brandId).gte("created_at", since),
      ]);
      const existing = check(topicRows) as { title: string; planned_for: string | null }[];
      const recentTitles = [...existing.map((t) => t.title), ...(check(postRows) as { title: string }[]).map((p) => p.title)];
      const { system, prompt } = topicsPrompt(brief, { count, categories, recentTitles: recentTitles.slice(-60), avoid: strategy.avoid_topics });
      const { data, generationId } = await runText("topics", brandId, { system, prompt, schema: TOPICS_SCHEMA, schemaName: "topics", maxTokens: 4000 }, PROMPT_VERSIONS.topics);

      const accepted: { title: string; category: Category; angle: string; service: string; location: string; needs_research: boolean }[] = [];
      const skipped: string[] = [];
      for (const raw of (Array.isArray(data.topics) ? data.topics : []) as Record<string, unknown>[]) {
        const title = str(raw.title, 200);
        const category = (categories as string[]).includes(String(raw.category)) ? (raw.category as Category) : categories[0];
        if (!title) continue;
        const seen = [...recentTitles, ...accepted.map((a) => a.title)];
        if (seen.some((t) => titleSimilarity(t, title) >= 0.6) || strategy.avoid_topics.some((a) => title.toLowerCase().includes(a.toLowerCase()))) {
          skipped.push(title);
          continue;
        }
        accepted.push({
          title, category, angle: str(raw.angle, 1000), service: str(raw.service, 120), location: str(raw.location, 120),
          needs_research: Boolean(raw.needs_research) || TIME_SENSITIVE.includes(category),
        });
      }
      const lastPlanned = existing.map((t) => t.planned_for).filter(Boolean).sort().pop();
      const from = lastPlanned && new Date(lastPlanned) > now() ? new Date(lastPlanned) : now();
      const slots = nextSlots(from, accepted.length, strategy.preferred_days, strategy.posts_per_week);
      const created: Topic[] = [];
      for (const [i, t] of accepted.entries()) {
        const { data: row, error } = await client
          .from("content_topics")
          .insert({ workspace_id: ws, brand_id: brandId, title: t.title, angle: t.angle || null, service: t.service || null, location: t.location || null, category: t.category, needs_research: t.needs_research, planned_for: slots[i] ?? null, generation_id: generationId })
          .select("*")
          .single();
        if (error?.code === "23505") {
          skipped.push(t.title);
          continue;
        }
        if (error) throw new Error(error.message);
        created.push(row as Topic);
      }
      await audit("content_topics.planned", "brand", brandId, { created: created.length, skipped: skipped.length, generation_id: generationId });
      return { created, skipped };
    },

    async dismissTopic(topicId: string) {
      can("post.edit");
      await getTopic(topicId);
      check(await client.from("content_topics").update({ status: "dismissed" }).eq("workspace_id", ws).eq("id", topicId));
    },

    // Searches the configured research provider and stores each result with URL, retrieval date and excerpt.
    async researchTopic(topicId: string) {
      can("post.edit");
      const topic = await getTopic(topicId);
      const { brief } = await brandContext(topic.brand_id);
      if (!deps.research) throw new Error(`Research isn't configured: ${deps.researchUnavailable ?? "no research provider"}.`);
      await guard("research", topic.brand_id, "research", deps.research.id);
      const place = topic.location || [brief.city, brief.region].filter(Boolean).join(" ");
      const query = `${topic.title} ${place}`.trim().slice(0, 300);
      const runRow = check(
        await client.from("research_runs").insert({ workspace_id: ws, brand_id: topic.brand_id, kind: "topic_research", status: "running", started_at: now().toISOString(), provider: deps.research.id, query }).select("id").single(),
      ) as { id: string };
      try {
        const results = await deps.research.search(query, { maxResults: 5, recentDays: topic.category && TIME_SENSITIVE.includes(topic.category) ? 365 : undefined });
        const generationId = await record({ brand_id: topic.brand_id, purpose: "research", capability: "research", provider: deps.research.id, status: "succeeded", cost_usd: deps.pricing.researchPerCall });
        const stamp = now().toISOString();
        const rows = results.slice(0, 5).map((r) => ({
          workspace_id: ws, brand_id: topic.brand_id, research_run_id: runRow.id, topic_id: topic.id, url: r.url.slice(0, 2000), title: r.title?.slice(0, 500) ?? null,
          publisher: r.publisher?.slice(0, 200) ?? null, published_at: r.publishedAt && !Number.isNaN(Date.parse(r.publishedAt)) ? new Date(r.publishedAt).toISOString() : null,
          retrieved_at: stamp, excerpt: r.snippet.slice(0, 2000),
        }));
        if (rows.length) check(await client.from("research_sources").upsert(rows, { onConflict: "topic_id,url" }));
        check(await client.from("research_runs").update({ status: "succeeded", finished_at: now().toISOString(), generation_id: generationId, summary: { results: rows.length } }).eq("workspace_id", ws).eq("id", runRow.id));
        return { sources: rows.length };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await record({ brand_id: topic.brand_id, purpose: "research", capability: "research", provider: deps.research.id, status: "failed", error: message });
        check(await client.from("research_runs").update({ status: "failed", finished_at: now().toISOString(), error: message.slice(0, 1000) }).eq("workspace_id", ws).eq("id", runRow.id));
        throw e;
      }
    },

    // Drafts posts with one variant per platform. Topics that need current facts are researched first.
    async generateDrafts(brandId: string, opts: { topicId?: string | null; category?: Category | null; platforms: string[]; tone?: string | null; quantity: number }) {
      can("post.edit");
      const { brief, facts, strategy } = await brandContext(brandId);
      const platforms = [...new Set(opts.platforms)].filter((p) => PLATFORM_RULES[p]);
      if (!platforms.length) throw new Error("Choose at least one platform.");
      const quantity = Math.min(Math.max(1, Math.floor(opts.quantity)), 5);
      let topics: Topic[];
      if (opts.topicId) {
        const t = await getTopic(opts.topicId);
        if (t.brand_id !== brandId) throw new NotFound("Topic");
        topics = [t];
      } else {
        let q = client.from("content_topics").select("*").eq("workspace_id", ws).eq("brand_id", brandId).eq("status", "new").order("planned_for", { ascending: true, nullsFirst: false }).limit(quantity);
        if (opts.category) q = q.eq("category", opts.category);
        topics = check(await q) as Topic[];
        if (topics.length < quantity) {
          const planned = await service.planTopics(brandId, { count: quantity - topics.length, categories: opts.category ? [opts.category] : strategy.categories });
          topics = [...topics, ...planned.created].slice(0, quantity);
        }
      }
      if (!topics.length) throw new Error("No topics available. Suggest topics first.");

      const others = await recentVariants(brandId);
      const created: string[] = [];
      const notes: string[] = [];
      for (const topic of topics) {
        let sources = await topicSources(topic.id);
        if (topic.needs_research && !sources.length) {
          if (deps.research) {
            try {
              await service.researchTopic(topic.id);
              sources = await topicSources(topic.id);
            } catch (e) {
              notes.push(`Research for "${topic.title}" failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          } else {
            notes.push(`"${topic.title}" needs current facts but no research provider is configured, so it was written without time-sensitive claims.`);
          }
        }
        const promptSources: SourceForPrompt[] = sources.map((s, i) => ({ id: `S${i + 1}`, url: s.url, title: s.title, excerpt: s.excerpt, retrieved_at: s.retrieved_at, published_at: s.published_at }));
        const avoidOpenings = others.slice(-15).map((o) => o.body.split(/[.!?\n]/)[0].slice(0, 80));
        const { system, prompt } = draftsPrompt(brief, { topic: topic, platforms, tone: opts.tone ?? null, sources: promptSources, avoidOpenings });
        const { data, generationId } = await runText("drafts", brandId, { system, prompt, schema: draftsSchema(platforms), schemaName: "drafts", maxTokens: 6000 }, PROMPT_VERSIONS.drafts);
        const used = new Set((Array.isArray(data.used_source_ids) ? data.used_source_ids : []).map(String));
        const cited = sources.filter((_, i) => used.has(`S${i + 1}`));

        const post = check(
          await client
            .from("posts")
            .insert({ workspace_id: ws, brand_id: brandId, topic_id: topic.id, title: str(data.title, 200) || topic.title, body: str(data.core_message, 5000), status: "draft", origin: "ai", category: topic.category, generation_id: generationId, created_by: ctx.email })
            .select("id")
            .single(),
        ) as { id: string };
        const variants = (Array.isArray(data.variants) ? data.variants : []) as Record<string, unknown>[];
        for (const platform of platforms) {
          const v = variants.find((x) => x.platform === platform);
          if (!v || !str(v.body, 5000)) {
            notes.push(`The model returned no ${PLATFORM_RULES[platform].label} version for "${topic.title}".`);
            continue;
          }
          const draft = { body: str(v.body, 5000), hashtags: normalizeHashtags(Array.isArray(v.hashtags) ? v.hashtags.map(String) : []), link_url: /^https?:\/\//.test(str(v.link_url, 2000)) ? str(v.link_url, 2000) : null };
          const checked = checkVariant(platform, draft, facts, cited, others);
          const row = check(
            await client
              .from("post_variants")
              .insert({ workspace_id: ws, post_id: post.id, platform, ...draft, call_to_action: str(v.call_to_action, 200) || null, image_concept: str(v.image_concept, 1000) || null, generation_id: generationId, status: "draft", ...checked })
              .select("*")
              .single(),
          ) as Variant;
          if (cited.length) check(await client.from("post_variant_sources").insert(cited.map((s) => ({ workspace_id: ws, variant_id: row.id, source_id: s.id }))));
          others.push(row);
        }
        check(await client.from("content_topics").update({ status: "used" }).eq("workspace_id", ws).eq("id", topic.id));
        created.push(post.id);
      }
      await audit("posts.generated", "brand", brandId, { posts: created.length, platforms });
      return { postIds: created, notes };
    },

    async listPosts(filter: { brandId?: string; statuses?: string[] } = {}): Promise<DraftPost[]> {
      can("workspace.view");
      let q = client.from("posts").select("*").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(50);
      if (filter.brandId) q = q.eq("brand_id", filter.brandId);
      if (filter.statuses?.length) q = q.in("status", filter.statuses);
      const posts = check(await q) as DraftPost[];
      if (!posts.length) return [];
      const variants = check(await client.from("post_variants").select("*").eq("workspace_id", ws).in("post_id", posts.map((p) => p.id)).order("platform")) as Variant[];
      const links = variants.length ? (check(await client.from("post_variant_sources").select("variant_id, source_id").eq("workspace_id", ws).in("variant_id", variants.map((v) => v.id))) as { variant_id: string; source_id: string }[]) : [];
      const sources = links.length ? (check(await client.from("research_sources").select("*").eq("workspace_id", ws).in("id", [...new Set(links.map((l) => l.source_id))])) as Source[]) : [];
      return posts.map((p) => {
        const vs = variants.filter((v) => v.post_id === p.id);
        const ids = new Set(links.filter((l) => vs.some((v) => v.id === l.variant_id)).map((l) => l.source_id));
        return { ...p, variants: vs, sources: sources.filter((s) => ids.has(s.id)) };
      });
    },

    // A person's edit. Revalidated; an approved post goes back to draft for re-approval.
    async updateVariant(variantId: string, input: { body: string; hashtags: string[]; link_url: string | null }) {
      can("post.edit");
      const v = await getVariant(variantId);
      const post = await getPost(v.post_id);
      if (!["draft", "approved", "scheduled", "rejected"].includes(post.status)) throw new Error("Only drafts can be edited.");
      if (["published", "publishing"].includes(v.status)) throw new Error("This version is already published.");
      const { facts } = await brandContext(post.brand_id);
      const draft = { body: input.body.trim().slice(0, 5000), hashtags: normalizeHashtags(input.hashtags), link_url: input.link_url };
      if (!draft.body) throw new Error("The post can't be empty.");
      const checked = checkVariant(v.platform, draft, facts, await variantSources(v.id), await recentVariants(post.brand_id, v.id));
      // An edited post leaves the queue until it is approved again.
      if (await cancelPostJobs(client, ws, post.id, "Edited after scheduling, so it needs approval again.")) await audit("post.unscheduled", "post", post.id, { reason: "edited" });
      check(await client.from("post_variants").update({ ...draft, ...checked, edited_by: ctx.email, status: "draft" }).eq("workspace_id", ws).eq("id", v.id));
      if (post.status !== "draft") check(await client.from("posts").update({ status: "draft", approved_by: null, approved_at: null, rejected_reason: null }).eq("workspace_id", ws).eq("id", post.id));
      return checked.validation;
    },

    async regenerateVariant(variantId: string) {
      can("post.edit");
      const v = await getVariant(variantId);
      const post = await getPost(v.post_id);
      if (!["draft", "rejected"].includes(post.status)) throw new Error("Only drafts can be regenerated.");
      const { brief, facts } = await brandContext(post.brand_id);
      const topic = post.topic_id ? await getTopic(post.topic_id) : { title: post.title, angle: null, category: post.category };
      const sources = post.topic_id ? await topicSources(post.topic_id) : [];
      const others = await recentVariants(post.brand_id, v.id);
      const promptSources = sources.map((s, i) => ({ id: `S${i + 1}`, url: s.url, title: s.title, excerpt: s.excerpt, retrieved_at: s.retrieved_at, published_at: s.published_at }));
      const { system, prompt } = draftsPrompt(brief, { topic, platforms: [v.platform], tone: null, sources: promptSources, avoidOpenings: [v.body.split(/[.!?\n]/)[0].slice(0, 80), ...others.slice(-10).map((o) => o.body.split(/[.!?\n]/)[0].slice(0, 80))] });
      const { data, generationId } = await runText("regenerate", post.brand_id, { system, prompt, schema: draftsSchema([v.platform]), schemaName: "drafts", maxTokens: 3000 }, PROMPT_VERSIONS.drafts);
      const nv = ((Array.isArray(data.variants) ? data.variants : []) as Record<string, unknown>[]).find((x) => x.platform === v.platform);
      if (!nv || !str(nv.body, 5000)) throw new ProviderError("The model returned no text for this platform.");
      const used = new Set((Array.isArray(data.used_source_ids) ? data.used_source_ids : []).map(String));
      const cited = sources.filter((_, i) => used.has(`S${i + 1}`));
      const draft = { body: str(nv.body, 5000), hashtags: normalizeHashtags(Array.isArray(nv.hashtags) ? nv.hashtags.map(String) : []), link_url: /^https?:\/\//.test(str(nv.link_url, 2000)) ? str(nv.link_url, 2000) : null };
      const checked = checkVariant(v.platform, draft, facts, cited, others);
      check(await client.from("post_variants").update({ ...draft, ...checked, call_to_action: str(nv.call_to_action, 200) || null, image_concept: str(nv.image_concept, 1000) || null, generation_id: generationId, edited_by: null, status: "draft" }).eq("workspace_id", ws).eq("id", v.id));
      check(await client.from("post_variant_sources").delete().eq("workspace_id", ws).eq("variant_id", v.id));
      if (cited.length) check(await client.from("post_variant_sources").insert(cited.map((s) => ({ workspace_id: ws, variant_id: v.id, source_id: s.id }))));
      return checked.validation;
    },

    // Approval marks the post ready for publishing later. Nothing is sent anywhere.
    async approvePost(postId: string) {
      can("post.approve");
      const post = await getPost(postId);
      if (post.status !== "draft") throw new Error(`Only drafts can be approved (this one is ${post.status}).`);
      const variants = check(await client.from("post_variants").select("*").eq("workspace_id", ws).eq("post_id", postId).order("platform")) as Variant[];
      if (!variants.length) throw new Error("This post has no platform versions.");
      const blocked = variants.filter((v) => v.validation?.errors?.length);
      if (blocked.length) throw new Error(`Fix the problems in ${blocked.map((v) => PLATFORM_RULES[v.platform]?.label ?? v.platform).join(", ")} first.`);
      check(await client.from("post_variants").update({ status: "approved" }).eq("workspace_id", ws).eq("post_id", postId));
      check(await client.from("posts").update({ status: "approved", approved_by: ctx.email, approved_at: now().toISOString(), rejected_reason: null }).eq("workspace_id", ws).eq("id", postId));
      await audit("post.approved", "post", postId, { variants: variants.length });
    },

    async rejectPost(postId: string, reason: string | null) {
      can("post.approve");
      const post = await getPost(postId);
      if (!["draft", "approved", "scheduled"].includes(post.status)) throw new Error(`A ${post.status} post can't be rejected.`);
      if (await cancelPostJobs(client, ws, postId, "Rejected, so it was taken out of the queue.")) await audit("post.unscheduled", "post", postId, { reason: "rejected" });
      check(await client.from("post_variants").update({ status: "draft" }).eq("workspace_id", ws).eq("post_id", postId).neq("status", "published"));
      check(await client.from("posts").update({ status: "rejected", rejected_reason: reason?.slice(0, 500) || null, approved_by: null, approved_at: null }).eq("workspace_id", ws).eq("id", postId));
      await audit("post.rejected", "post", postId, { reason });
    },
  };
  return service;
}

export type ContentService = ReturnType<typeof contentService>;
