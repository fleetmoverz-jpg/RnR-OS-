// Analytics, link tracking and request limits against a real database, with the Graph API mocked.
//   SOCIAL_TEST_SUPABASE_URL=http://localhost:54321 SOCIAL_TEST_SUPABASE_KEY=<service role key> npm test
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveWorkspace, socialRepo, type SocialContext } from "../src/lib/social/repo";
import { AccessDenied } from "../src/lib/social/policy";
import { analyticsService, parseRange } from "../src/lib/social/analytics/service";
import { connectionService } from "../src/lib/social/publish/connections";
import { publishService } from "../src/lib/social/publish/service";
import { facebookPageAdapter, metaConnect } from "../src/lib/social/publish/meta";
import { rateLimit, RateLimited } from "../src/lib/social/limits";
import { jpegBytes, mockMeta } from "./support/mock-meta";

const url = process.env.SOCIAL_TEST_SUPABASE_URL;
const key = process.env.SOCIAL_TEST_SUPABASE_KEY;

describe("analytics, link tracking and request limits", { skip: !url || !key ? "set SOCIAL_TEST_SUPABASE_URL and SOCIAL_TEST_SUPABASE_KEY" : false }, () => {
  let client: SupabaseClient;
  const run = randomUUID().slice(0, 8);
  const encryptionKey = randomBytes(32).toString("base64");
  const PAGE = `p${run}`;
  let ctxA: SocialContext, ctxB: SocialContext, viewer: SocialContext, editor: SocialContext;
  let brandA: string, brandA2: string, account: string;
  const workspaceIds: string[] = [];
  const now = new Date("2026-10-22T12:00:00Z");
  const range = parseRange({ range: "30" }, now);

  const graph = mockMeta({
    "GET /me/accounts": () => ({ body: { data: [{ id: PAGE, name: "RoofCo", tasks: ["CREATE_CONTENT"], access_token: `PT-${run}` }] } }),
    [`POST /${PAGE}/feed`]: () => ({ body: { id: `${PAGE}_${randomUUID().slice(0, 6)}` } }),
  });
  const meta = { appId: "app", appSecret: "secret", redirectUri: "https://rnr.test/cb", fetch: graph.fetch, sleep: async () => {} };
  const adapters = { facebook_page: facebookPageAdapter(meta) };
  const fetchImage = async (u: string) => ({ url: u, status: 200, contentType: "image/jpeg", body: "", bytes: jpegBytes(1080, 1080), truncated: false });
  const stats = (ctx: SocialContext, f = {}) => analyticsService(client, ctx, { now: () => now }).dashboard(range, f);

  async function insert(table: string, rows: Record<string, unknown> | Record<string, unknown>[]) {
    const { data, error } = await client.from(table).insert(rows).select("id");
    assert.ifError(error);
    return (data as { id: string }[]).map((r) => r.id);
  }
  // A post with one version, optionally published at `at` with `metrics`, and one attempt with `outcome`.
  async function post(brand: string, status: string, opts: { platform?: string; at?: string; metrics?: Record<string, number | null> | null; outcome?: string; kind?: string } = {}) {
    const ws = ctxA.workspaceId;
    const [postId] = await insert("posts", { workspace_id: ws, brand_id: brand, title: `P ${randomUUID().slice(0, 4)}`, status, created_by: ctxA.email });
    const published = opts.at ? { status: "published", published_at: opts.at, external_post_id: `x${randomUUID().slice(0, 6)}`, metrics: opts.metrics ?? null, metrics_fetched_at: opts.metrics ? opts.at : null } : { status: status === "draft" ? "draft" : "approved" };
    const [variantId] = await insert("post_variants", { workspace_id: ws, post_id: postId, platform: opts.platform ?? "facebook_page", body: "Body", ...published });
    if (opts.outcome) {
      const [jobId] = await insert("scheduled_jobs", { workspace_id: ws, brand_id: brand, variant_id: variantId, run_at: opts.at ?? "2026-10-20T10:00:00Z", idempotency_key: `t:${variantId}`, status: opts.outcome === "success" ? "succeeded" : "failed", external_post_id: opts.outcome === "success" ? "x1" : null });
      await insert("publish_attempts", { workspace_id: ws, job_id: jobId, attempt_no: 1, started_at: opts.at ?? "2026-10-20T10:00:00Z", finished_at: opts.at ?? "2026-10-20T10:00:01Z", outcome: opts.outcome, external_post_id: opts.outcome === "success" ? "x1" : null, error_kind: opts.kind ?? null });
    }
    return { postId, variantId };
  }

  before(async () => {
    client = createClient(url!, key!, { auth: { persistSession: false } });
    const ra = await resolveWorkspace(client, `owner-a-${run}@test.example`, { bootstrapOwner: true });
    const rb = await resolveWorkspace(client, `owner-b-${run}@test.example`, { bootstrapOwner: true });
    assert.ok(ra && rb);
    ctxA = ra.ctx;
    ctxB = rb.ctx;
    workspaceIds.push(ctxA.workspaceId, ctxB.workspaceId);
    assert.ifError((await client.from("workspace_members").insert([
      { workspace_id: ctxA.workspaceId, email: `viewer-${run}@test.example`, role: "viewer" },
      { workspace_id: ctxA.workspaceId, email: `editor-${run}@test.example`, role: "editor" },
    ])).error);
    viewer = (await resolveWorkspace(client, `viewer-${run}@test.example`))!.ctx;
    editor = (await resolveWorkspace(client, `editor-${run}@test.example`))!.ctx;
    const repo = socialRepo(client, ctxA);
    brandA = (await repo.createBrand({ name: "RoofCo", niche: null, timezone: "UTC" })).id;
    brandA2 = (await repo.createBrand({ name: "PlumbCo", niche: null, timezone: "UTC" })).id;

    await post(brandA, "draft");
    await post(brandA, "draft");
    await post(brandA, "approved");
    await post(brandA, "published", { at: "2026-10-20T10:00:00Z", metrics: { reactions: 5, comments: 2, shares: null }, outcome: "success" });
    await post(brandA, "published", { at: "2026-10-21T10:00:00Z", metrics: { reactions: 0, comments: null, shares: null }, outcome: "success" });
    await post(brandA, "published", { platform: "instagram", at: "2026-10-21T11:00:00Z", metrics: null, outcome: "success" });
    await post(brandA2, "failed", { outcome: "error", kind: "auth" });
    await post(brandA, "published", { at: "2026-08-01T10:00:00Z", outcome: "success" }); // outside the range
    await insert("ai_generations", [
      { workspace_id: ctxA.workspaceId, brand_id: brandA, purpose: "drafts", capability: "text", provider: "mock", status: "succeeded", input_tokens: 1000, output_tokens: 200, cost_usd: 0.006, created_by: ctxA.email, created_at: "2026-10-20T09:00:00Z" },
      { workspace_id: ctxA.workspaceId, brand_id: brandA, purpose: "research", capability: "research", provider: "mock", status: "succeeded", cost_usd: null, created_by: ctxA.email, created_at: "2026-10-20T09:00:00Z" },
      { workspace_id: ctxA.workspaceId, brand_id: brandA2, purpose: "topics", capability: "text", provider: "mock", status: "blocked_by_limit", created_by: ctxA.email, created_at: "2026-10-20T09:00:00Z" },
    ]);
  });

  after(async () => {
    if (workspaceIds.length) await client.from("workspaces").delete().in("id", workspaceIds);
  });

  test("counts the pipeline, attempts and published posts for the range", async () => {
    const d = await stats(viewer);
    assert.equal(d.snapshot.drafts, 2);
    assert.equal(d.snapshot.approved, 1);
    assert.equal(d.snapshot.published, 4);
    assert.equal(d.snapshot.failed, 1);
    assert.deepEqual([d.attempts.total, d.attempts.success, d.attempts.error], [4, 3, 1], "the August attempt is outside the range");
    assert.equal(d.attempts.successRate, 0.75);
    assert.deepEqual(d.attempts.errorsByKind, { auth: 1 });
    assert.equal(d.published.total, 3);
    assert.deepEqual(d.published.byBrandPlatform.map((g) => [g.brand, g.platform, g.posts]), [["RoofCo", "facebook_page", 2], ["RoofCo", "instagram", 1]]);
  });

  test("metrics the platform didn't report stay unavailable, never zero", async () => {
    const d = await stats(ctxA);
    const fb = d.metrics.find((m) => m.platform === "facebook_page")!;
    assert.deepEqual(fb.values, [
      { key: "comments", total: 2, reported: 1, unavailable: 1 },
      { key: "reactions", total: 5, reported: 2, unavailable: 0 },
      { key: "shares", total: null, reported: 0, unavailable: 2 },
    ]);
    const ig = d.metrics.find((m) => m.platform === "instagram")!;
    assert.deepEqual([ig.posts, ig.notFetched, ig.values], [1, 1, []]);
  });

  test("filters by brand and platform", async () => {
    const plumb = await stats(ctxA, { brandId: brandA2 });
    assert.deepEqual([plumb.snapshot.failed, plumb.snapshot.drafts, plumb.attempts.total, plumb.attempts.successRate], [1, 0, 1, 0]);
    const ig = await stats(ctxA, { platform: "instagram" });
    assert.deepEqual([ig.published.total, ig.attempts.total, ig.snapshot.published], [1, 1, 1]);
  });

  test("AI usage shows calls, tokens and cost, and counts calls with no price", async () => {
    const d = await stats(ctxA);
    assert.deepEqual([d.ai.calls, d.ai.succeeded, d.ai.blocked, d.ai.inputTokens, d.ai.costUsd, d.ai.unpricedCalls], [3, 2, 1, 1000, 0.01, 1]);
    assert.deepEqual(d.ai.byPurpose, { drafts: 1, research: 1 });
  });

  test("another workspace sees nothing, and a success rate with no attempts is unavailable", async () => {
    const d = await stats(ctxB);
    assert.deepEqual([d.snapshot.drafts, d.attempts.total, d.published.total, d.ai.calls], [0, 0, 0, 0]);
    assert.equal(d.attempts.successRate, null);
    const audit = await analyticsService(client, ctxB).audit();
    assert.ok(audit.every((e) => e.actor_email === ctxB.email), "only its own audit events");
  });

  test("link tracking tags the link that is actually sent and records it", async () => {
    await assert.rejects(analyticsService(client, viewer).saveLinkTracking(brandA, { enabled: true, utm_source: "{platform}", utm_medium: "social", utm_campaign: "fall" }), AccessDenied);
    await analyticsService(client, editor).saveLinkTracking(brandA, { enabled: true, utm_source: "{platform}", utm_medium: "social", utm_campaign: "fall" });
    await assert.rejects(analyticsService(client, ctxA).saveLinkTracking(brandA, { enabled: true, utm_source: "bad value!", utm_medium: "social", utm_campaign: "x" }), /check constraint/);

    const conns = connectionService(client, ctxA, { provider: metaConnect(meta), adapters, encryptionKey });
    const conn = await conns.saveConnection({ userId: `u${run}`, userName: "Owner", token: `U-${run}`, expiresAt: null, scopes: ["pages_show_list", "pages_manage_posts", "pages_read_engagement"], declined: [] });
    await conns.discover(conn);
    account = await conns.addAccount((await conns.listAssets())[0].id, brandA);
    const [postId] = await insert("posts", { workspace_id: ctxA.workspaceId, brand_id: brandA, title: "Tracked", status: "approved", created_by: ctxA.email });
    const [variantId] = await insert("post_variants", { workspace_id: ctxA.workspaceId, post_id: postId, platform: "facebook_page", social_account_id: account, body: "Book an inspection.", link_url: "https://roofco.test/book?ref=fb", status: "approved" });
    const r = await publishService(client, ctxA, { adapters, encryptionKey, fetchImage }).publishNow(variantId);
    assert.equal(r.outcome, "published");
    const sent = graph.calls.find((c) => c.path === `/${PAGE}/feed`)!.params.get("link");
    assert.equal(sent, "https://roofco.test/book?ref=fb&utm_source=facebook_page&utm_medium=social&utm_campaign=fall");
    const v = (await client.from("post_variants").select("link_url, sent_link_url").eq("id", variantId).single()).data!;
    assert.deepEqual(v, { link_url: "https://roofco.test/book?ref=fb", sent_link_url: sent }, "the draft keeps its clean link");
    const audit = await analyticsService(client, ctxA).audit({ action: "brand." });
    assert.ok(audit.some((e) => e.action === "brand.link_tracking_updated" && e.actor_email === editor.email));
  });

  test("request limits refuse the call after the limit, per person and per window", async () => {
    const who = `limit-${run}`;
    const t = new Date("2026-10-22T12:00:05Z");
    for (let i = 0; i < 6; i++) await rateLimit(client, "worker", who, t);
    await assert.rejects(rateLimit(client, "worker", who, t), RateLimited);
    await rateLimit(client, "worker", `${who}-other`, t);
    await rateLimit(client, "worker", who, new Date(t.getTime() + 601_000));
    // Parallel calls can't slip past the limit.
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => rateLimit(client, "worker", `${who}-race`, t)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 6);
  });
});
