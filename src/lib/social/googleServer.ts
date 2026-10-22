import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { env } from "../env";
import { isEncryptionKeyValid } from "./crypto";
import type { GoogleDeps } from "./googleConnections";

export const OAUTH_COOKIE = "rnr_google_connect";
export const CALLBACK_PATH = "/api/social/google/callback";

// What stops "Connect Google account" from working, in words for the page. Empty when ready.
export function googleSetupProblems(): string[] {
  const problems: string[] = [];
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) problems.push("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.");
  if (!isEncryptionKeyValid(env.tokenEncryptionKey())) problems.push("TOKEN_ENCRYPTION_KEY is missing or not 32 bytes (openssl rand -base64 32).");
  return problems;
}

export function googleDeps(): GoogleDeps {
  return {
    fetch,
    client: { clientId: env.googleClientId(), clientSecret: env.googleClientSecret(), redirectUri: `${env.appUrl()}${CALLBACK_PATH}` },
    encryptionKey: env.tokenEncryptionKey()!,
  };
}

// The OAuth state, PKCE verifier and target workspace travel in a short-lived signed, httpOnly cookie.
type OAuthState = { state: string; verifier: string; workspaceId: string; email: string };
const key = () => new TextEncoder().encode(env.sessionSecret());

export async function sealOAuthState(s: OAuthState) {
  return new SignJWT({ ...s, purpose: "google_connect" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("10m").sign(key());
}

export async function openOAuthState(token: string | undefined): Promise<OAuthState | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    if (payload.purpose !== "google_connect") return null;
    const { state, verifier, workspaceId, email } = payload as Record<string, unknown>;
    if ([state, verifier, workspaceId, email].some((v) => typeof v !== "string")) return null;
    return { state, verifier, workspaceId, email } as OAuthState;
  } catch {
    return null;
  }
}
