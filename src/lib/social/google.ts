// Google OAuth 2.0 (authorization code + PKCE) and the Search Console Sites API, for workspace connections.
// No Next.js imports, and fetch is passed in, so every response can be mocked in tests.
// Docs: https://developers.google.com/identity/protocols/oauth2/web-server
//       https://developers.google.com/webmaster-tools/v1/sites/list
import { createHash, randomBytes } from "node:crypto";

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const SITES_URL = "https://www.googleapis.com/webmasters/v3/sites";

// Minimum access: read-only Search Console, plus openid/email to know which Google account was connected.
export const GSC_READONLY = "https://www.googleapis.com/auth/webmasters.readonly";
export const SCOPES = ["openid", "email", GSC_READONLY];

export type Fetch = typeof fetch;
export type OAuthClient = { clientId: string; clientSecret: string; redirectUri: string };

// Errors the UI turns into clear messages.
export class GoogleReauthRequired extends Error {
  name = "GoogleReauthRequired";
}
export class GooglePermissionError extends Error {
  name = "GooglePermissionError";
}
export class GoogleRateLimited extends Error {
  name = "GoogleRateLimited";
}
export class GoogleApiError extends Error {
  name = "GoogleApiError";
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export function createPkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export const randomState = () => b64url(randomBytes(24));

export function authorizationUrl(client: OAuthClient, state: string, codeChallenge: string, loginHint?: string) {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline", // a refresh token, so discovery works later without the user present
    prompt: "consent select_account", // always return a refresh token and let the user pick the account
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  if (loginHint) params.set("login_hint", loginHint);
  return `${AUTH_URL}?${params}`;
}

type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string; scope?: string; id_token?: string };

async function readError(res: Response): Promise<{ error?: string; error_description?: string; message?: string }> {
  try {
    const body = await res.json();
    return { error: body.error?.status ?? body.error, error_description: body.error_description, message: body.error?.message };
  } catch {
    return {};
  }
}

async function tokenRequest(fetchFn: Fetch, client: OAuthClient, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...body }),
    cache: "no-store",
  });
  if (res.ok) return res.json();
  const err = await readError(res);
  // invalid_grant: the code expired or was used, or the refresh token was revoked or expired.
  if (err.error === "invalid_grant") throw new GoogleReauthRequired("Google access has expired or was revoked. Connect the account again.");
  if (res.status === 429) throw new GoogleRateLimited("Google is rate limiting requests. Try again in a minute.");
  throw new GoogleApiError(`Google token error: ${err.error_description ?? err.error ?? res.status}`, res.status);
}

// The id_token comes straight from Google's token endpoint over TLS, so its payload is read without
// re-verifying the signature (same reasoning as the sign-in flow).
function identityFromIdToken(idToken: string | undefined): { sub: string; email: string } {
  if (!idToken) throw new GoogleApiError("Google did not return an ID token.", 502);
  const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
  if (!payload.sub || !payload.email || payload.email_verified === false) throw new GoogleApiError("Google did not return a verified account email.", 502);
  return { sub: String(payload.sub), email: String(payload.email).toLowerCase() };
}

export type GrantedTokens = {
  sub: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
};

export async function exchangeCode(fetchFn: Fetch, client: OAuthClient, code: string, codeVerifier: string, now = new Date()): Promise<GrantedTokens> {
  const t = await tokenRequest(fetchFn, client, { code, code_verifier: codeVerifier, grant_type: "authorization_code", redirect_uri: client.redirectUri });
  const scopes = (t.scope ?? "").split(" ").filter(Boolean);
  // The consent screen lets people untick scopes; without Search Console access there is nothing to discover.
  if (!scopes.includes(GSC_READONLY)) throw new GooglePermissionError("Search Console access wasn't granted. Connect again and allow \"View Search Console data\".");
  if (!t.refresh_token) throw new GoogleApiError("Google didn't return a refresh token. Remove RnR Os at myaccount.google.com/permissions, then connect again.", 502);
  const { sub, email } = identityFromIdToken(t.id_token);
  return { sub, email, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: new Date(now.getTime() + t.expires_in * 1000), scopes };
}

export async function refreshAccessToken(fetchFn: Fetch, client: OAuthClient, refreshToken: string, now = new Date()) {
  const t = await tokenRequest(fetchFn, client, { refresh_token: refreshToken, grant_type: "refresh_token" });
  return { accessToken: t.access_token, expiresAt: new Date(now.getTime() + t.expires_in * 1000), refreshToken: t.refresh_token ?? null };
}

// Revoking the refresh token also revokes its access tokens. A 400 means it was already invalid, which is fine.
export async function revokeToken(fetchFn: Fetch, token: string): Promise<boolean> {
  const res = await fetchFn(REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    cache: "no-store",
  });
  return res.ok || res.status === 400;
}

export type PermissionLevel = "siteOwner" | "siteFullUser" | "siteRestrictedUser" | "siteUnverifiedUser";
export type SiteEntry = { siteUrl: string; permissionLevel: PermissionLevel; propertyType: "domain" | "url_prefix" };

const PERMISSIONS: PermissionLevel[] = ["siteOwner", "siteFullUser", "siteRestrictedUser", "siteUnverifiedUser"];

export const propertyType = (siteUrl: string): "domain" | "url_prefix" => (siteUrl.startsWith("sc-domain:") ? "domain" : "url_prefix");

// What each permission level lets us say. Only siteOwner means Google has verified the user's ownership.
export const PERMISSION_INFO: Record<PermissionLevel, { label: string; verifiedOwner: boolean; description: string }> = {
  siteOwner: { label: "Owner", verifiedOwner: true, description: "Google lists you as a verified owner." },
  siteFullUser: { label: "Full user", verifiedOwner: false, description: "Full access to data, but not an owner." },
  siteRestrictedUser: { label: "Restricted user", verifiedOwner: false, description: "Read access to most data, not an owner." },
  siteUnverifiedUser: { label: "Unverified", verifiedOwner: false, description: "Added to Search Console but ownership isn't verified." },
};

// Lists the Search Console properties the token's account can access. One retry for 429 and 5xx.
export async function listSites(fetchFn: Fetch, accessToken: string, opts: { retryDelayMs?: number } = {}): Promise<SiteEntry[]> {
  const delay = opts.retryDelayMs ?? 1500;
  for (let attempt = 1; ; attempt++) {
    const res = await fetchFn(SITES_URL, { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" });
    if (res.ok) {
      const body = (await res.json()) as { siteEntry?: { siteUrl?: string; permissionLevel?: string }[] };
      // An account with no properties gets an empty object, without siteEntry.
      return (body.siteEntry ?? [])
        .filter((e): e is { siteUrl: string; permissionLevel: PermissionLevel } => typeof e.siteUrl === "string" && PERMISSIONS.includes(e.permissionLevel as PermissionLevel))
        .map((e) => ({ siteUrl: e.siteUrl, permissionLevel: e.permissionLevel, propertyType: propertyType(e.siteUrl) }));
    }
    const err = await readError(res);
    if (res.status === 401) throw new GoogleReauthRequired("Google rejected the saved access. Connect the account again.");
    if (res.status === 403 && err.error !== "RESOURCE_EXHAUSTED" && !/quota|rate/i.test(err.message ?? "")) {
      throw new GooglePermissionError(`Google refused access to Search Console${err.message ? `: ${err.message}` : ""}. Connect again and allow Search Console access.`);
    }
    const retryable = res.status === 429 || res.status === 403 || res.status >= 500;
    if (retryable && attempt < 2) {
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    if (res.status === 429 || res.status === 403) throw new GoogleRateLimited("Google is rate limiting Search Console requests. Try again in a minute.");
    throw new GoogleApiError(`Search Console returned an error (${res.status})${err.message ? `: ${err.message}` : ""}.`, res.status);
  }
}
