// Meta adapters against a mocked Graph API: OAuth, discovery, publishing, error handling and metrics.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { classifyGraphError, facebookPageAdapter, instagramAdapter, metaConnect, permittedActions, readUsage, redact } from "../src/lib/social/publish/meta";
import { PublishError } from "../src/lib/social/publish/types";
import { graphError, mockMeta } from "./support/mock-meta";

const app = (fetch: typeof globalThis.fetch) => ({ appId: "app-1", appSecret: "app-secret", redirectUri: "https://rnr.test/api/social/meta/callback", fetch, sleep: async () => {} });
const cred = { externalAccountId: "123", token: "PAGE-TOKEN" };
const input = { body: "Check your gutters before winter.", hashtags: ["gutters"], link: "https://roofco.test/gutters", imageUrl: null };

describe("Meta errors", () => {
  test("codes map to what the service should do", () => {
    assert.equal(classifyGraphError(400, { code: 190 }, false), "auth");
    assert.equal(classifyGraphError(403, { code: 200 }, false), "permission");
    assert.equal(classifyGraphError(400, { code: 10 }, false), "permission");
    assert.equal(classifyGraphError(400, { code: 4 }, true), "rate_limit");
    assert.equal(classifyGraphError(400, { code: 32 }, false), "rate_limit");
    assert.equal(classifyGraphError(400, { code: 9, error_subcode: 2207042 }, true), "rate_limit");
    assert.equal(classifyGraphError(400, { code: 368 }, true), "policy");
    assert.equal(classifyGraphError(400, { code: 100, error_subcode: 2207026 }, false), "media");
    assert.equal(classifyGraphError(400, { code: 100 }, true), "validation");
    assert.equal(classifyGraphError(500, { code: 2 }, false), "transient");
    assert.equal(classifyGraphError(500, { code: 2 }, true), "ambiguous", "a server error while posting may have posted");
    assert.equal(classifyGraphError(503, undefined, true), "ambiguous");
  });

  test("usage headers and redaction", () => {
    const h = new Headers({ "x-app-usage": '{"call_count":40,"total_time":12,"total_cputime":8}', "x-business-use-case-usage": '{"123":[{"type":"pages","call_count":97,"total_time":5,"total_cputime":5,"estimated_time_to_regain_access":3}]}' });
    assert.deepEqual(readUsage(h), { percent: 97, regainSeconds: 180 });
    assert.equal(readUsage(new Headers()), null);
    assert.deepEqual(redact({ id: "1", access_token: "x", nested: [{ page_token: "y", name: "ok" }], appsecret_proof: "z" }), { id: "1", nested: [{ name: "ok" }] });
  });
});

describe("connecting", () => {
  test("login URL asks only for the needed permissions and carries state", () => {
    const url = new URL(metaConnect(app(fetch)).authorizationUrl("STATE-1"));
    assert.equal(url.origin + url.pathname, "https://www.facebook.com/v26.0/dialog/oauth");
    assert.equal(url.searchParams.get("state"), "STATE-1");
    assert.equal(url.searchParams.get("redirect_uri"), "https://rnr.test/api/social/meta/callback");
    assert.deepEqual(url.searchParams.get("scope")!.split(","), ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish"]);
    assert.equal(url.searchParams.get("client_secret"), null);
  });

  test("code exchange gets a long-lived token and the granted and declined permissions", async () => {
    const m = mockMeta({
      "GET /oauth/access_token": (p) => (p.get("code") ? { body: { access_token: "SHORT", expires_in: 3600 } } : { body: { access_token: "LONG", expires_in: 5184000 } }),
      "GET /me": () => ({ body: { id: "u1", name: "Shahzaib" } }),
      "GET /me/permissions": () => ({ body: { data: [{ permission: "pages_manage_posts", status: "granted" }, { permission: "instagram_content_publish", status: "declined" }] } }),
    });
    const user = await metaConnect(app(m.fetch)).exchangeCode("CODE");
    assert.equal(user.token, "LONG");
    assert.deepEqual([user.userId, user.scopes, user.declined], ["u1", ["pages_manage_posts"], ["instagram_content_publish"]]);
    assert.ok(user.expiresAt && user.expiresAt.getTime() > Date.now() + 50 * 86400_000);
    const second = m.calls.find((c) => c.params.get("grant_type") === "fb_exchange_token")!;
    assert.equal(second.params.get("fb_exchange_token"), "SHORT");
    const me = m.calls.find((c) => c.path === "/me")!;
    assert.equal(me.params.get("appsecret_proof"), createHmac("sha256", "app-secret").update("LONG").digest("hex"));
  });

  test("discovery lists Pages and linked Instagram accounts, following paging", async () => {
    // The first page links to a second one; the link carries a token that must not be reused.
    let n = 0;
    const paged = mockMeta({
      "GET /me/accounts": () =>
        ++n === 1
          ? { body: { data: [{ id: "p1", name: "RoofCo", tasks: ["CREATE_CONTENT"], access_token: "PT1", picture: { data: { url: "https://cdn.test/p1.jpg" } }, instagram_business_account: { id: "ig1", username: "roofco" } }], paging: { next: "https://graph.facebook.com/v26.0/me/accounts?after=X&access_token=LEAK" } } }
          : { body: { data: [{ id: "p2", name: "No Token Page" }, { id: "p3", name: "Plumbing", tasks: ["ANALYZE"], access_token: "PT3" }] } },
    });
    const found = await metaConnect(app(paged.fetch)).discover("USER");
    assert.deepEqual(found.map((f) => [f.platform, f.externalAccountId, f.pageId]), [["facebook_page", "p1", "p1"], ["instagram", "ig1", "p1"], ["facebook_page", "p3", "p3"]]);
    assert.equal(found[1].pageToken, "PT1", "Instagram publishes with its Page's token");
    assert.equal(paged.calls[1].params.get("after"), "X");
    assert.equal(paged.calls[1].params.getAll("access_token").length, 1, "the leaked token in the paging URL isn't reused");
    assert.equal(paged.calls[1].params.get("access_token"), "USER");
  });

  test("permitted actions follow scopes and Page tasks", () => {
    const all = ["pages_manage_posts", "pages_read_engagement", "instagram_content_publish", "instagram_basic"];
    assert.deepEqual(permittedActions("facebook_page", all, ["CREATE_CONTENT"]), ["publish_text", "publish_link", "publish_image", "read_metrics"]);
    assert.deepEqual(permittedActions("facebook_page", all, ["ANALYZE"]), ["read_metrics"]);
    assert.deepEqual(permittedActions("instagram", ["instagram_basic"], ["MANAGE"]), ["read_metrics"]);
    assert.deepEqual(permittedActions("instagram", all, ["MANAGE"]), ["publish_image", "read_metrics"]);
  });

  test("revoke deletes the app's permissions for the user", async () => {
    const m = mockMeta({ "DELETE /u1/permissions": () => ({ body: { success: true } }) });
    await metaConnect(app(m.fetch)).revoke("USER", "u1");
    assert.equal(m.calls[0].method, "DELETE");
  });
});

describe("Facebook Page publishing", () => {
  test("text and link posts go to /feed with hashtags appended", async () => {
    const m = mockMeta({ "POST /123/feed": () => ({ body: { id: "123_456" } }) });
    const r = await facebookPageAdapter(app(m.fetch)).publish(cred, input);
    assert.deepEqual([r.externalPostId, r.url], ["123_456", "https://www.facebook.com/123_456"]);
    const p = m.calls[0].params;
    assert.equal(p.get("message"), "Check your gutters before winter.\n\n#gutters");
    assert.equal(p.get("link"), "https://roofco.test/gutters");
    assert.equal(p.get("appsecret_proof"), createHmac("sha256", "app-secret").update("PAGE-TOKEN").digest("hex"));
  });

  test("image posts go to /photos with a caption", async () => {
    const m = mockMeta({ "POST /123/photos": () => ({ body: { id: "photo1", post_id: "123_789" } }) });
    const r = await facebookPageAdapter(app(m.fetch)).publish(cred, { ...input, imageUrl: "https://cdn.test/a.jpg" });
    assert.equal(r.externalPostId, "123_789");
    assert.equal(m.calls[0].params.get("url"), "https://cdn.test/a.jpg");
    assert.match(m.calls[0].params.get("caption")!, /#gutters$/);
  });

  test("definite errors, ambiguous errors and network failures are told apart", async () => {
    const fb = (r: Parameters<typeof mockMeta>[0]) => facebookPageAdapter(app(mockMeta(r).fetch));
    await assert.rejects(fb({ "POST /123/feed": () => graphError(400, 190, "Session expired") }).publish(cred, input), (e: PublishError) => e.kind === "auth" && /Session expired/.test(e.message));
    await assert.rejects(fb({ "POST /123/feed": () => graphError(400, 368) }).publish(cred, input), (e: PublishError) => e.kind === "policy");
    await assert.rejects(fb({ "POST /123/feed": () => graphError(500, 2) }).publish(cred, input), (e: PublishError) => e.kind === "ambiguous");
    await assert.rejects(fb({ "POST /123/feed": () => graphError(400, 4) }).publish(cred, input), (e: PublishError) => e.kind === "rate_limit" && e.retryAfterSeconds === 900);
    const down = facebookPageAdapter(app((async () => { throw new TypeError("fetch failed"); }) as typeof fetch));
    await assert.rejects(down.publish(cred, input), (e: PublishError) => e.kind === "ambiguous");
    await assert.rejects(down.checkAccount(cred), (e: PublishError) => e.kind === "transient", "a read that never arrived is safe to retry");
  });

  test("finds an earlier post by its text, and reads supported metrics", async () => {
    const m = mockMeta({
      "GET /123/published_posts": () => ({ body: { data: [{ id: "123_1", message: "Other" }, { id: "123_2", message: "Check your gutters before winter.\n\n#gutters", permalink_url: "https://www.facebook.com/roofco/posts/2" }] } }),
      "GET /123_2": () => ({ body: { reactions: { summary: { total_count: 7 } }, comments: { summary: { total_count: 2 } } } }),
    });
    const ad = facebookPageAdapter(app(m.fetch));
    const hit = await ad.findExisting(cred, input, new Date("2026-10-22T10:00:00Z"));
    assert.deepEqual([hit?.externalPostId, hit?.url], ["123_2", "https://www.facebook.com/roofco/posts/2"]);
    assert.equal(m.calls[0].params.get("since"), String(Date.parse("2026-10-22T10:00:00Z") / 1000 - 60));
    assert.deepEqual(await ad.metrics(cred, "123_2"), { reactions: 7, comments: 2, shares: 0 });
  });
});

describe("Instagram publishing", () => {
  const ig = { ...input, imageUrl: "https://cdn.test/a.jpg" };

  test("checks quota, creates a container, waits for it and publishes", async () => {
    const m = mockMeta({
      "GET /123/content_publishing_limit": () => ({ body: { data: [{ quota_usage: 3, config: { quota_total: 100 } }] } }),
      "POST /123/media": () => ({ body: { id: "c1" } }),
      "GET /c1": (_, n) => ({ body: { status_code: n < 2 ? "IN_PROGRESS" : "FINISHED" } }),
      "POST /123/media_publish": () => ({ body: { id: "m1" } }),
      "GET /m1": () => ({ body: { permalink: "https://www.instagram.com/p/abc/" } }),
    });
    const r = await instagramAdapter(app(m.fetch)).publish(cred, ig);
    assert.deepEqual([r.externalPostId, r.url], ["m1", "https://www.instagram.com/p/abc/"]);
    assert.equal(m.count("GET /c1"), 2);
    assert.equal(m.calls.find((c) => c.path === "/123/media")!.params.get("caption"), "Check your gutters before winter.\n\n#gutters");
    assert.equal(m.calls.find((c) => c.path === "/123/media_publish")!.params.get("creation_id"), "c1");
  });

  test("needs an image, stops at the daily quota, and reports container errors before posting", async () => {
    const ad = instagramAdapter(app(fetch));
    assert.ok(ad.requirements(input, ["publish_image"]).some((e) => e.includes("need an image")));
    assert.ok(ad.requirements(ig, []).some((e) => e.includes("isn't allowed")));
    const full = mockMeta({ "GET /123/content_publishing_limit": () => ({ body: { data: [{ quota_usage: 100, config: { quota_total: 100 } }] } }) });
    await assert.rejects(instagramAdapter(app(full.fetch)).publish(cred, ig), (e: PublishError) => e.kind === "rate_limit");
    assert.equal(full.count("POST /123/media"), 0);
    const bad = mockMeta({ "GET /123/content_publishing_limit": () => ({ body: { data: [] } }), "POST /123/media": () => ({ body: { id: "c2" } }), "GET /c2": () => ({ body: { status_code: "ERROR" } }) });
    await assert.rejects(instagramAdapter(app(bad.fetch)).publish(cred, ig), (e: PublishError) => e.kind === "media");
    assert.equal(bad.count("POST /123/media_publish"), 0);
  });

  test("a failure while publishing the container is ambiguous; metrics keep hidden values unavailable", async () => {
    const m = mockMeta({
      "GET /123/content_publishing_limit": () => ({ body: { data: [] } }),
      "POST /123/media": () => ({ body: { id: "c3" } }),
      "GET /c3": () => ({ body: { status_code: "FINISHED" } }),
      "POST /123/media_publish": () => graphError(500, 1),
      "GET /m9": () => ({ body: { comments_count: 4 } }),
    });
    await assert.rejects(instagramAdapter(app(m.fetch)).publish(cred, ig), (e: PublishError) => e.kind === "ambiguous");
    assert.deepEqual(await instagramAdapter(app(m.fetch)).metrics(cred, "m9"), { likes: null, comments: 4 });
  });
});
