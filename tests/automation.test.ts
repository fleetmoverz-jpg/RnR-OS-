// Scheduling, the queue worker and automation against a real database, with Meta and the AI model mocked.
//   SOCIAL_TEST_SUPABASE_URL=http://localhost:54321 SOCIAL_TEST_SUPABASE_KEY=<service role key> npm test
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveWorkspace, socialRepo, type SocialContext } from "../src/lib/social/repo";
import { AccessDenied, NotFound } from "../src/lib/social/policy";
import { connectionService } from "../src/lib/social/publish/connections";
import { publishService, PublishBlocked, jobKey } from "../src/lib/social/publish/service";
import { facebookPageAdapter, instagramAdapter, metaConnect } from "../src/lib/social/publish/meta";
import { contentService } from "../src/lib/social/content/service";
import { queueService } from "../src/lib/social/automation/queue";
import { runWorker, AUTOMATION_ACTOR, type WorkerDeps } from "../src/lib/social/automation/worker";
import type { TextProvider, TextRequest } from "../src/lib/social/ai/providers";
import type { Fetched } from "../src/lib/social/safeFetch";
import { graphError, jpegBytes, mockMeta } from "./support/mock-meta";

const url = process.env.SOCIAL_TEST_SUPABASE_URL;
const key = process.env.SOCIAL_TEST_SUPABASE_KEY;

type Route = Parameters<typeof mockMeta>[0][string];

describe("scheduling, the queue worker and automation", { skip: !url || !key ? "set SOCIAL_TEST_SUPABASE_URL and SOCIAL_TEST_SUPABASE_KEY" : false }, () => {
  let client: SupabaseClient;
  const run = randomUUID().slice(0, 8);
  const encryptionKey = randomBytes(32).toString("base64");
  const PAGE = `p1${run}`;
  const PAGE2 = `p2${run}`;
  let ctxA: SocialContext, ctxB: SocialContext, editor: SocialContext;
  let brand: string, fbAccount: string, spareAccount: string;
  const workspaceIds: string[] = [];
  // Monday 26 October 2026, 08:00 in New York.
  let clock = new Date("2026-10-26T12:00:00Z");
  let postSeq = 0;

  const routes: Record<string, Route> = {
    "GET /me/accounts": () => ({
      body: {
        data: [
          { id: PAGE, name: "RoofCo", tasks: ["CREATE_CONTENT", "MANAGE"], access_token: `PAGE-TOKEN-${run}` },
          { id: PAGE2, name: "RoofCo Deals", tasks: ["CREATE_CONTENT"], access_token: `PAGE2-TOKEN-${run}` },
        ],
      },
    }),
  };
  const graph = mockMeta(new Proxy(routes, { get: (t, k: string) => t[k] }));
  const meta = { appId: "app", appSecret: "secret", redirectUri: "https://rnr.test/cb", fetch: graph.fetch, sleep: async () => {} };
  const adapters = { facebook_page: facebookPageAdapter(meta), instagram: instagramAdapter(meta) };
  const fetchImage = async (u: string): Promise<Fetched> => ({ url: u, status: 200, contentType: "image/jpeg", body: "", bytes: jpegBytes(1080, 1080), truncated: false });
  const publishDeps = { adapters, encryptionKey, fetchImage, unavailable: {} };
  const feedCalls = (page = PAGE) => graph.calls.filter((c) => c.method === "POST" && c.path === `/${page}/feed`).length;
  let feedSeq = 0;
  const postOk: Route = () => ({ body: { id: `${PAGE}_${++feedSeq}` } });

  // The model writes one Facebook draft per topic; `drafts` decides its text.
  let draftBody = (n: number) => `Gutter check number ${n}: clear leaves before the first freeze so water drains away from the roof edge.`;
  let drafted = 0;
  const text: TextProvider = {
    id: "mock",
    model: "mock-1",
    async generate(req: TextRequest) {
      if (req.schemaName === "topics")
        return { data: { topics: Array.from({ length: 5 }, (_, i) => ({ title: `${randomUUID().slice(0, 8)} ${randomUUID().slice(0, 8)} ${i}`, category: "seasonal", angle: "", service: "", location: "", needs_research: false, search_query: "" })) }, model: "mock-1", inputTokens: 100, outputTokens: 50 };
      drafted++;
      return { data: { title: `Draft ${drafted}`, core_message: "Gutters", used_source_ids: [], variants: [{ platform: "facebook_page", body: draftBody(drafted), hashtags: ["gutters"], link_url: "", call_to_action: "", image_concept: "" }] }, model: "mock-1", inputTokens: 1000, outputTokens: 200 };
    },
  };
  const contentDeps = { text, research: null, pricing: { inputPerMTok: 3, outputPerMTok: 15, researchPerCall: null } };

  const pub = (ctx: SocialContext) => publishService(client, ctx, { ...publishDeps, now: () => clock });
  const queue = (ctx: SocialContext) => queueService(client, ctx, { publish: pub(ctx), now: () => clock });
  const worker = (extra: Partial<WorkerDeps> = {}) => runWorker(client, { workerId: "w1", publish: publishDeps, content: contentDeps, now: () => clock, workspaceIds: [ctxA.workspaceId], ...extra });
  const at = (iso: string) => (clock = new Date(iso));

  async function one<T>(table: string, filter: Record<string, string>) {
    let q = client.from(table).select("*");
    for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
    const { data, error } = await q;
    assert.ifError(error);
    return (data as T[])[0];
  }
  const job = (variantId: string, account = fbAccount) => one<{ id: string; status: string; attempts: number; run_at: string; timezone: string; local_time: string; last_error: string | null; source: string }>("scheduled_jobs", { idempotency_key: jobKey(variantId, account) });
  const notes = async (kind: string) => ((await client.from("notifications").select("kind, title, body").eq("workspace_id", ctxA.workspaceId).eq("kind", kind)).data ?? []) as { title: string; body: string }[];

  async function approvedPost(opts: { account?: string | null; errors?: string[]; status?: string } = {}) {
    const n = ++postSeq;
    const { data: post, error } = await client.from("posts").insert({ workspace_id: ctxA.workspaceId, brand_id: brand, title: `Post ${n}`, status: opts.status ?? "approved", created_by: ctxA.email, approved_by: opts.status === "draft" ? null : ctxA.email, approved_at: opts.status === "draft" ? null : clock.toISOString() }).select("id").single();
    assert.ifError(error);
    const { data: v, error: e2 } = await client
      .from("post_variants")
      .insert({ workspace_id: ctxA.workspaceId, post_id: post!.id, platform: "facebook_page", social_account_id: opts.account === undefined ? fbAccount : opts.account, status: opts.status === "draft" ? "draft" : "approved", body: `Queue test post ${n} (${run}).`, hashtags: [], validation: { errors: opts.errors ?? [], warnings: [] } })
      .select("id")
      .single();
    assert.ifError(e2);
    return { postId: post!.id as string, variantId: v!.id as string };
  }

  before(async () => {
    client = createClient(url!, key!, { auth: { persistSession: false } });
    const ra = await resolveWorkspace(client, `owner-a-${run}@test.example`, { bootstrapOwner: true });
    const rb = await resolveWorkspace(client, `owner-b-${run}@test.example`, { bootstrapOwner: true });
    assert.ok(ra && rb);
    ctxA = ra.ctx;
    ctxB = rb.ctx;
    workspaceIds.push(ctxA.workspaceId, ctxB.workspaceId);
    assert.ifError((await client.from("workspace_members").insert({ workspace_id: ctxA.workspaceId, email: `editor-${run}@test.example`, role: "editor" })).error);
    editor = (await resolveWorkspace(client, `editor-${run}@test.example`))!.ctx;
    brand = (await socialRepo(client, ctxA).createBrand({ name: "RoofCo", niche: "Roofing", timezone: "America/New_York" })).id;
    assert.ifError((await client.from("brand_profiles").update({ status: "approved", approved_at: clock.toISOString(), approved_by: ctxA.email, business_name: "RoofCo", phone: "(512) 555-0100", services: ["Gutter cleaning"] }).eq("brand_id", brand)).error);

    const conns = connectionService(client, ctxA, { provider: metaConnect(meta), adapters, encryptionKey, now: () => clock });
    const connection = await conns.saveConnection({ userId: `u${run}`, userName: "Owner", token: `USER-${run}`, expiresAt: new Date(clock.getTime() + 60 * 864e5), scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"], declined: [] });
    await conns.discover(connection);
    const assets = await conns.listAssets();
    fbAccount = await conns.addAccount(assets.find((a) => a.name === "RoofCo")!.id, brand);
    spareAccount = await conns.addAccount(assets.find((a) => a.name === "RoofCo Deals")!.id, brand);
  });

  beforeEach(() => {
    routes[`POST /${PAGE}/feed`] = postOk;
    routes[`POST /${PAGE2}/feed`] = postOk;
  });

  after(async () => {
    if (workspaceIds.length) await client.from("workspaces").delete().in("id", workspaceIds);
  });

  test("scheduling stores UTC with the brand's time zone, and refuses the past, unapproved posts and editors", async () => {
    const { postId, variantId } = await approvedPost();
    const r = await queue(ctxA).schedule(variantId, "2026-10-27T09:00");
    const j = await job(variantId);
    assert.deepEqual([j.id, j.status, j.run_at.slice(0, 19), j.timezone, j.local_time, j.source], [r.jobId, "pending", "2026-10-27T13:00:00", "America/New_York", "2026-10-27 09:00", "schedule"]);
    assert.equal((await one<{ status: string }>("post_variants", { id: variantId })).status, "scheduled");
    assert.equal((await one<{ status: string }>("posts", { id: postId })).status, "scheduled");

    await assert.rejects(queue(ctxA).schedule(variantId, "2026-10-28T09:00"), /already in the queue/);
    const other = await approvedPost();
    await assert.rejects(queue(ctxA).schedule(other.variantId, "2026-10-27T09:00"), /Another post is already queued for RoofCo/);
    await assert.rejects(queue(ctxA).schedule(other.variantId, "2026-10-26T07:00"), /at least a minute from now/);
    await assert.rejects(queue(editor).schedule(other.variantId, "2026-10-27T10:00"), AccessDenied);
    const draft = await approvedPost({ status: "draft" });
    await assert.rejects(queue(ctxA).schedule(draft.variantId, "2026-10-27T10:00"), (e: PublishBlocked) => e.reasons.includes("Approve the post first."));
    const invalid = await approvedPost({ errors: ["Mentions a phone number that isn't in the brand profile."] });
    await assert.rejects(queue(ctxA).schedule(invalid.variantId, "2026-10-27T10:00"), /phone number/);
    assert.equal(feedCalls(), 0, "scheduling never posts");
    await queue(ctxA).cancel(r.jobId);
  });

  test("the worker publishes a due job once, even when two workers run at the same time", async () => {
    const { variantId } = await approvedPost();
    await queue(ctxA).schedule(variantId, "2026-10-26T10:00");
    const before = feedCalls();
    assert.equal((await worker()).published, 0, "not due yet");
    at("2026-10-26T14:01:00Z");
    const [a, b] = await Promise.all([worker({ workerId: "w1" }), worker({ workerId: "w2" })]);
    assert.equal(a.published + b.published, 1);
    assert.equal(feedCalls(), before + 1, "posted exactly once");
    const j = await job(variantId);
    assert.deepEqual([j.status, j.attempts], ["succeeded", 1]);
    assert.equal((await one<{ status: string }>("post_variants", { id: variantId })).status, "published");
    assert.equal((await worker()).published, 0, "a later run doesn't post again");
    const runs = (await client.from("worker_runs").select("worker, finished_at").in("worker", ["w1", "w2"]).order("id", { ascending: false }).limit(3)).data!;
    assert.ok(runs.every((r) => r.finished_at), "every run is recorded as finished");
  });

  test("pause, resume, reschedule, skip and cancel", async () => {
    at("2026-10-26T15:00:00Z");
    const a = await approvedPost();
    const { jobId } = await queue(ctxA).schedule(a.variantId, "2026-10-26T12:00");
    await queue(ctxA).pause(jobId);
    at("2026-10-26T17:00:00Z");
    await worker();
    assert.equal((await job(a.variantId)).status, "paused", "a paused job is never published");
    const { late } = await queue(ctxA).resume(jobId);
    assert.equal(late, true);
    await worker();
    assert.equal((await job(a.variantId)).status, "succeeded", "a late resumed job goes out at the next run");

    const b = await approvedPost();
    const jb = (await queue(ctxA).schedule(b.variantId, "2026-10-29T09:00")).jobId;
    await queue(ctxA).reschedule(jb, "2026-10-30T18:30");
    assert.equal((await job(b.variantId)).run_at.slice(0, 19), "2026-10-30T22:30:00");
    await queue(ctxA).skip(jb);
    assert.equal((await job(b.variantId)).status, "skipped");
    assert.equal((await one<{ status: string }>("post_variants", { id: b.variantId })).status, "approved", "skipping frees the slot");
    await queue(ctxA).cancel(jb);
    await assert.rejects(queue(ctxA).pause(jb), /queue changed/);
    await queue(ctxA).reschedule(jb, "2026-10-31T09:00");
    const back = await job(b.variantId);
    assert.deepEqual([back.status, back.local_time], ["pending", "2026-10-31 09:00"], "a cancelled post can be scheduled again");
    await queue(ctxA).cancel(jb);
  });

  test("pause-all and the per-brand and per-account switches stop publishing", async () => {
    const { variantId } = await approvedPost();
    await queue(ctxA).schedule(variantId, "2026-10-26T14:00");
    at("2026-10-26T18:05:00Z");
    const calls = feedCalls();

    await assert.rejects(queue(editor).setPaused(true), AccessDenied);
    await queue(ctxA).setPaused(true);
    assert.equal((await worker()).pausedWorkspaces, 1);
    await queue(ctxA).setPaused(false);
    await queue(ctxA).setBrandPaused(brand, true);
    await worker();
    await queue(ctxA).setBrandPaused(brand, false);
    await queue(ctxA).setAccountPaused(fbAccount, true);
    await worker();
    assert.equal(feedCalls(), calls, "nothing was posted while paused");
    assert.equal((await job(variantId)).status, "pending");
    await queue(ctxA).setAccountPaused(fbAccount, false);
    await worker();
    assert.equal((await job(variantId)).status, "succeeded");
  });

  test("temporary errors retry with backoff; other errors end in the dead-letter state with an alert", async () => {
    at("2026-10-27T12:00:00Z");
    const { variantId } = await approvedPost();
    await queue(ctxA).schedule(variantId, "2026-10-27T08:30");
    at("2026-10-27T12:31:00Z");
    // A failure before anything was posted (Instagram-style limit check) is transient; use a rate limit here.
    routes[`POST /${PAGE}/feed`] = () => graphError(400, 4, "Application request limit reached");
    await worker();
    let j = await job(variantId);
    assert.equal(j.status, "pending");
    assert.ok(new Date(j.run_at) > clock, "retried later, not now");
    // The account is rate limited: the next due run waits instead of failing.
    at(new Date(new Date(j.run_at).getTime() + 1000).toISOString());
    assert.ifError((await client.from("social_accounts").update({ rate_limited_until: new Date(clock.getTime() + 600_000).toISOString() }).eq("id", fbAccount)).error);
    await worker();
    j = await job(variantId);
    assert.equal(j.status, "pending");
    assert.equal(j.attempts, 1, "waiting for a rate limit uses no attempt");
    assert.ifError((await client.from("social_accounts").update({ rate_limited_until: null }).eq("id", fbAccount)).error);

    routes[`POST /${PAGE}/feed`] = () => graphError(400, 100, "Invalid parameter");
    at(new Date(new Date(j.run_at).getTime() + 1000).toISOString());
    await worker();
    j = await job(variantId);
    assert.equal(j.status, "dead");
    assert.match(j.last_error!, /rejected the post content/);
    assert.ok((await notes("publish_failed")).some((n) => n.title.includes("was not published to RoofCo")));
  });

  test("retries stop at the attempt limit", async () => {
    at("2026-10-27T18:00:00Z");
    const { variantId } = await approvedPost();
    await queue(ctxA).schedule(variantId, "2026-10-27T14:05");
    assert.ifError((await client.from("scheduled_jobs").update({ max_attempts: 2 }).eq("idempotency_key", jobKey(variantId, fbAccount))).error);
    routes[`POST /${PAGE}/feed`] = () => graphError(429, 17, "User request limit reached");
    for (let i = 0; i < 2; i++) {
      at(new Date(Math.max(clock.getTime(), new Date((await job(variantId)).run_at).getTime()) + 60_000).toISOString());
      assert.ifError((await client.from("social_accounts").update({ rate_limited_until: null }).eq("id", fbAccount)).error);
      await worker();
    }
    const j = await job(variantId);
    assert.deepEqual([j.status, j.attempts], ["dead", 2]);
    assert.ifError((await client.from("social_accounts").update({ rate_limited_until: null }).eq("id", fbAccount)).error);
  });

  test("an unclear result is never retried until the worker has checked the platform", async () => {
    at("2026-10-28T12:00:00Z");
    const { variantId } = await approvedPost();
    await queue(ctxA).schedule(variantId, "2026-10-28T08:10");
    at("2026-10-28T12:11:00Z");
    routes[`POST /${PAGE}/feed`] = () => graphError(503, 2, "Service temporarily unavailable");
    const calls = feedCalls();
    await worker();
    assert.equal((await job(variantId)).status, "needs_check");
    routes[`GET /${PAGE}/published_posts`] = () => ({ body: { data: [] } });
    routes[`POST /${PAGE}/feed`] = postOk;
    at("2026-10-28T12:12:00Z");
    await worker();
    assert.equal((await job(variantId)).status, "needs_check", "too soon to trust 'not found'");
    assert.equal(feedCalls(), calls + 1, "no blind retry");
    at("2026-10-28T12:20:00Z");
    const lookups = graph.calls.filter((c) => c.path === `/${PAGE}/published_posts`).length;
    await worker(); // checks: not there, so it goes back in the queue and is retried
    assert.ok(graph.calls.filter((c) => c.path === `/${PAGE}/published_posts`).length > lookups, "the platform was checked first");
    assert.equal((await job(variantId)).status, "succeeded");
    assert.equal((await job(variantId)).attempts, 2);
    assert.equal(feedCalls(), calls + 2);

    // When the check finds the post, it's marked published without posting again.
    const b = await approvedPost();
    await queue(ctxA).schedule(b.variantId, "2026-10-28T08:30");
    at("2026-10-28T12:31:00Z");
    routes[`POST /${PAGE}/feed`] = () => graphError(500, 1);
    await worker();
    routes[`GET /${PAGE}/published_posts`] = () => ({ body: { data: [{ id: `${PAGE}_found`, message: `Queue test post ${postSeq} (${run}).`, permalink_url: "https://www.facebook.com/roofco/posts/found" }] } });
    at("2026-10-28T12:40:00Z");
    const s = await worker();
    assert.equal(s.reconciled, 1);
    assert.equal((await job(b.variantId)).status, "succeeded");
    assert.equal(feedCalls(), calls + 3);
  });

  test("a worker that died mid-publish leaves the job for checking, never for a blind retry", async () => {
    at("2026-10-29T12:00:00Z");
    const started = await approvedPost();
    const notStarted = await approvedPost();
    await queue(ctxA).schedule(started.variantId, "2026-10-29T09:00");
    await queue(ctxA).schedule(notStarted.variantId, "2026-10-29T09:05");
    // Simulate a crash: both claimed 10 minutes ago; one had already started its attempt.
    const lock = { status: "claimed", attempts: 1, locked_at: "2026-10-29T13:10:00Z", locked_by: "dead-worker" };
    for (const v of [started, notStarted]) assert.ifError((await client.from("scheduled_jobs").update(lock).eq("idempotency_key", jobKey(v.variantId, fbAccount))).error);
    const j = await job(started.variantId);
    assert.ifError((await client.from("publish_attempts").insert({ workspace_id: ctxA.workspaceId, job_id: j.id, attempt_no: 1, started_at: "2026-10-29T13:10:01Z" })).error);
    at("2026-10-29T13:20:00Z");
    // The crashed attempt did reach Facebook.
    routes[`GET /${PAGE}/published_posts`] = () => ({ body: { data: [{ id: `${PAGE}_crash`, message: `Queue test post ${postSeq - 1} (${run}).`, permalink_url: "https://www.facebook.com/roofco/posts/crash" }] } });
    const calls = feedCalls();
    const s = await worker();
    assert.equal(s.recovered, 2);
    assert.equal(s.reconciled, 1, "found on the platform instead of being posted again");
    assert.equal((await job(started.variantId)).status, "succeeded");
    assert.equal((await one<{ outcome: string }>("publish_attempts", { job_id: j.id })).outcome, "reconciled");
    assert.equal((await job(notStarted.variantId)).status, "succeeded", "nothing had been sent, so it simply ran");
    assert.equal(feedCalls(), calls + 1, "only the job that never started was posted");
    assert.ok((await notes("publish_unclear")).length >= 1);
  });

  test("a disconnected account fails its own job with an alert; nothing moves to the brand's other account", async () => {
    at("2026-10-30T12:00:00Z");
    const { variantId } = await approvedPost();
    await queue(ctxA).schedule(variantId, "2026-10-30T09:00");
    assert.ifError((await client.from("social_accounts").update({ status: "needs_reconnect", last_error: "Token expired" }).eq("id", fbAccount)).error);
    at("2026-10-30T13:01:00Z");
    const spare = feedCalls(PAGE2);
    await worker();
    const j = await job(variantId);
    assert.equal(j.status, "dead");
    assert.match(j.last_error!, /needs to be reconnected/);
    assert.equal(feedCalls(PAGE2), spare, "the other Page was never used");
    assert.ok((await notes("account_disconnected")).length >= 1);
    assert.ifError((await client.from("social_accounts").update({ status: "connected", last_error: null }).eq("id", fbAccount)).error);
  });

  test("content that fails validation, or was edited, is never published from the queue", async () => {
    at("2026-10-31T12:00:00Z");
    const bad = await approvedPost();
    await queue(ctxA).schedule(bad.variantId, "2026-10-31T09:00");
    assert.ifError((await client.from("post_variants").update({ validation: { errors: ["Mentions a phone number that isn't in the brand profile."], warnings: [] } }).eq("id", bad.variantId)).error);

    const edited = await approvedPost();
    await queue(ctxA).schedule(edited.variantId, "2026-10-31T09:05");
    await contentService(client, editor, contentDeps).updateVariant(edited.variantId, { body: "An edited queue test post about gutters and downpipes.", hashtags: [], link_url: null });
    assert.equal((await job(edited.variantId)).status, "cancelled");
    assert.equal((await one<{ status: string }>("posts", { id: edited.postId })).status, "draft");

    const calls = feedCalls();
    at("2026-10-31T13:10:00Z");
    await worker();
    const j = await job(bad.variantId);
    assert.equal(j.status, "dead");
    assert.match(j.last_error!, /phone number/);
    assert.equal(feedCalls(), calls, "neither post was sent");
  });

  test("the daily limit holds back further posts with an alert", async () => {
    at("2026-11-02T12:00:00Z");
    await queue(ctxA).saveLimits({ daily_post_limit: 1, monthly_post_limit: 100, daily_ai_cost_limit_usd: 5 });
    const a = await approvedPost();
    const b = await approvedPost();
    await queue(ctxA).schedule(a.variantId, "2026-11-02T08:00");
    await queue(ctxA).schedule(b.variantId, "2026-11-02T08:01");
    at("2026-11-02T13:05:00Z");
    assert.equal((await worker()).published, 1);
    assert.deepEqual([(await job(a.variantId)).status, (await job(b.variantId)).status], ["succeeded", "pending"]);
    assert.equal((await worker()).limitedWorkspaces, 1);
    assert.ok((await notes("limit_reached")).length >= 1);
    at("2026-11-03T05:01:00Z"); // next UTC day
    assert.equal((await worker()).published, 1);
    await queue(ctxA).saveLimits({ daily_post_limit: 50, monthly_post_limit: 500, daily_ai_cost_limit_usd: 5 });
  });

  test("approval-required automation writes drafts and queues approved posts into the brand's slots", async () => {
    at("2026-11-09T12:00:00Z"); // Monday 07:00 in New York
    // Clear leftovers from earlier tests so only this test's posts compete for slots.
    assert.ifError((await client.from("posts").update({ status: "cancelled" }).eq("brand_id", brand).in("status", ["draft", "approved", "failed"])).error);
    await queue(ctxA).saveBrandAutomation(brand, { enabled: true, mode: "approval_required", days_of_week: [1, 3, 5], times: ["09:00"], posts_per_week: 2, categories: ["seasonal"], confirm_full_auto: false });
    const before = drafted;
    const s = await worker();
    assert.ok(s.generated >= 1 && drafted > before, "drafts were written");
    const drafts = (await client.from("posts").select("id, status, created_by").eq("brand_id", brand).eq("created_by", AUTOMATION_ACTOR)).data!;
    assert.ok(drafts.length >= 1 && drafts.every((p) => p.status === "draft"), "nothing is approved automatically in this mode");
    assert.equal((await client.from("scheduled_jobs").select("id").eq("brand_id", brand).eq("source", "automation")).data!.length, 0);

    // A person approves three posts; this week only has room for two.
    const svc = contentService(client, ctxA, contentDeps);
    const generatedIds = drafts.map((d) => d.id);
    const manual = [await approvedPost({ account: null }), await approvedPost({ account: null })];
    for (const id of generatedIds.slice(0, 1)) await svc.approvePost(id);
    // The brand has two Facebook Pages, so a version without an account isn't guessed.
    await worker();
    assert.ok((await notes("needs_account")).length >= 1);
    for (const m of manual) await pub(ctxA).assignAccount(m.variantId, fbAccount);
    const generatedVariant = (await client.from("post_variants").select("id").eq("post_id", generatedIds[0])).data![0].id as string;
    await pub(ctxA).assignAccount(generatedVariant, fbAccount);
    await worker();
    const queued = (await client.from("scheduled_jobs").select("local_time, timezone, run_at").eq("brand_id", brand).eq("source", "automation").in("status", ["pending"]).order("run_at")).data!;
    assert.deepEqual(queued.map((q) => q.local_time), ["2026-11-09 09:00", "2026-11-11 09:00"], "two slots this week, in New York time");
    assert.equal(queued[0].run_at.slice(0, 19), "2026-11-09T14:00:00");

    // Skipping a slot frees it, and the skipped post isn't requeued unless it is approved again.
    const first = (await queue(ctxA).list("upcoming")).find((q) => q.local_time === "2026-11-09 09:00")!;
    await queue(ctxA).skip(first.id);
    await worker();
    const after = (await client.from("scheduled_jobs").select("id, local_time, status").eq("brand_id", brand).eq("source", "automation").eq("status", "pending")).data!;
    assert.ok(!after.some((q) => q.id === first.id), "the skipped post stays out");
    assert.ok(after.some((q) => q.local_time === "2026-11-09 09:00"), "another approved post took the free slot");
  });

  test("fully automatic needs an explicit opt-in, and only drafts that pass every check are approved", async () => {
    await assert.rejects(queue(ctxA).saveBrandAutomation(brand, { enabled: true, mode: "fully_automatic", days_of_week: [2], times: ["11:00"], posts_per_week: 3, categories: [], confirm_full_auto: false }), /Tick the confirmation box/);
    await assert.rejects(queue(editor).saveBrandAutomation(brand, { enabled: true, mode: "fully_automatic", days_of_week: [2], times: ["11:00"], posts_per_week: 3, categories: [], confirm_full_auto: true }), AccessDenied);
    await queue(ctxA).saveBrandAutomation(brand, { enabled: true, mode: "fully_automatic", days_of_week: [2, 4], times: ["11:00"], posts_per_week: 3, categories: [], confirm_full_auto: true });
    const row = await one<{ full_auto_confirmed_by: string }>("brand_automation", { brand_id: brand });
    assert.equal(row.full_auto_confirmed_by, ctxA.email);
    // One account per platform makes the target obvious.
    await connectionService(client, ctxA, { provider: metaConnect(meta), adapters, encryptionKey }).disconnectAccount(spareAccount);

    at("2026-11-16T12:00:00Z");
    assert.ifError((await client.from("posts").update({ status: "cancelled" }).eq("brand_id", brand).in("status", ["draft", "approved", "failed"])).error);
    // The first draft quotes a phone number the brand never confirmed; the second is clean.
    const firstNew = drafted + 1;
    draftBody = (n) => (n === firstNew ? "Call (999) 555-0000 today for a free gutter check before winter storms arrive in town." : `Clean gutters keep water off the fascia. Check yours this week, draft ${n}.`);
    const st = await worker({ generateEverySeconds: 0 });
    assert.equal(st.generated, 2, JSON.stringify(st));
    const autos = (await client.from("posts").select("id, status, approved_by").eq("brand_id", brand).eq("created_by", AUTOMATION_ACTOR).gte("created_at", "2000-01-01").order("created_at", { ascending: false }).limit(3)).data!;
    assert.ok(autos.some((p) => p.status === "draft"), "the draft with a problem waits for a person");
    assert.ok(autos.some((p) => ["approved", "scheduled"].includes(p.status) && p.approved_by === AUTOMATION_ACTOR), "the clean draft was approved by automation");
    assert.ok((await notes("draft_needs_review")).length >= 1);
    await queue(ctxA).saveBrandAutomation(brand, { enabled: false, mode: "draft_only", days_of_week: [1], times: ["09:00"], posts_per_week: 1, categories: [], confirm_full_auto: false });
    assert.equal((await one<{ full_auto_confirmed_by: string | null }>("brand_automation", { brand_id: brand })).full_auto_confirmed_by, null, "leaving full automation clears the opt-in");
  });

  test("another workspace can't see or change this queue", async () => {
    const items = await queue(ctxA).list("done");
    assert.ok(items.length > 0);
    assert.deepEqual(await queue(ctxB).list("done"), []);
    await assert.rejects(queue(ctxB).cancel(items[0].id), /queue changed/);
    await assert.rejects(queue(ctxB).reschedule(items[0].id, "2027-01-01T09:00"), NotFound);
    await assert.rejects(queue(ctxB).setBrandPaused(brand, true), NotFound);
    assert.deepEqual(await queue(ctxB).notifications(), []);
  });
});
