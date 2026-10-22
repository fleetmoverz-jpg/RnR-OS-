import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  authorizationUrl,
  createPkce,
  exchangeCode,
  GoogleApiError,
  GooglePermissionError,
  GoogleRateLimited,
  GoogleReauthRequired,
  listSites,
  PERMISSION_INFO,
  propertyType,
  refreshAccessToken,
  revokeToken,
} from "../src/lib/social/google";
import { websiteFromProperty } from "../src/lib/social/googleConnections";
import { GSC, idToken, mockGoogle, REVOKE_URL, SITES_URL, TOKEN_URL } from "./support/mock-google";

const client = { clientId: "client-id", clientSecret: "client-secret", redirectUri: "https://app.example.com/api/social/google/callback" };
const now = new Date("2026-10-22T12:00:00Z");

test("authorization URL asks for read-only Search Console only, offline access and PKCE", () => {
  const url = new URL(authorizationUrl(client, "state-123", "challenge-abc"));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.deepEqual(url.searchParams.get("scope")!.split(" ").sort(), ["email", "openid", GSC].sort());
  assert.ok(!url.searchParams.get("scope")!.includes("webmasters ") && !url.searchParams.get("scope")!.endsWith("/webmasters"), "no write scope");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-abc");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), client.redirectUri);
  assert.equal(url.searchParams.get("client_secret"), null, "secret never goes to the browser");
});

test("PKCE challenge is the SHA-256 of the verifier", () => {
  const { verifier, challenge } = createPkce();
  assert.ok(verifier.length >= 43);
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
});

test("exchangeCode sends the verifier and returns identity and tokens", async () => {
  const g = mockGoogle({
    [TOKEN_URL]: () => ({ body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: `openid email ${GSC}`, id_token: idToken({ sub: "123", email: "Owner@Example.com", email_verified: true }) } }),
  });
  const t = await exchangeCode(g.fetch, client, "code-1", "verifier-1", now);
  assert.equal(g.calls[0].body!.get("code_verifier"), "verifier-1");
  assert.equal(g.calls[0].body!.get("grant_type"), "authorization_code");
  assert.deepEqual({ sub: t.sub, email: t.email, at: t.accessToken, rt: t.refreshToken }, { sub: "123", email: "owner@example.com", at: "at-1", rt: "rt-1" });
  assert.equal(t.expiresAt.toISOString(), "2026-10-22T13:00:00.000Z");
});

test("exchangeCode refuses when Search Console access was unticked", async () => {
  const g = mockGoogle({ [TOKEN_URL]: () => ({ body: { access_token: "a", refresh_token: "r", expires_in: 3600, scope: "openid email", id_token: idToken({ sub: "1", email: "a@b.co" }) } }) });
  await assert.rejects(exchangeCode(g.fetch, client, "c", "v"), GooglePermissionError);
});

test("exchangeCode refuses without a refresh token", async () => {
  const g = mockGoogle({ [TOKEN_URL]: () => ({ body: { access_token: "a", expires_in: 3600, scope: GSC, id_token: idToken({ sub: "1", email: "a@b.co" }) } }) });
  await assert.rejects(exchangeCode(g.fetch, client, "c", "v"), /refresh token/);
});

test("an expired or reused code asks the user to reconnect", async () => {
  const g = mockGoogle({ [TOKEN_URL]: () => ({ status: 400, body: { error: "invalid_grant", error_description: "Bad Request" } }) });
  await assert.rejects(exchangeCode(g.fetch, client, "c", "v"), GoogleReauthRequired);
});

test("refresh returns a new access token; revoked consent raises GoogleReauthRequired", async () => {
  const ok = mockGoogle({ [TOKEN_URL]: () => ({ body: { access_token: "at-2", expires_in: 3599 } }) });
  const r = await refreshAccessToken(ok.fetch, client, "rt-1", now);
  assert.equal(r.accessToken, "at-2");
  assert.equal(r.refreshToken, null);
  assert.equal(ok.calls[0].body!.get("grant_type"), "refresh_token");
  const revoked = mockGoogle({ [TOKEN_URL]: () => ({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }) });
  await assert.rejects(refreshAccessToken(revoked.fetch, client, "rt-1"), GoogleReauthRequired);
});

test("listSites returns entries with property types and drops unknown permission levels", async () => {
  const g = mockGoogle({
    [SITES_URL]: () => ({
      body: {
        siteEntry: [
          { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
          { siteUrl: "https://www.example.com/", permissionLevel: "siteFullUser" },
          { siteUrl: "http://blog.example.com/news/", permissionLevel: "siteUnverifiedUser" },
          { siteUrl: "https://odd.example.com/", permissionLevel: "somethingNew" },
        ],
      },
    }),
  });
  const sites = await listSites(g.fetch, "at-1");
  assert.equal(g.calls[0].auth, "Bearer at-1");
  assert.deepEqual(sites, [
    { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner", propertyType: "domain" },
    { siteUrl: "https://www.example.com/", permissionLevel: "siteFullUser", propertyType: "url_prefix" },
    { siteUrl: "http://blog.example.com/news/", permissionLevel: "siteUnverifiedUser", propertyType: "url_prefix" },
  ]);
});

test("an account with no properties returns an empty list", async () => {
  const g = mockGoogle({ [SITES_URL]: () => ({ body: {} }) });
  assert.deepEqual(await listSites(g.fetch, "at"), []);
});

test("listSites maps Google errors", async () => {
  const unauthorized = mockGoogle({ [SITES_URL]: () => ({ status: 401, body: { error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } } }) });
  await assert.rejects(listSites(unauthorized.fetch, "at"), GoogleReauthRequired);

  const noScope = mockGoogle({ [SITES_URL]: () => ({ status: 403, body: { error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED" } } }) });
  await assert.rejects(listSites(noScope.fetch, "at"), GooglePermissionError);

  const limited = mockGoogle({ [SITES_URL]: () => ({ status: 429, body: { error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } } }) });
  await assert.rejects(listSites(limited.fetch, "at", { retryDelayMs: 1 }), GoogleRateLimited);
  assert.equal(limited.calls.length, 2, "retries once");

  const down = mockGoogle({ [SITES_URL]: () => ({ status: 503, body: { error: { code: 503, message: "Backend Error" } } }) });
  await assert.rejects(listSites(down.fetch, "at", { retryDelayMs: 1 }), GoogleApiError);
});

test("a transient error succeeds on the retry", async () => {
  const g = mockGoogle({ [SITES_URL]: [() => ({ status: 500, body: {} }), () => ({ body: { siteEntry: [{ siteUrl: "sc-domain:a.com", permissionLevel: "siteOwner" }] } })] });
  assert.equal((await listSites(g.fetch, "at", { retryDelayMs: 1 })).length, 1);
});

test("revokeToken treats an already-invalid token as revoked", async () => {
  const ok = mockGoogle({ [REVOKE_URL]: () => ({ status: 200 }) });
  assert.equal(await revokeToken(ok.fetch, "rt"), true);
  assert.equal(ok.calls[0].body!.get("token"), "rt");
  assert.equal(await revokeToken(mockGoogle({ [REVOKE_URL]: () => ({ status: 400, body: { error: "invalid_token" } }) }).fetch, "rt"), true);
  assert.equal(await revokeToken(mockGoogle({ [REVOKE_URL]: () => ({ status: 503 }) }).fetch, "rt"), false);
});

test("only siteOwner counts as a verified owner", () => {
  assert.deepEqual(Object.entries(PERMISSION_INFO).filter(([, v]) => v.verifiedOwner).map(([k]) => k), ["siteOwner"]);
});

test("property types and website mapping keep domain and URL-prefix apart", () => {
  assert.equal(propertyType("sc-domain:example.com"), "domain");
  assert.equal(propertyType("https://www.example.com/"), "url_prefix");
  assert.deepEqual(websiteFromProperty("sc-domain:example.com"), { url: "https://example.com", domain: "example.com" });
  assert.deepEqual(websiteFromProperty("https://www.example.com/"), { url: "https://www.example.com", domain: "example.com" });
  assert.deepEqual(websiteFromProperty("http://example.com/blog/"), { url: "http://example.com/blog", domain: "example.com" });
});
