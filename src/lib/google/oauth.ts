import "server-only";
import { db } from "../db";
import { env } from "../env";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// webmasters.readonly covers Search Analytics and the URL Inspection API.
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/webmasters.readonly"];

export const redirectUri = () => `${env.appUrl()}/api/auth/callback`;

export function authorizationUrl(state: string) {
  const params = new URLSearchParams({
    client_id: env.googleClientId(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // always return a refresh token
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${params}`;
}

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  id_token?: string;
};

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.googleClientId(),
      client_secret: env.googleClientSecret(),
      ...body,
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Google token error ${res.status}: ${await res.text()}`);
  return res.json();
}

// The id_token comes straight from Google's token endpoint over TLS, so reading
// its payload without verifying the signature is acceptable here.
function emailFromIdToken(idToken: string): string | null {
  const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
  return payload.email_verified ? String(payload.email).toLowerCase() : null;
}

export async function exchangeCode(code: string) {
  const tokens = await tokenRequest({
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
  });
  const email = tokens.id_token ? emailFromIdToken(tokens.id_token) : null;
  if (!email) throw new Error("Google did not return a verified email");
  return { email, tokens };
}

export async function saveTokens(email: string, tokens: TokenResponse) {
  const row: Record<string, unknown> = {
    email,
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    scope: tokens.scope,
    updated_at: new Date().toISOString(),
  };
  // A refresh grant returns no new refresh token. Upserting without one fails the
  // not-null check before the conflict is resolved, so update the existing row instead.
  const { error } = tokens.refresh_token
    ? await db().from("google_accounts").upsert({ ...row, refresh_token: tokens.refresh_token }, { onConflict: "email" })
    : await db().from("google_accounts").update(row).eq("email", email);
  if (error) throw new Error(error.message);
}

// Returns a valid access token for the owner's Google account, refreshing it when needed.
export async function getAccessToken(): Promise<string> {
  const { data, error } = await db()
    .from("google_accounts")
    .select("*")
    .eq("email", env.allowedEmail())
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Google account not connected. Sign in once to connect it.");

  const expiresAt = data.expires_at ? new Date(data.expires_at).getTime() : 0;
  if (data.access_token && expiresAt - Date.now() > 60_000) return data.access_token;

  const tokens = await tokenRequest({ refresh_token: data.refresh_token, grant_type: "refresh_token" });
  await saveTokens(data.email, tokens);
  return tokens.access_token;
}
