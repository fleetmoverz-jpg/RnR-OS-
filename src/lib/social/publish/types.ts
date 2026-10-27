// The contract every platform integration implements: connecting (OAuth, discovery, revoke) and
// publishing (validation, posting, reconciling ambiguous results, metrics). Adapters never touch the
// database and take fetch as a dependency, so each one is tested against mocked HTTP.
import type { Platform } from "../platforms";

export type Fetch = typeof fetch;

// What went wrong, in terms the publishing service can act on.
//   auth        token expired or revoked: the account needs reconnecting, never retried
//   permission  the app or user lacks a permission or Page role: never retried
//   rate_limit  the platform asked us to slow down: wait, then it's safe to retry
//   validation  the platform rejected the content: never retried as is
//   policy      blocked by platform policy (spam, restricted Page): never retried
//   media       the image couldn't be fetched or isn't acceptable: fix the media first
//   transient   failed before anything was posted: safe to retry
//   ambiguous   the request may have reached the platform (timeout, 5xx while posting): check before any retry
export type PublishErrorKind = "auth" | "permission" | "rate_limit" | "validation" | "policy" | "media" | "transient" | "ambiguous" | "unknown";

export class PublishError extends Error {
  name = "PublishError";
  kind: PublishErrorKind;
  status: number | null;
  code: string | null;
  retryAfterSeconds: number | null;
  response: unknown;
  constructor(kind: PublishErrorKind, message: string, extra: { status?: number | null; code?: string | null; retryAfterSeconds?: number | null; response?: unknown } = {}) {
    super(message);
    this.kind = kind;
    this.status = extra.status ?? null;
    this.code = extra.code ?? null;
    this.retryAfterSeconds = extra.retryAfterSeconds ?? null;
    this.response = extra.response ?? null;
  }
}

export const RETRYABLE: PublishErrorKind[] = ["rate_limit", "transient"];

// ---- connecting

export type ConnectedUser = { userId: string; userName: string | null; token: string; expiresAt: Date | null; scopes: string[]; declined: string[] };

export type DiscoveredAccount = {
  platform: Platform;
  externalAccountId: string;
  pageId: string; // the Facebook Page that grants access (for Instagram, the linked Page)
  name: string;
  username: string | null;
  pictureUrl: string | null;
  tasks: string[];
  pageToken: string;
};

export interface ConnectProvider {
  id: string;
  scopes: string[];
  authorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<ConnectedUser>;
  discover(userToken: string): Promise<DiscoveredAccount[]>;
  revoke(userToken: string, userId: string): Promise<void>;
}

// ---- publishing

export type PermittedAction = "publish_text" | "publish_link" | "publish_image" | "read_metrics";
export type AccountCredential = { externalAccountId: string; token: string };
export type PublishInput = { body: string; hashtags: string[]; link: string | null; imageUrl: string | null };
export type RateUsage = { percent: number; regainSeconds: number | null };
export type PublishResult = { externalPostId: string; url: string | null; response: unknown; usage?: RateUsage | null };
export type Metrics = Record<string, number | null>;

export interface PublishAdapter {
  platform: Platform;
  // Checks the adapter-specific needs (an image for Instagram, for example) on top of the content rules.
  requirements(input: PublishInput, actions: string[]): string[];
  publish(cred: AccountCredential, input: PublishInput): Promise<PublishResult>;
  // Looks for a post made from this input since `since`, to settle an ambiguous attempt.
  findExisting(cred: AccountCredential, input: PublishInput, since: Date): Promise<PublishResult | null>;
  metrics(cred: AccountCredential, externalPostId: string): Promise<Metrics>;
  checkAccount(cred: AccountCredential): Promise<{ name: string }>;
}
