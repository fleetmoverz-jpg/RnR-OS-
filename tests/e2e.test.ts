// End-to-end smoke tests against a running app (local or a preview deployment): sign-in walls,
// every Social page rendering, security headers, the cron secret and OAuth state checks.
//   E2E_BASE_URL=http://localhost:3000 E2E_SESSION_SECRET=<SESSION_SECRET> E2E_EMAIL=<ALLOWED_EMAIL> [E2E_CRON_SECRET=<CRON_SECRET>] npm test
// Read-only: it never submits a form, connects an account or publishes.
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";

const base = process.env.E2E_BASE_URL?.replace(/\/$/, "");
const secret = process.env.E2E_SESSION_SECRET;
const email = process.env.E2E_EMAIL;
const cronSecret = process.env.E2E_CRON_SECRET;

const PAGES: [string, string][] = [
  ["/social", "Social"],
  ["/social/brands", "Brands"],
  ["/social/websites", "Websites"],
  ["/social/accounts", "Connected Accounts"],
  ["/social/content", "Content Studio"],
  ["/social/content/strategy", "Content Strategy"],
  ["/social/queue", "Publishing Queue"],
  ["/social/calendar", "Publishing Calendar"],
  ["/social/automation", "Automation"],
  ["/social/history", "Publishing History"],
  ["/social/analytics", "Social Analytics"],
  ["/social/audit", "Audit Log"],
  ["/social/settings", "Social Settings"],
];

describe("end-to-end smoke", { skip: !base || !secret || !email ? "set E2E_BASE_URL, E2E_SESSION_SECRET and E2E_EMAIL" : false }, () => {
  let cookie = "";
  before(async () => {
    const token = await new SignJWT({ email }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("10m").sign(new TextEncoder().encode(secret!));
    cookie = `rnr_session=${token}`;
  });
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { redirect: "manual", headers });

  test("responses carry the security headers", async () => {
    const r = await get("/login");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.equal(r.headers.get("x-powered-by"), null);
  });

  test("signed-out visitors are sent to the sign-in page", async () => {
    for (const [path] of PAGES) {
      const r = await get(path);
      assert.ok([303, 307, 308].includes(r.status), `${path} answered ${r.status}`);
      assert.match(r.headers.get("location") ?? "", /\/login/, path);
    }
  });

  test("a forged session cookie is refused", async () => {
    const forged = await new SignJWT({ email }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("10m").sign(new TextEncoder().encode("not-the-secret"));
    const r = await get("/social/queue", { cookie: `rnr_session=${forged}` });
    assert.match(r.headers.get("location") ?? "", /\/login/);
  });

  test("every Social page renders for the signed-in owner", async () => {
    for (const [path, title] of PAGES) {
      const r = await get(path, { cookie });
      assert.equal(r.status, 200, `${path} answered ${r.status}`);
      const html = await r.text();
      assert.ok(html.includes(title), `${path} shows "${title}"`);
      // Variable names may appear in setup hints; values and token-shaped strings must not.
      assert.ok(!/\bEA[A-Za-z0-9]{30,}|ya29\.|"(access|refresh)_token"\s*:|v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:/.test(html), `${path} shows no tokens`);
      assert.ok(!html.includes(secret!) && (!cronSecret || cronSecret.length < 8 || !html.includes(cronSecret)), `${path} shows no secrets`);
    }
  });

  test("the queue worker needs the cron secret", async () => {
    assert.equal((await fetch(`${base}/api/cron/social`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${base}/api/cron/social`, { method: "POST", headers: { authorization: "Bearer wrong" } })).status, 401);
    if (cronSecret) {
      const r = await fetch(`${base}/api/cron/social`, { method: "POST", headers: { authorization: `Bearer ${cronSecret}` } });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(typeof body.published, "number");
      assert.equal(typeof body.errors, "number", "only a count of errors is returned");
    }
  });

  test("an OAuth callback without the matching state is refused", async () => {
    const r = await get("/api/social/meta/callback?code=stolen&state=guess", { cookie });
    assert.match(r.headers.get("location") ?? "", /meta_error=state/);
    const g = await get("/api/social/google/callback?code=stolen&state=guess", { cookie });
    assert.match(g.headers.get("location") ?? "", /google_error=/);
  });
});
