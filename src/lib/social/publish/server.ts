import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { env } from "../../env";
import { isEncryptionKeyValid } from "../crypto";
import { safeFetch } from "../safeFetch";
import { facebookPageAdapter, instagramAdapter, metaConnect, type MetaApp } from "./meta";
import type { ConnectionDeps } from "./connections";
import type { PublishDeps } from "./service";

export const META_COOKIE = "rnr_meta_connect";
export const META_CALLBACK_PATH = "/api/social/meta/callback";

// What stops "Connect Facebook & Instagram" from working, in words for the page. Empty when ready.
export function metaSetupProblems(): string[] {
  const problems: string[] = [];
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) problems.push("META_APP_ID and META_APP_SECRET are not set.");
  if (!isEncryptionKeyValid(env.tokenEncryptionKey())) problems.push("TOKEN_ENCRYPTION_KEY is missing or not 32 bytes (openssl rand -base64 32).");
  return problems;
}

function metaApp(): MetaApp {
  return { appId: process.env.META_APP_ID!, appSecret: process.env.META_APP_SECRET!, redirectUri: `${env.appUrl()}${META_CALLBACK_PATH}`, version: process.env.META_GRAPH_VERSION || undefined };
}

// Adapters exist only when the app's keys are set; every other platform says why it's off.
function adapters() {
  if (metaSetupProblems().length) return {};
  const app = metaApp();
  return { facebook_page: facebookPageAdapter(app), instagram: instagramAdapter(app) };
}

const LATER = "Publishing to this platform isn't built yet. Facebook Pages and Instagram come first.";
export function unavailableReasons(): Record<string, string> {
  const meta = metaSetupProblems();
  const metaReason = meta.length ? `Facebook and Instagram publishing is off: ${meta.join(" ")}` : "";
  return {
    ...(metaReason ? { facebook_page: metaReason, instagram: metaReason } : {}),
    x: LATER,
    linkedin_page: LATER,
    linkedin_profile: LATER,
    google_business: LATER,
    threads: LATER,
    pinterest: LATER,
  };
}

export function connectionDeps(): ConnectionDeps {
  return { provider: metaConnect(metaApp()), adapters: adapters(), encryptionKey: env.tokenEncryptionKey()! };
}

export function publishDeps(): PublishDeps {
  return {
    adapters: adapters(),
    unavailable: unavailableReasons(),
    encryptionKey: env.tokenEncryptionKey() ?? "",
    fetchImage: (url) => safeFetch(url, { binary: true, maxBytes: 10 * 1024 * 1024, timeoutMs: 15_000, accept: "image/*", userAgent: `RnROsBot/1.0 (+${env.appUrl()})` }),
  };
}

// The OAuth state and target workspace travel in a short-lived signed, httpOnly cookie.
type MetaState = { state: string; workspaceId: string; email: string };
const key = () => new TextEncoder().encode(env.sessionSecret());

export async function sealMetaState(s: MetaState) {
  return new SignJWT({ ...s, purpose: "meta_connect" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("10m").sign(key());
}

export async function openMetaState(token: string | undefined): Promise<MetaState | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    if (payload.purpose !== "meta_connect") return null;
    const { state, workspaceId, email } = payload as Record<string, unknown>;
    if ([state, workspaceId, email].some((v) => typeof v !== "string")) return null;
    return { state, workspaceId, email } as MetaState;
  } catch {
    return null;
  }
}
