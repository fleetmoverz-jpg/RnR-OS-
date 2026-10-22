// Google connections and Search Console discovery, run against a real database with mocked Google responses.
// Needs a disposable Supabase (or PostgREST) instance with all migrations applied:
//   SOCIAL_TEST_SUPABASE_URL=http://localhost:54321 SOCIAL_TEST_SUPABASE_KEY=<service role key> npm test
// Without those variables the tests are skipped. Each run uses its own workspaces and deletes them afterwards.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveWorkspace, socialRepo, type SocialContext } from "../src/lib/social/repo";
import { AccessDenied, NotFound } from "../src/lib/social/policy";
import { decryptSecret } from "../src/lib/social/crypto";
import { GooglePermissionError, GoogleRateLimited, GoogleReauthRequired, type GrantedTokens } from "../src/lib/social/google";
import { googleService } from "../src/lib/social/googleConnections";
import { GSC, mockGoogle, REVOKE_URL, SITES_URL, TOKEN_URL } from "./support/mock-google";

const url = process.env.SOCIAL_TEST_SUPABASE_URL;
const key = process.env.SOCIAL_TEST_SUPABASE_KEY;

const encryptionKey = randomBytes(32).toString("base64");
const oauthClient = { clientId: "client-id", clientSecret: "client-secret", redirectUri: "https://app.example.com/api/social/google/callback" };
const start = new Date("2026-10-22T12:00:00Z");
const hours = (h: number) => new Date(start.getTime() + h * 3_600_000);

type Routes = Parameters<typeof mockGoogle>[0];

describe("Google connections and Search Console discovery", { skip: !url || !key ? "set SOCIAL_TEST_SUPABASE_URL and SOCIAL_TEST_SUPABASE_KEY" : false }, () => {
  let client: SupabaseClient;
  const run = randomUUID().slice(0, 8);
  const domain = `gsc-${run}.example.com`;
  const DOMAIN_PROP = `sc-domain:${domain}`;
  const PREFIX_PROP = `https://www.${domain}/`;
  let ctxA: SocialContext, ctxB: SocialContext, viewerCtx: SocialContext, editorCtx: SocialContext;
  let brandA: string, brandB: string;
  let connectionId: string;
  const workspaceIds: string[] = [];

  // A service for one workspace member, with Google answering from `routes`.
  function service(ctx: SocialContext, routes: Routes = {}, now = start) {
    const google = mockGoogle(routes);
    return { svc: googleService(client, ctx, { fetch: google.fetch, client: oauthClient, encryptionKey, now: () => now, retryDelayMs: 0 }), calls: google.calls };
  }

  const tokens = (over: Partial<GrantedTokens> = {}): GrantedTokens => ({
    sub: `sub-${run}`,
    email: `owner-${run}@gmail.com`,
    accessToken: "ya29.access-1",
    refreshToken: "1//refresh-1",
    expiresAt: hours(1),
    scopes: ["openid", "email", GSC],
    ...over,
  });

  const sites = (entries: { siteUrl: string; permissionLevel: string }[]) => () => ({ body: entries.length ? { siteEntry: entries } : {} });

  async function rawConnection(id: string) {
    const { data, error } = await client.from("google_connections").select("*").eq("id", id).maybeSingle();
    assert.ifError(error);
    return data;
  }

  async function website(property: string, workspaceId = ctxA.workspaceId) {
    const { data, error } = await client.from("workspace_websites").select("*").eq("workspace_id", workspaceId).eq("gsc_property_url", property).maybeSingle();
    assert.ifError(error);
    return data;
  }

  before(async () => {
    client = createClient(url!, key!, { auth: { persistSession: false } });
    const ownerA = `owner-a-${run}@test.example`;
    const ra = await resolveWorkspace(client, ownerA, { bootstrapOwner: true });
    const rb = await resolveWorkspace(client, `owner-b-${run}@test.example`, { bootstrapOwner: true });
    assert.ok(ra && rb);
    workspaceIds.push(ra.ctx.workspaceId, rb.ctx.workspaceId);
    ctxA = ra.ctx;
    ctxB = rb.ctx;
    const { error } = await client.from("workspace_members").insert([
      { workspace_id: ctxA.workspaceId, email: `viewer-${run}@test.example`, role: "viewer" },
      { workspace_id: ctxA.workspaceId, email: `editor-${run}@test.example`, role: "editor" },
    ]);
    assert.ifError(error);
    viewerCtx = (await resolveWorkspace(client, `viewer-${run}@test.example`))!.ctx;
    editorCtx = (await resolveWorkspace(client, `editor-${run}@test.example`))!.ctx;
    brandA = (await socialRepo(client, ctxA).createBrand({ name: `Brand A ${run}`, niche: null, timezone: "UTC" })).id;
    brandB = (await socialRepo(client, ctxB).createBrand({ name: `Brand B ${run}`, niche: null, timezone: "UTC" })).id;
  });

  after(async () => {
    if (workspaceIds.length) await client.from("workspaces").delete().in("id", workspaceIds);
  });

  test("tokens are stored only as ciphertext and never listed", async () => {
    connectionId = await service(ctxA).svc.saveConnection(tokens());
    const raw = await rawConnection(connectionId);
    assert.ok(raw);
    for (const column of ["access_token_enc", "refresh_token_enc"]) {
      assert.match(raw[column], /^v1:/);
      assert.ok(!raw[column].includes("ya29") && !raw[column].includes("1//"), `${column} holds no plaintext`);
    }
    assert.equal(decryptSecret(raw.access_token_enc, encryptionKey), "ya29.access-1");
    assert.equal(decryptSecret(raw.refresh_token_enc, encryptionKey), "1//refresh-1");
    assert.equal(raw.status, "active");

    const listed = await service(ctxA).svc.listConnections();
    assert.equal(listed.length, 1);
    assert.deepEqual(Object.keys(listed[0]).filter((k) => k.includes("token")), []);
    const { data: audit } = await client.from("audit_events").select("action, details").eq("workspace_id", ctxA.workspaceId).eq("entity_id", connectionId);
    assert.ok(audit?.some((e) => e.action === "google_connection.connected" && !JSON.stringify(e.details).includes("ya29")));
  });

  test("reconnecting the same Google account updates the connection instead of adding one", async () => {
    const again = await service(ctxA).svc.saveConnection(tokens());
    assert.equal(again, connectionId);
    assert.equal((await service(ctxA).svc.listConnections()).length, 1);
  });

  test("viewers and editors cannot connect, discover or import", async () => {
    await assert.rejects(service(viewerCtx).svc.saveConnection(tokens({ sub: "other" })), AccessDenied);
    await assert.rejects(service(editorCtx).svc.saveConnection(tokens({ sub: "other" })), AccessDenied);
    await assert.rejects(service(editorCtx).svc.discover(connectionId), AccessDenied);
    await assert.rejects(service(editorCtx).svc.importProperties([randomUUID()]), AccessDenied);
    await assert.rejects(service(editorCtx).svc.disconnect(connectionId), AccessDenied);
  });

  test("discovery stores domain and URL-prefix properties with Google's permission level", async () => {
    const { svc, calls } = service(ctxA, {
      [SITES_URL]: sites([
        { siteUrl: DOMAIN_PROP, permissionLevel: "siteOwner" },
        { siteUrl: PREFIX_PROP, permissionLevel: "siteFullUser" },
        { siteUrl: `https://odd-${run}.example.com/`, permissionLevel: "somethingNew" },
      ]),
    });
    assert.deepEqual(await svc.discover(connectionId), { count: 2 });
    assert.equal(calls.length, 1, "the saved access token is still valid, so no refresh");
    assert.equal(calls[0].auth, "Bearer ya29.access-1");

    const props = await svc.listProperties();
    assert.deepEqual(
      props.map((p) => [p.site_url, p.property_type, p.permission_level, p.imported_website_id]),
      [
        [PREFIX_PROP, "url_prefix", "siteFullUser", null],
        [DOMAIN_PROP, "domain", "siteOwner", null],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    const raw = await rawConnection(connectionId);
    assert.equal(raw.status, "active");
    assert.ok(raw.last_discovered_at);
    assert.equal(raw.last_error, null);
  });

  test("another workspace can't see, discover, import or disconnect this connection", async () => {
    const { svc, calls } = service(ctxB);
    assert.deepEqual(await svc.listConnections(), []);
    assert.deepEqual(await svc.listProperties(), []);
    await assert.rejects(svc.discover(connectionId), NotFound);
    await assert.rejects(svc.disconnect(connectionId), NotFound);
    const ids = (await service(ctxA).svc.listProperties()).map((p) => p.id);
    assert.deepEqual(await svc.importProperties(ids), { imported: [], skipped: [], notFound: 2 });
    assert.equal(calls.length, 0, "no Google call is made for another workspace's connection");
    assert.ok(await rawConnection(connectionId), "connection still exists");
  });

  test("importing into another workspace's brand is refused", async () => {
    const ids = (await service(ctxA).svc.listProperties()).map((p) => p.id);
    await assert.rejects(service(ctxA).svc.importProperties(ids, brandB), NotFound);
    assert.equal(await website(DOMAIN_PROP), null);
  });

  test("import marks only siteOwner properties as verified and keeps both property types", async () => {
    const { svc } = service(ctxA);
    const ids = (await svc.listProperties()).map((p) => p.id);
    const r = await svc.importProperties(ids, brandA);
    assert.deepEqual(r.imported.sort(), [DOMAIN_PROP, PREFIX_PROP].sort());
    assert.deepEqual(r.skipped, []);

    const owner = await website(DOMAIN_PROP);
    assert.equal(owner.property_type, "domain");
    assert.equal(owner.permission_level, "siteOwner");
    assert.equal(owner.verification_status, "verified");
    assert.equal(owner.verification_method, "search_console");
    assert.equal(owner.domain, domain);
    assert.equal(owner.url, `https://${domain}`);
    assert.equal(owner.brand_id, brandA);
    assert.equal(owner.google_connection_id, connectionId);

    const full = await website(PREFIX_PROP);
    assert.equal(full.property_type, "url_prefix");
    assert.equal(full.permission_level, "siteFullUser");
    assert.equal(full.verification_status, "unverified", "a full user is not an owner");
    assert.equal(full.verification_method, null);
    assert.equal(full.url, `https://www.${domain}`);

    assert.ok((await svc.listProperties()).every((p) => p.imported_website_id));
  });

  test("importing again skips properties that are already in the workspace", async () => {
    const { svc } = service(ctxA);
    const ids = (await svc.listProperties()).map((p) => p.id);
    const r = await svc.importProperties([...ids, ids[0]], null);
    assert.deepEqual(r.imported, []);
    assert.equal(r.skipped.length, 2);
    const { count } = await client.from("workspace_websites").select("id", { count: "exact", head: true }).eq("workspace_id", ctxA.workspaceId);
    assert.equal(count, 2);
  });

  test("rate limits are retried once, then reported without disconnecting", async () => {
    const { svc, calls } = service(ctxA, { [SITES_URL]: () => ({ status: 429, body: { error: { code: 429, message: "Rate Limit Exceeded" } } }) });
    await assert.rejects(svc.discover(connectionId), GoogleRateLimited);
    assert.equal(calls.length, 2);
    const raw = await rawConnection(connectionId);
    assert.equal(raw.status, "active");
    assert.match(raw.last_error, /rate limiting/);
    assert.equal((await service(ctxA).svc.listProperties()).length, 2, "stored properties are kept");
  });

  test("an expired access token is refreshed server-side and the new one stored encrypted", async () => {
    const { svc, calls } = service(
      ctxA,
      {
        [TOKEN_URL]: () => ({ body: { access_token: "ya29.access-2", expires_in: 3600, scope: `openid email ${GSC}` } }),
        [SITES_URL]: sites([
          { siteUrl: DOMAIN_PROP, permissionLevel: "siteOwner" },
          { siteUrl: PREFIX_PROP, permissionLevel: "siteFullUser" },
        ]),
      },
      hours(2),
    );
    await svc.discover(connectionId);
    assert.equal(calls[0].url, TOKEN_URL);
    assert.equal(calls[0].body?.get("grant_type"), "refresh_token");
    assert.equal(calls[0].body?.get("refresh_token"), "1//refresh-1");
    assert.equal(calls[1].auth, "Bearer ya29.access-2");

    const raw = await rawConnection(connectionId);
    assert.ok(!raw.access_token_enc.includes("ya29"));
    assert.equal(decryptSecret(raw.access_token_enc, encryptionKey), "ya29.access-2");
    assert.equal(new Date(raw.access_token_expires_at).toISOString(), hours(3).toISOString());
    assert.equal(decryptSecret(raw.refresh_token_enc, encryptionKey), "1//refresh-1", "refresh token kept when Google doesn't rotate it");
    assert.equal(raw.last_error, null);
  });

  test("re-discovery removes verification when Google no longer reports siteOwner", async () => {
    const { svc } = service(ctxA, { [SITES_URL]: sites([{ siteUrl: DOMAIN_PROP, permissionLevel: "siteRestrictedUser" }]) }, hours(2));
    assert.deepEqual(await svc.discover(connectionId), { count: 1 });
    const downgraded = await website(DOMAIN_PROP);
    assert.equal(downgraded.permission_level, "siteRestrictedUser");
    assert.equal(downgraded.verification_status, "unverified");
    assert.equal(downgraded.verification_method, null);
    assert.equal(downgraded.verified_at, null);

    const gone = await website(PREFIX_PROP);
    assert.equal(gone.permission_level, null, "a property Google no longer lists has no permission level");
    assert.equal(gone.verification_status, "unverified");
    assert.deepEqual((await svc.listProperties()).map((p) => p.site_url), [DOMAIN_PROP]);
  });

  test("an account with no properties and an account without Search Console access", async () => {
    const second = await service(ctxA).svc.saveConnection(tokens({ sub: `sub2-${run}`, email: `empty-${run}@gmail.com` }));
    assert.deepEqual(await service(ctxA, { [SITES_URL]: sites([]) }).svc.discover(second), { count: 0 });
    assert.equal((await rawConnection(second)).status, "active");

    const denied = service(ctxA, { [SITES_URL]: () => ({ status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", message: "Request had insufficient authentication scopes." } } }) });
    await assert.rejects(denied.svc.discover(second), GooglePermissionError);
    const raw = await rawConnection(second);
    assert.equal(raw.status, "needs_reconnect");
    assert.equal(raw.access_token_enc, null, "the unusable access token is dropped");
  });

  test("revoked consent marks the connection for reconnecting and stops calling Google", async () => {
    const revoked = service(ctxA, { [TOKEN_URL]: () => ({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }) }, hours(4));
    await assert.rejects(revoked.svc.discover(connectionId), GoogleReauthRequired);
    const raw = await rawConnection(connectionId);
    assert.equal(raw.status, "needs_reconnect");
    assert.equal(raw.access_token_enc, null);
    assert.match(raw.last_error, /expired or was revoked/);

    const later = service(ctxA, {}, hours(5));
    await assert.rejects(later.svc.discover(connectionId), GoogleReauthRequired);
    assert.equal(later.calls.length, 0);

    // Connecting again restores it.
    await service(ctxA).svc.saveConnection(tokens({ accessToken: "ya29.access-3", refreshToken: "1//refresh-3", expiresAt: hours(6) }));
    assert.equal((await rawConnection(connectionId)).status, "active");
  });

  test("disconnect revokes at Google, deletes tokens and properties, and keeps websites unlinked", async () => {
    const { svc, calls } = service(ctxA, { [REVOKE_URL]: () => ({ body: {} }) });
    assert.deepEqual(await svc.disconnect(connectionId), { revokedAtGoogle: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body?.get("token"), "1//refresh-3");

    assert.equal(await rawConnection(connectionId), null);
    const { data: props } = await client.from("gsc_properties").select("id").eq("connection_id", connectionId);
    assert.deepEqual(props, []);
    const kept = await website(DOMAIN_PROP);
    assert.ok(kept, "imported website is kept");
    assert.equal(kept.google_connection_id, null);
    assert.equal(kept.gsc_property_url, DOMAIN_PROP);
  });

  test("disconnect still deletes stored tokens when Google can't be reached", async () => {
    const id = (await service(ctxA).svc.listConnections())[0].id;
    const { svc } = service(ctxA, { [REVOKE_URL]: () => ({ status: 503, body: {} }) });
    assert.deepEqual(await svc.disconnect(id), { revokedAtGoogle: false });
    assert.equal(await rawConnection(id), null);
  });
});
