// Content planning, research and drafting against a real database, with mocked model and search providers.
//   SOCIAL_TEST_SUPABASE_URL=http://localhost:54321 SOCIAL_TEST_SUPABASE_KEY=<service role key> npm test
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveWorkspace, socialRepo, type SocialContext } from "../src/lib/social/repo";
import { AccessDenied, NotFound } from "../src/lib/social/policy";
import { contentService, ProfileNotApproved, UsageLimitReached, type ContentDeps } from "../src/lib/social/content/service";
import type { ResearchProvider, TextProvider, TextRequest } from "../src/lib/social/ai/providers";

const url = process.env.SOCIAL_TEST_SUPABASE_URL;
const key = process.env.SOCIAL_TEST_SUPABASE_KEY;

type Reply = (req: TextRequest) => Record<string, unknown>;

describe("content planning and drafting", { skip: !url || !key ? "set SOCIAL_TEST_SUPABASE_URL and SOCIAL_TEST_SUPABASE_KEY" : false }, () => {
  let client: SupabaseClient;
  const run = randomUUID().slice(0, 8);
  const host = `roofco-${run}.test`;
  let ctxA: SocialContext, ctxB: SocialContext, viewer: SocialContext, editor: SocialContext;
  let brandA: string, brandB: string, brandDraft: string;
  const workspaceIds: string[] = [];
  const prompts: TextRequest[] = [];
  const searches: string[] = [];
  let reply: Reply = () => ({});

  const text: TextProvider = {
    id: "mock",
    model: "mock-1",
    async generate(req) {
      prompts.push(req);
      return { data: reply(req), model: "mock-1", inputTokens: 1000, outputTokens: 200 };
    },
  };
  const research: ResearchProvider = {
    id: "mock-search",
    async search(query) {
      searches.push(query);
      return [
        { url: "https://weather.test/hail-season", title: "Hail season outlook", snippet: "Forecasters expect an active hail season this autumn.", publishedAt: "2026-10-01", publisher: "Weather Test" },
        { url: "https://news.test/roof-claims", title: "Roof claims rise", snippet: "Roof insurance claims rose 12% last year.", publishedAt: null, publisher: "News Test" },
      ];
    },
  };
  const pricing = { inputPerMTok: 3, outputPerMTok: 15, researchPerCall: 0.01 };
  const svc = (ctx: SocialContext, extra: Partial<ContentDeps> = {}) => contentService(client, ctx, { text, research, pricing, ...extra });

  const fb = (body: string) => ({ platform: "facebook_page", body, hashtags: ["roofing"], link_url: `https://${host}/inspections`, call_to_action: "Book an inspection", image_concept: "A roofer checking shingles" });
  const drafts = (variants: Record<string, unknown>[], used: string[] = []) => () => ({ title: "Hail damage checks", core_message: "How to spot hail damage", used_source_ids: used, variants });
  const FB_BODY = "Hail can bruise shingles without leaving obvious holes. After a storm, look for dark spots, loose granules in the gutters and dented vents, then book an inspection before a small crack turns into a leak.";

  async function approveProfile(brandId: string, ctx: SocialContext, fields: Record<string, unknown>) {
    const { error } = await client.from("brand_profiles").update({ status: "approved", approved_at: new Date().toISOString(), approved_by: ctx.email, ...fields }).eq("brand_id", brandId);
    assert.ifError(error);
  }
  async function rows<T>(table: string, filter: Record<string, string>) {
    let q = client.from(table).select("*");
    for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
    const { data, error } = await q;
    assert.ifError(error);
    return data as T[];
  }

  before(async () => {
    client = createClient(url!, key!, { auth: { persistSession: false } });
    const ra = await resolveWorkspace(client, `owner-a-${run}@test.example`, { bootstrapOwner: true });
    const rb = await resolveWorkspace(client, `owner-b-${run}@test.example`, { bootstrapOwner: true });
    assert.ok(ra && rb);
    ctxA = ra.ctx;
    ctxB = rb.ctx;
    workspaceIds.push(ctxA.workspaceId, ctxB.workspaceId);
    const { error } = await client.from("workspace_members").insert([
      { workspace_id: ctxA.workspaceId, email: `viewer-${run}@test.example`, role: "viewer" },
      { workspace_id: ctxA.workspaceId, email: `editor-${run}@test.example`, role: "editor" },
    ]);
    assert.ifError(error);
    viewer = (await resolveWorkspace(client, `viewer-${run}@test.example`))!.ctx;
    editor = (await resolveWorkspace(client, `editor-${run}@test.example`))!.ctx;

    const repo = socialRepo(client, ctxA);
    brandA = (await repo.createBrand({ name: "RoofCo", niche: "Roofing", timezone: "America/Chicago" })).id;
    brandB = (await repo.createBrand({ name: "Other Brand", niche: "Plumbing", timezone: "UTC" })).id;
    brandDraft = (await repo.createBrand({ name: "Unapproved", niche: null, timezone: "UTC" })).id;
    await approveProfile(brandA, ctxA, { business_name: "RoofCo", phone: "(512) 555-0100", website_url: `https://${host}`, canonical_domain: host, city: "Austin", region: "TX", services: ["Roof repair", "Hail damage inspections"], tone: "plain and practical" });
    await approveProfile(brandB, ctxA, { business_name: "Other Brand", phone: "(212) 555-0199", website_url: "https://other.test", services: ["Drain cleaning"] });
    const facts = await client.from("brand_facts").insert([
      { workspace_id: ctxA.workspaceId, brand_id: brandA, kind: "certification", value: "Licensed and insured in Texas", status: "confirmed", origin: "user" },
      { workspace_id: ctxA.workspaceId, brand_id: brandB, kind: "certification", value: "Gold Star Elite Partner", status: "confirmed", origin: "user" },
      { workspace_id: ctxA.workspaceId, brand_id: brandA, kind: "claim", value: "We fly drones over every roof", status: "extracted", origin: "user" },
    ]);
    assert.ifError(facts.error);
    await svc(ctxA).saveStrategy(brandA, {
      audience: "Homeowners in older houses", goals: null, categories: ["seasonal", "faq", "maintenance_tips"], platforms: ["facebook_page", "x"],
      posts_per_week: 2, preferred_days: [2, 4], tone_override: null, avoid_topics: ["pricing"],
    });
  });

  after(async () => {
    if (workspaceIds.length) await client.from("workspaces").delete().in("id", workspaceIds);
  });

  test("a brand without an approved profile can't use AI, and viewers can't plan", async () => {
    const before = prompts.length;
    await assert.rejects(svc(ctxA).planTopics(brandDraft, { count: 3 }), ProfileNotApproved);
    await assert.rejects(svc(ctxA).generateDrafts(brandDraft, { platforms: ["x"], quantity: 1 }), ProfileNotApproved);
    await assert.rejects(svc(viewer).planTopics(brandA, { count: 3 }), AccessDenied);
    await assert.rejects(svc(viewer).saveStrategy(brandA, { audience: null, goals: null, categories: ["faq"], platforms: ["x"], posts_per_week: 1, preferred_days: [1], tone_override: null, avoid_topics: [] }), AccessDenied);
    assert.equal(prompts.length, before);
  });

  test("planning drops near-repeats and avoided subjects, schedules the rest and records the generation", async () => {
    reply = () => ({
      topics: [
        { title: "Spotting hail damage after an autumn storm", category: "seasonal", angle: "What to look for", service: "Hail damage inspections", location: "Austin", needs_research: false, search_query: "" },
        { title: "Spotting hail damage after autumn storms", category: "seasonal", angle: "Same again", service: "", location: "", needs_research: false, search_query: "" },
        { title: "Why roof pricing varies", category: "faq", angle: "", service: "", location: "", needs_research: false, search_query: "" },
        { title: "Cleaning gutters before winter", category: "maintenance_tips", angle: "Simple steps", service: "", location: "", needs_research: false, search_query: "" },
        { title: "Made-up category", category: "celebrity_gossip", angle: "", service: "", location: "", needs_research: false, search_query: "" },
      ],
    });
    const r = await svc(editor).planTopics(brandA, { count: 5 });
    assert.deepEqual(r.created.map((t) => t.title), ["Spotting hail damage after an autumn storm", "Cleaning gutters before winter", "Made-up category"]);
    assert.deepEqual(r.skipped, ["Spotting hail damage after autumn storms", "Why roof pricing varies"]);
    const [seasonal, tips, unknown] = r.created;
    assert.equal(seasonal.needs_research, true, "seasonal topics are always researched");
    assert.equal(tips.needs_research, false);
    assert.equal(unknown.category, "seasonal", "an unknown category falls back to the strategy's first");
    for (const t of r.created) assert.ok([2, 4].includes(new Date(`${t.planned_for}T00:00:00Z`).getUTCDay()), `${t.planned_for} is a preferred day`);

    const gen = (await rows<Record<string, unknown>>("ai_generations", { id: seasonal.generation_id! }))[0];
    assert.equal(gen.purpose, "topics");
    assert.equal(gen.capability, "text");
    assert.equal(gen.provider, "mock");
    assert.equal(gen.model, "mock-1");
    assert.equal(gen.prompt_version, "topics-v1");
    assert.equal(gen.input_tokens, 1000);
    assert.equal(Number(gen.cost_usd), 0.006);

    // A second round sees the earlier titles in its prompt and can't add them again.
    reply = () => ({ topics: [{ title: "Cleaning gutters before winter", category: "maintenance_tips", angle: "", service: "", location: "", needs_research: false, search_query: "" }] });
    const again = await svc(editor).planTopics(brandA, { count: 1 });
    assert.equal(again.created.length, 0);
    assert.match(prompts.at(-1)!.prompt, /- Cleaning gutters before winter/);
  });

  test("only this brand's confirmed facts reach the model, and other workspaces can't touch it", async () => {
    const p = prompts.at(-1)!;
    assert.match(p.prompt, /Licensed and insured in Texas/);
    assert.match(p.prompt, /\(512\) 555-0100/);
    assert.doesNotMatch(p.prompt, /Gold Star Elite Partner|555-0199|Drain cleaning/);
    assert.doesNotMatch(p.prompt, /drones/, "unconfirmed claims stay out");
    await assert.rejects(svc(ctxB).planTopics(brandA, { count: 1 }), NotFound);
    await assert.rejects(svc(ctxB).getStrategy(brandA), NotFound);
    assert.deepEqual(await svc(ctxB).listPosts(), []);
  });

  test("time-sensitive topics are researched first; sources are stored, cited and linked to each variant", async () => {
    const topic = (await svc(ctxA).listTopics(brandA)).find((t) => t.title.startsWith("Spotting hail"))!;
    reply = drafts(
      [
        fb(`${FB_BODY} Roof insurance claims rose 12% last year.`),
        { platform: "x", body: "Storm last night? Check for dark spots on shingles and granules in the gutters. RoofCo can take a look.", hashtags: ["hail"], link_url: "", call_to_action: "", image_concept: "" },
      ],
      ["S2"],
    );
    const r = await svc(editor).generateDrafts(brandA, { topicId: topic.id, platforms: ["facebook_page", "x"], quantity: 1 });
    assert.equal(r.postIds.length, 1);
    assert.equal(searches.length, 1);
    assert.match(searches[0], /Spotting hail damage.*Austin/);

    const sources = await rows<{ url: string; retrieved_at: string; excerpt: string; research_run_id: string }>("research_sources", { topic_id: topic.id });
    assert.equal(sources.length, 2);
    assert.ok(sources.every((s) => s.retrieved_at && s.excerpt && s.research_run_id));
    assert.match(prompts.at(-1)!.prompt, /\[S2\] Roof claims rise \(https:\/\/news.test\/roof-claims; retrieved/);

    const [post] = await svc(ctxA).listPosts({ brandId: brandA });
    assert.equal(post.status, "draft");
    assert.equal(post.origin, "ai");
    assert.deepEqual(post.variants.map((v) => v.platform).sort(), ["facebook_page", "x"]);
    assert.deepEqual(post.sources.map((s) => s.url), ["https://news.test/roof-claims"], "only the cited source is attached");
    const facebook = post.variants.find((v) => v.platform === "facebook_page")!;
    assert.deepEqual(facebook.validation.errors, [], "the statistic is backed by a cited source");
    const links = await rows("post_variant_sources", { variant_id: facebook.id });
    assert.equal(links.length, 1);
    assert.equal((await rows<{ status: string }>("content_topics", { id: topic.id }))[0].status, "used");

    const run = (await rows<Record<string, unknown>>("research_runs", { brand_id: brandA })).find((x) => x.kind === "topic_research")!;
    assert.equal(run.status, "succeeded");
    assert.equal(run.provider, "mock-search");
    const gens = await rows<{ purpose: string; capability: string; cost_usd: number }>("ai_generations", { brand_id: brandA });
    assert.ok(gens.some((g) => g.purpose === "research" && g.capability === "research" && Number(g.cost_usd) === 0.01));
    assert.ok(gens.some((g) => g.purpose === "drafts"));
  });

  test("near-duplicates and unsupported claims block approval until fixed", async () => {
    const topic = (await svc(ctxA).listTopics(brandA)).find((t) => t.title.startsWith("Cleaning gutters"))!;
    reply = drafts([fb(FB_BODY.replace("Hail can", "Hail may")), { platform: "x", body: "We're award-winning roofers. Call 512-555-0123 today.", hashtags: [], link_url: "https://spam.test", call_to_action: "", image_concept: "" }]);
    const { postIds } = await svc(editor).generateDrafts(brandA, { topicId: topic.id, platforms: ["facebook_page", "x"], quantity: 1 });
    assert.equal(searches.length, 1, "maintenance tips aren't researched");
    const post = (await svc(ctxA).listPosts({ brandId: brandA })).find((p) => p.id === postIds[0])!;
    const facebook = post.variants.find((v) => v.platform === "facebook_page")!;
    const x = post.variants.find((v) => v.platform === "x")!;
    assert.ok(facebook.validation.errors.some((e) => e.startsWith("Too similar")));
    assert.ok(facebook.similar_to_variant_id);
    assert.ok(x.validation.errors.some((e) => e.includes("award-winning")));
    assert.ok(x.validation.errors.some((e) => e.includes("isn't a confirmed number")));
    assert.ok(x.validation.errors.some((e) => e.includes("spam.test")));

    await assert.rejects(svc(ctxA).approvePost(post.id), /Fix the problems in Facebook Page, X/);
    await assert.rejects(svc(editor).approvePost(post.id), AccessDenied);

    const fixedFb = await svc(editor).updateVariant(facebook.id, { body: "Gutters full of leaves send rainwater under the roof edge. Clear them before the first cold snap and check that downspouts drain away from the house.", hashtags: ["gutters"], link_url: null });
    assert.deepEqual(fixedFb.errors, []);
    await svc(editor).updateVariant(x.id, { body: "Clear your gutters before winter so rain can drain away from the roof edge. Licensed and insured in Texas, if you'd like a hand.", hashtags: [], link_url: null });
    await svc(ctxA).approvePost(post.id);
    const approved = (await rows<{ status: string; approved_by: string }>("posts", { id: post.id }))[0];
    assert.equal(approved.status, "approved");
    assert.equal(approved.approved_by, ctxA.email);

    // Editing an approved post sends it back for approval.
    await svc(editor).updateVariant(x.id, { body: "Clear your gutters before winter so rain drains away from the roof edge.", hashtags: [], link_url: null });
    assert.equal((await rows<{ status: string }>("posts", { id: post.id }))[0].status, "draft");

    await svc(ctxA).rejectPost(post.id, "Not this week");
    const rejected = (await rows<{ status: string; rejected_reason: string }>("posts", { id: post.id }))[0];
    assert.deepEqual([rejected.status, rejected.rejected_reason], ["rejected", "Not this week"]);
  });

  test("regenerating replaces one platform version and records its own generation", async () => {
    const post = (await svc(ctxA).listPosts({ brandId: brandA })).find((p) => p.status === "rejected")!;
    const x = post.variants.find((v) => v.platform === "x")!;
    reply = drafts([{ platform: "x", body: "Before winter, scoop leaves out of the gutters and check the downspouts run clear.", hashtags: ["gutters"], link_url: "", call_to_action: "", image_concept: "Gloved hand clearing a gutter" }]);
    const v = await svc(editor).regenerateVariant(x.id);
    assert.deepEqual(v.errors, []);
    const updated = (await rows<{ body: string; image_concept: string; generation_id: string }>("post_variants", { id: x.id }))[0];
    assert.match(updated.body, /scoop leaves/);
    assert.equal((await rows<{ purpose: string }>("ai_generations", { id: updated.generation_id }))[0].purpose, "regenerate");
    assert.match(prompts.at(-1)!.system, /Never invent/);
  });

  test("monthly limits stop new AI calls and record the blocked attempt", async () => {
    await assert.rejects(svc(editor).setLimits({ monthly_generation_limit: 1, monthly_research_limit: 1, monthly_cost_limit_usd: 1 }), AccessDenied);
    const used = await svc(ctxA).usage();
    assert.ok(used.generations >= 4);
    assert.ok(used.costUsd > 0);
    await svc(ctxA).setLimits({ monthly_generation_limit: used.generations, monthly_research_limit: 100, monthly_cost_limit_usd: 25 });
    const before = prompts.length;
    await assert.rejects(svc(editor).planTopics(brandA, { count: 1 }), UsageLimitReached);
    assert.equal(prompts.length, before, "the model isn't called");
    const blocked = (await rows<{ status: string }>("ai_generations", { workspace_id: ctxA.workspaceId })).filter((g) => g.status === "blocked_by_limit");
    assert.equal(blocked.length, 1);
    assert.equal((await svc(ctxB).usage()).generations, 0, "usage is per workspace");
  });

  test("nothing is scheduled or published", async () => {
    assert.equal((await rows("scheduled_jobs", { workspace_id: ctxA.workspaceId })).length, 0);
    assert.equal((await rows("publish_attempts", { workspace_id: ctxA.workspaceId })).length, 0);
  });
});
