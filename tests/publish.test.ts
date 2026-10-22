// Connecting Meta accounts and publishing against a real database, with the Graph API mocked.
//   SOCIAL_TEST_SUPABASE_URL=http://localhost:54321 SOCIAL_TEST_SUPABASE_KEY=<service role key> npm test
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveWorkspace, socialRepo, type SocialContext } from "../src/lib/social/repo";
import { AccessDenied, NotFound } from "../src/lib/social/policy";
import { connectionService } from "../src/lib/social/publish/connections";
import { publishService, PublishBlocked, jobKey } from "../src/lib/social/publish/service";
import { facebookPageAdapter, instagramAdapter, metaConnect } from "../src/lib/social/publish/meta";
import type { Fetched } from "../src/lib/social/safeFetch";
import { graphError, jpegBytes, mockMeta } from "./support/mock-meta";

const url = process.env.SOCIAL_TEST_SUPABASE_URL;
const key = process.env.SOCIAL_TEST_SUPABASE_KEY;

type Route = Parameters<typeof mockMeta>[0][string];

describe("Meta connections and publishing", { skip: !url || !key ? "set SOCIAL_TEST_SUPABASE_URL and SOCIAL_TEST_SUPABASE_KEY" : false }, () => {
  let client: SupabaseClient;
  const run = randomUUID().slice(0, 8);
  const encryptionKey = randomBytes(32).toString("base64");
  const USER_TOKEN = `USER-TOKEN-${run}`;
  const PAGE_TOKEN = `PAGE-TOKEN-${run}`;
  let ctxA: SocialContext, ctxB: SocialContext, editor: SocialContext;
  let brandA: string, brandB: string, connectionId: string;
  let fbAccount: string, igAccount: string;
  const workspaceIds: string[] = [];
  let clock = new Date();

  // Routes can be swapped per test; every Graph call is recorded.
  const routes: Record<string, Route> = {
    "GET /me/accounts": () => ({
      body: {
        data: [
          { id: `p1${run}`, name: "RoofCo", tasks: ["CREATE_CONTENT", "MANAGE"], access_token: PAGE_TOKEN, instagram_business_account: { id: `ig1${run}`, username: "roofco" } },
          { id: `p2${run}`, name: "Second Page", tasks: ["CREATE_CONTENT"], access_token: `${PAGE_TOKEN}-2` },
        ],
      },
    }),
    "DELETE /u1/permissions": () => ({ body: { success: true } }),
  };
  const graph = mockMeta(new Proxy(routes, { get: (t, k: string) => t[k] }));
  const meta = { appId: "app", appSecret: "secret", redirectUri: "https://rnr.test/cb", fetch: graph.fetch, sleep: async () => {} };
  const adapters = { facebook_page: facebookPageAdapter(meta), instagram: instagramAdapter(meta) };
  const image: { bytes: Buffer } = { bytes: jpegBytes(1080, 1080) };
  const fetchImage = async (u: string): Promise<Fetched> => ({ url: u, status: 200, contentType: "image/jpeg", body: "", bytes: image.bytes, truncated: false });

  const conns = (ctx: SocialContext) => connectionService(client, ctx, { provider: metaConnect(meta), adapters, encryptionKey, now: () => clock });
  const pub = (ctx: SocialContext) => publishService(client, ctx, { adapters, encryptionKey, fetchImage, now: () => clock, unavailable: { x: "Not built yet." } });
  const graphCalls = (path: string) => graph.calls.filter((c) => c.path === path).length;

  async function one<T>(table: string, filter: Record<string, string>) {
    let q = client.from(table).select("*");
    for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
    const { data, error } = await q;
    assert.ifError(error);
    return (data as T[])[0];
  }

  // An approved post with one version for `platform`, assigned to `accountId`.
  async function approvedPost(platform: string, accountId: string | null, opts: { body?: string; errors?: string[]; status?: string; image?: string } = {}) {
    const { data: post, error } = await client.from("posts").insert({ workspace_id: ctxA.workspaceId, brand_id: brandA, title: `Post ${randomUUID().slice(0, 4)}`, status: opts.status ?? "approved", created_by: ctxA.email }).select("id").single();
    assert.ifError(error);
    const { data: v, error: e2 } = await client
      .from("post_variants")
      .insert({
        workspace_id: ctxA.workspaceId, post_id: post!.id, platform, social_account_id: accountId, status: opts.status === "draft" ? "draft" : "approved",
        body: opts.body ?? `Clear your gutters before winter (${randomUUID().slice(0, 6)}).`, hashtags: ["gutters"], image_url: opts.image ?? null,
        validation: { errors: opts.errors ?? [], warnings: [] },
      })
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
    const repo = socialRepo(client, ctxA);
    brandA = (await repo.createBrand({ name: "RoofCo", niche: null, timezone: "UTC" })).id;
    brandB = (await repo.createBrand({ name: "Other", niche: null, timezone: "UTC" })).id;
  });

  after(async () => {
    if (workspaceIds.length) await client.from("workspaces").delete().in("id", workspaceIds);
  });

  test("connecting stores tokens encrypted and lists Pages and Instagram accounts without tokens", async () => {
    const user = { userId: "u1", userName: "Shahzaib", token: USER_TOKEN, expiresAt: new Date(Date.now() + 60 * 86400_000), scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish"], declined: [] };
    await assert.rejects(conns(editor).saveConnection(user), AccessDenied);
    connectionId = await conns(ctxA).saveConnection(user);
    const { count } = await conns(ctxA).discover(connectionId);
    assert.equal(count, 3);

    const cred = await one<{ user_token_enc: string }>("meta_connection_credentials", { connection_id: connectionId });
    assert.match(cred.user_token_enc, /^v1:/);
    assert.ok(!cred.user_token_enc.includes(USER_TOKEN));
    const assets = await conns(ctxA).listAssets();
    assert.deepEqual(assets.map((a) => [a.platform, a.name]).sort(), [["facebook_page", "RoofCo"], ["facebook_page", "Second Page"], ["instagram", "roofco"]]);
    assert.ok(!JSON.stringify(assets).includes(PAGE_TOKEN), "pages never receive tokens");
    assert.ok(!JSON.stringify(await conns(ctxA).listConnections()).includes(USER_TOKEN));
    assert.deepEqual(await conns(ctxB).listAssets(), [], "other workspaces see nothing");
  });

  test("adding accounts to a brand: one brand per account, nothing across workspaces", async () => {
    const assets = await conns(ctxA).listAssets();
    const fb = assets.find((a) => a.name === "RoofCo")!;
    const ig = assets.find((a) => a.platform === "instagram")!;
    await assert.rejects(conns(editor).addAccount(fb.id, brandA), AccessDenied);
    await assert.rejects(conns(ctxB).addAccount(fb.id, brandA), NotFound);
    fbAccount = await conns(ctxA).addAccount(fb.id, brandA);
    igAccount = await conns(ctxA).addAccount(ig.id, brandA);
    await assert.rejects(conns(ctxA).addAccount(fb.id, brandB), /already connected to another brand/);

    const accounts = await conns(ctxA).listAccounts(brandA);
    const fbRow = accounts.find((a) => a.id === fbAccount)!;
    assert.deepEqual(fbRow.permitted_actions, ["publish_text", "publish_link", "publish_image", "read_metrics"]);
    assert.deepEqual(accounts.find((a) => a.id === igAccount)!.permitted_actions, ["publish_image", "read_metrics"]);
    const cred = await one<{ access_token_enc: string }>("social_account_credentials", { social_account_id: fbAccount });
    assert.ok(cred.access_token_enc.startsWith("v1:") && !cred.access_token_enc.includes(PAGE_TOKEN));
  });

  test("nothing is published without approval, a clean validation, the right account and permission", async () => {
    const before = graph.calls.length;
    const draft = await approvedPost("facebook_page", fbAccount, { status: "draft" });
    await assert.rejects(pub(ctxA).publishNow(draft.variantId), (e: PublishBlocked) => e.reasons.includes("Approve the post first."));
    const invalid = await approvedPost("facebook_page", fbAccount, { errors: ["Contains a statistic or figure with no research source attached."] });
    await assert.rejects(pub(ctxA).publishNow(invalid.variantId), (e: PublishBlocked) => e.reasons.some((r) => r.includes("statistic")));
    const unassigned = await approvedPost("facebook_page", null);
    await assert.rejects(pub(ctxA).publishNow(unassigned.variantId), /Choose which account/);
    const x = await approvedPost("x", null);
    await assert.rejects(pub(ctxA).publishNow(x.variantId), /Not built yet/);
    await assert.rejects(pub(editor).publishNow(unassigned.variantId), AccessDenied);
    await assert.rejects(pub(ctxA).assignAccount(unassigned.variantId, igAccount), /Choose a Facebook Page account/);
    assert.equal(graph.calls.length, before, "the platform was never called");
    assert.equal((await client.from("scheduled_jobs").select("id").eq("workspace_id", ctxA.workspaceId)).data!.length, 0, "no jobs were created");
  });

  test("publishing records the platform's id and link once, even if pressed twice", async () => {
    routes["POST /p1" + run + "/feed"] = () => ({ body: { id: `p1${run}_100` }, headers: { "x-app-usage": '{"call_count":10}' } });
    const { postId, variantId } = await approvedPost("facebook_page", fbAccount);
    const r = await pub(ctxA).publishNow(variantId);
    assert.equal(r.outcome, "published");
    assert.equal(r.url, `https://www.facebook.com/p1${run}_100`);
    const again = await pub(ctxA).publishNow(variantId);
    assert.equal(again.outcome, "already_published");
    assert.equal(graphCalls(`/p1${run}/feed`), 1, "posted exactly once");
    const call = graph.calls.find((c) => c.path === `/p1${run}/feed`)!;
    assert.equal(call.params.get("access_token"), PAGE_TOKEN, "the decrypted Page token is used");

    const v = await one<Record<string, unknown>>("post_variants", { id: variantId });
    assert.deepEqual([v.status, v.external_post_id], ["published", `p1${run}_100`]);
    assert.ok(v.published_at);
    assert.equal((await one<{ status: string }>("posts", { id: postId })).status, "published");
    const job = await one<Record<string, unknown>>("scheduled_jobs", { idempotency_key: jobKey(variantId, fbAccount) });
    assert.deepEqual([job.status, job.attempts, job.external_post_id], ["succeeded", 1, `p1${run}_100`]);
    const attempt = await one<Record<string, unknown>>("publish_attempts", { job_id: String(job.id) });
    assert.equal(attempt.outcome, "success");
    assert.ok(!JSON.stringify(attempt).includes(PAGE_TOKEN), "stored responses hold no tokens");
  });

  test("two simultaneous publish requests post once", async () => {
    routes["POST /p1" + run + "/feed"] = () => ({ body: { id: `p1${run}_race` } });
    const { variantId } = await approvedPost("facebook_page", fbAccount, { body: "Race test post." });
    const before = graphCalls(`/p1${run}/feed`);
    const results = await Promise.allSettled([pub(ctxA).publishNow(variantId), pub(ctxA).publishNow(variantId)]);
    assert.equal(graphCalls(`/p1${run}/feed`), before + 1);
    assert.equal(results.filter((r) => r.status === "fulfilled" && r.value.outcome === "published").length, 1);
    const jobs = (await client.from("scheduled_jobs").select("id").eq("variant_id", variantId)).data!;
    assert.equal(jobs.length, 1);
  });

  test("an unclear answer is never retried until checked, then settled by looking on the platform", async () => {
    const { variantId } = await approvedPost("facebook_page", fbAccount, { body: "Unclear answer test post." });
    routes[`POST /p1${run}/feed`] = () => graphError(503, 2, "Service temporarily unavailable");
    const posts = graphCalls(`/p1${run}/feed`);
    const r = await pub(ctxA).publishNow(variantId);
    assert.equal(r.outcome, "needs_check");
    const job = await one<{ id: string; status: string }>("scheduled_jobs", { idempotency_key: jobKey(variantId, fbAccount) });
    assert.equal(job.status, "needs_check");
    await assert.rejects(pub(ctxA).publishNow(variantId), (e: PublishBlocked) => /may have posted/.test(e.message));
    assert.equal(graphCalls(`/p1${run}/feed`), posts + 1, "no automatic retry");

    // Not visible yet, too soon to trust: wait.
    routes[`GET /p1${run}/published_posts`] = () => ({ body: { data: [] } });
    assert.equal((await pub(ctxA).checkJob(job.id)).outcome, "wait");
    // It shows up: the job is settled as published without posting again.
    routes[`GET /p1${run}/published_posts`] = () => ({ body: { data: [{ id: `p1${run}_200`, message: "Unclear answer test post.\n\n#gutters", permalink_url: "https://www.facebook.com/roofco/posts/200" }] } });
    const checked = await pub(ctxA).checkJob(job.id);
    assert.deepEqual(checked, { outcome: "published", url: "https://www.facebook.com/roofco/posts/200" });
    assert.equal((await one<{ status: string }>("post_variants", { id: variantId })).status, "published");
    const attempt = await one<{ outcome: string; external_post_id: string }>("publish_attempts", { job_id: job.id });
    assert.deepEqual([attempt.outcome, attempt.external_post_id], ["reconciled", `p1${run}_200`]);
    assert.equal(graphCalls(`/p1${run}/feed`), posts + 1);
  });

  test("when the check finds nothing after waiting, a retry is allowed and uses the same job", async () => {
    const { variantId } = await approvedPost("facebook_page", fbAccount, { body: "Second unclear test post." });
    routes[`POST /p1${run}/feed`] = () => graphError(500, 1);
    await pub(ctxA).publishNow(variantId);
    const job = await one<{ id: string }>("scheduled_jobs", { idempotency_key: jobKey(variantId, fbAccount) });
    routes[`GET /p1${run}/published_posts`] = () => ({ body: { data: [] } });
    clock = new Date(clock.getTime() + 5 * 60_000);
    assert.equal((await pub(ctxA).checkJob(job.id)).outcome, "not_found");
    routes[`POST /p1${run}/feed`] = () => ({ body: { id: `p1${run}_300` } });
    assert.equal((await pub(ctxA).publishNow(variantId)).outcome, "published");
    const after = await one<{ status: string; attempts: number }>("scheduled_jobs", { id: job.id });
    assert.deepEqual([after.status, after.attempts], ["succeeded", 2]);
  });

  test("an expired token marks the account for reconnecting and blocks further posts; nothing switches accounts", async () => {
    const second = (await conns(ctxA).listAssets()).find((a) => a.name === "Second Page")!;
    const spare = await conns(ctxA).addAccount(second.id, brandA);
    routes[`POST /p1${run}/feed`] = () => graphError(400, 190, "Error validating access token");
    const { variantId } = await approvedPost("facebook_page", fbAccount);
    const r = await pub(ctxA).publishNow(variantId);
    assert.deepEqual([r.outcome, (r as { kind: string }).kind], ["failed", "auth"]);
    assert.equal((await one<{ status: string }>("social_accounts", { id: fbAccount })).status, "needs_reconnect");
    await assert.rejects(pub(ctxA).publishNow(variantId), /needs to be reconnected/);
    assert.equal(graph.calls.filter((c) => c.path === `/p2${run}/feed`).length, 0, "the other Page of the brand was never used");
    await conns(ctxA).disconnectAccount(spare);
  });

  test("rate limits pause the account until Meta says it's safe", async () => {
    // Rediscovery refreshes the token and puts the first Page back in service.
    await conns(ctxA).discover(connectionId);
    assert.equal((await one<{ status: string }>("social_accounts", { id: fbAccount })).status, "connected");
    routes[`POST /p1${run}/feed`] = () => graphError(400, 32, "Page request limit reached");
    const { variantId } = await approvedPost("facebook_page", fbAccount);
    assert.equal((await pub(ctxA).publishNow(variantId)).outcome, "failed");
    const acc = await one<{ rate_limited_until: string }>("social_accounts", { id: fbAccount });
    assert.ok(new Date(acc.rate_limited_until) > clock);
    await assert.rejects(pub(ctxA).publishNow(variantId), /rate limited/);
    assert.ifError((await client.from("social_accounts").update({ rate_limited_until: null }).eq("id", fbAccount)).error);
  });

  test("Instagram needs a checked JPEG; changing the image needs approval again", async () => {
    const { postId, variantId } = await approvedPost("instagram", igAccount);
    await assert.rejects(pub(ctxA).publishNow(variantId), /need an image/);
    image.bytes = jpegBytes(1080, 1920);
    const tall = await pub(editor).setImage(variantId, "https://cdn.test/tall.jpg");
    assert.equal(tall?.ok, false);
    image.bytes = jpegBytes(1080, 1350);
    assert.equal((await pub(editor).setImage(variantId, "https://cdn.test/ok.jpg"))?.ok, true);
    assert.equal((await one<{ status: string }>("posts", { id: postId })).status, "draft", "media changes need re-approval");
    assert.ifError((await client.from("posts").update({ status: "approved" }).eq("id", postId)).error);

    routes[`GET /ig1${run}/content_publishing_limit`] = () => ({ body: { data: [{ quota_usage: 1, config: { quota_total: 100 } }] } });
    routes[`POST /ig1${run}/media`] = () => ({ body: { id: `c${run}` } });
    routes[`GET /c${run}`] = () => ({ body: { status_code: "FINISHED" } });
    routes[`POST /ig1${run}/media_publish`] = () => ({ body: { id: `m${run}` } });
    routes[`GET /m${run}`] = (p) => (p.get("fields") === "permalink" ? { body: { permalink: "https://www.instagram.com/p/xyz/" } } : { body: { comments_count: 3 } });
    // The image is fetched again at publish time, so a swapped file is caught.
    image.bytes = jpegBytes(1080, 1920);
    await assert.rejects(pub(ctxA).publishNow(variantId), /between 4:5/);
    image.bytes = jpegBytes(1080, 1350);
    const r = await pub(ctxA).publishNow(variantId);
    assert.deepEqual([r.outcome, r.url], ["published", "https://www.instagram.com/p/xyz/"]);
    assert.equal(graph.calls.find((c) => c.path === `/ig1${run}/media`)!.params.get("image_url"), "https://cdn.test/ok.jpg");

    const metrics = await pub(ctxA).refreshMetrics(variantId);
    assert.deepEqual(metrics, { likes: null, comments: 3 }, "hidden like counts stay unavailable, not zero");
  });

  test("revoking the Meta login revokes at Meta and deletes every token", async () => {
    await assert.rejects(conns(editor).revokeConnection(connectionId), AccessDenied);
    const r = await conns(ctxA).revokeConnection(connectionId);
    assert.equal(r.revokedAtMeta, true);
    assert.equal(graph.calls.filter((c) => c.method === "DELETE" && c.path === "/u1/permissions").length, 1);
    for (const id of [fbAccount, igAccount]) {
      assert.equal((await one<{ status: string }>("social_accounts", { id })).status, "revoked");
      assert.equal(await one("social_account_credentials", { social_account_id: id }), undefined);
    }
    assert.equal(await one("meta_connection_credentials", { connection_id: connectionId }), undefined);
    assert.equal((await client.from("meta_asset_credentials").select("asset_id").eq("workspace_id", ctxA.workspaceId)).data!.length, 0);
    const { variantId } = await approvedPost("facebook_page", fbAccount);
    await assert.rejects(pub(ctxA).publishNow(variantId), /reconnected \(revoked\)/);
  });
});
