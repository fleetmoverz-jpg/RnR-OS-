// Meta Graph API: Facebook Login for connecting, Pages API for Facebook Page posts and the Instagram
// API with Facebook Login for Instagram professional accounts. Only official endpoints; tokens are
// sent with an appsecret_proof and never logged or returned.
// Docs: https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
//       https://developers.facebook.com/docs/pages-api/posts
//       https://developers.facebook.com/documentation/instagram-platform/content-publishing
import { createHmac } from "node:crypto";
import type { Platform } from "../platforms";
import {
  PublishError,
  type AccountCredential,
  type ConnectProvider,
  type ConnectedUser,
  type DiscoveredAccount,
  type Fetch,
  type Metrics,
  type PermittedAction,
  type PublishAdapter,
  type PublishErrorKind,
  type PublishInput,
  type PublishResult,
  type RateUsage,
} from "./types";

export const DEFAULT_GRAPH_VERSION = "v26.0";

// Least privilege: list Pages, post to them, read their engagement, and publish to linked Instagram accounts.
export const META_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish"];

export type MetaApp = { appId: string; appSecret: string; redirectUri: string; version?: string; fetch?: Fetch; sleep?: (ms: number) => Promise<void>; timeoutMs?: number };

type GraphError = { message?: string; type?: string; code?: number; error_subcode?: number; is_transient?: boolean; fbtrace_id?: string };

const RATE_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80004, 80005, 80006, 80008, 80014]);
const PERMISSION_CODES = new Set([3, 10]);
// Instagram publishing subcodes about the media itself (fetch failed, format, size, aspect ratio).
const MEDIA_SUBCODES = new Set([2207003, 2207004, 2207005, 2207009, 2207026, 2207052]);

// Maps a Graph API error to what the service should do. `whilePosting` marks the request that creates
// the post: a server error or timeout there may have posted anyway, so it's ambiguous, not transient.
export function classifyGraphError(status: number, err: GraphError | undefined, whilePosting: boolean): PublishErrorKind {
  const code = err?.code ?? null;
  const sub = err?.error_subcode ?? null;
  if (code === 190 || code === 102 || code === 463 || code === 467) return "auth";
  if (code !== null && (PERMISSION_CODES.has(code) || (code >= 200 && code <= 299))) return "permission";
  if ((code !== null && RATE_CODES.has(code)) || sub === 2207042 || status === 429) return "rate_limit";
  if (code === 368) return "policy";
  if (sub !== null && MEDIA_SUBCODES.has(sub)) return "media";
  if (code === 100) return "validation";
  if (status >= 500 || code === 1 || code === 2 || err?.is_transient) return whilePosting ? "ambiguous" : "transient";
  if (status >= 400) return "unknown";
  return whilePosting ? "ambiguous" : "transient";
}

const MESSAGES: Record<PublishErrorKind, string> = {
  auth: "Meta says the access token is no longer valid. Reconnect the account.",
  permission: "Meta refused: the app or your Page role doesn't allow this.",
  rate_limit: "Meta is rate limiting this account. It will be safe to try again later.",
  validation: "Meta rejected the post content.",
  policy: "Meta blocked this post under its policies.",
  media: "Instagram couldn't use the image.",
  transient: "Meta had a temporary problem before anything was posted.",
  ambiguous: "Meta's answer was unclear, so the post may or may not have gone out.",
  unknown: "Meta returned an unexpected error.",
};

// Usage headers: X-App-Usage and X-Business-Use-Case-Usage report percentages of the limit used.
export function readUsage(headers: Headers): RateUsage | null {
  let percent = 0;
  let regain: number | null = null;
  let seen = false;
  const take = (o: Record<string, unknown>) => {
    for (const k of ["call_count", "total_time", "total_cputime"]) if (typeof o[k] === "number") percent = Math.max(percent, o[k] as number);
    const minutes = o.estimated_time_to_regain_access;
    if (typeof minutes === "number" && minutes > 0) regain = Math.max(regain ?? 0, minutes * 60);
    seen = true;
  };
  for (const name of ["x-app-usage", "x-page-usage"]) {
    const raw = headers.get(name);
    if (!raw) continue;
    try {
      take(JSON.parse(raw));
    } catch {}
  }
  const buc = headers.get("x-business-use-case-usage");
  if (buc) {
    try {
      for (const entries of Object.values(JSON.parse(buc) as Record<string, Record<string, unknown>[]>)) for (const e of entries) take(e);
    } catch {}
  }
  return seen ? { percent, regainSeconds: regain } : null;
}

// Drops anything token-like before a response is stored.
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !/token|secret|proof|password/i.test(k)).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

type GraphResult = { status: number; body: Record<string, unknown>; usage: RateUsage | null };

export function metaGraph(app: MetaApp) {
  const version = app.version || DEFAULT_GRAPH_VERSION;
  const base = `https://graph.facebook.com/${version}`;
  const fetchFn = app.fetch ?? fetch;
  const proof = (token: string) => createHmac("sha256", app.appSecret).update(token).digest("hex");

  async function call(method: "GET" | "POST" | "DELETE", path: string, opts: { token?: string; params?: Record<string, string>; whilePosting?: boolean } = {}): Promise<GraphResult> {
    const params = new URLSearchParams(opts.params ?? {});
    if (opts.token) {
      params.set("access_token", opts.token);
      params.set("appsecret_proof", proof(opts.token));
    }
    const url = path.startsWith("https://") ? path : `${base}${path}`;
    const init: RequestInit = { method, signal: AbortSignal.timeout(app.timeoutMs ?? 20_000) };
    let target = url;
    if (method === "POST") {
      init.headers = { "content-type": "application/x-www-form-urlencoded" };
      init.body = params.toString();
    } else {
      target = `${url}${url.includes("?") ? "&" : "?"}${params}`;
    }
    let res: Response;
    try {
      res = await fetchFn(target, init);
    } catch (e) {
      // No answer at all. Before the post-creating request it's safe to retry; during it, it isn't.
      const why = e instanceof Error ? e.message : String(e);
      throw new PublishError(opts.whilePosting ? "ambiguous" : "transient", `${opts.whilePosting ? MESSAGES.ambiguous : MESSAGES.transient} (${why})`);
    }
    const usage = readUsage(res.headers);
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      if (res.ok && opts.whilePosting) throw new PublishError("ambiguous", `${MESSAGES.ambiguous} (unreadable response)`, { status: res.status });
    }
    const err = body.error as GraphError | undefined;
    if (!res.ok || err) {
      const kind = classifyGraphError(res.status, err, Boolean(opts.whilePosting));
      const detail = err?.message ? `: ${err.message.slice(0, 300)}` : "";
      throw new PublishError(kind, `${MESSAGES[kind]}${detail}`, {
        status: res.status,
        code: err?.code != null ? `${err.code}${err.error_subcode ? `/${err.error_subcode}` : ""}` : null,
        retryAfterSeconds: kind === "rate_limit" ? (usage?.regainSeconds ?? 900) : null,
        response: redact(body),
      });
    }
    return { status: res.status, body, usage };
  }

  return { version, call };
}

// ---- connecting

export function metaConnect(app: MetaApp): ConnectProvider {
  const g = metaGraph(app);
  const exchange = async (params: Record<string, string>) => {
    const r = await g.call("GET", "/oauth/access_token", { params: { client_id: app.appId, client_secret: app.appSecret, ...params } });
    const token = String(r.body.access_token ?? "");
    if (!token) throw new PublishError("unknown", "Meta returned no access token.");
    const expiresIn = Number(r.body.expires_in);
    return { token, expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null };
  };
  return {
    id: "meta",
    scopes: META_SCOPES,
    authorizationUrl(state) {
      const params = new URLSearchParams({ client_id: app.appId, redirect_uri: app.redirectUri, state, response_type: "code", scope: META_SCOPES.join(","), auth_type: "rerequest" });
      return `https://www.facebook.com/${g.version}/dialog/oauth?${params}`;
    },
    async exchangeCode(code): Promise<ConnectedUser> {
      const short = await exchange({ redirect_uri: app.redirectUri, code });
      // A long-lived user token (about 60 days); Page tokens derived from it don't expire.
      const long = await exchange({ grant_type: "fb_exchange_token", fb_exchange_token: short.token });
      const me = await g.call("GET", "/me", { token: long.token, params: { fields: "id,name" } });
      const perms = await g.call("GET", "/me/permissions", { token: long.token });
      const list = (Array.isArray(perms.body.data) ? perms.body.data : []) as { permission: string; status: string }[];
      return {
        userId: String(me.body.id),
        userName: typeof me.body.name === "string" ? me.body.name : null,
        token: long.token,
        expiresAt: long.expiresAt,
        scopes: list.filter((p) => p.status === "granted").map((p) => p.permission),
        declined: list.filter((p) => p.status !== "granted").map((p) => p.permission),
      };
    },
    async discover(userToken) {
      const out: DiscoveredAccount[] = [];
      let next: string | null = "/me/accounts";
      let params: Record<string, string> | undefined = { fields: "id,name,tasks,access_token,picture{url},instagram_business_account{id,username,name,profile_picture_url}", limit: "100" };
      for (let page = 0; next && page < 5; page++) {
        const r: GraphResult = await g.call("GET", next, { token: userToken, params });
        for (const p of (Array.isArray(r.body.data) ? r.body.data : []) as Record<string, unknown>[]) {
          const pageToken = typeof p.access_token === "string" ? p.access_token : "";
          if (!pageToken) continue;
          const tasks = Array.isArray(p.tasks) ? p.tasks.map(String) : [];
          const picture = (p.picture as { data?: { url?: string } } | undefined)?.data?.url ?? null;
          out.push({ platform: "facebook_page", externalAccountId: String(p.id), pageId: String(p.id), name: String(p.name ?? p.id), username: null, pictureUrl: picture?.startsWith("https://") ? picture : null, tasks, pageToken });
          const ig = p.instagram_business_account as Record<string, unknown> | undefined;
          if (ig?.id) {
            const pic = typeof ig.profile_picture_url === "string" && ig.profile_picture_url.startsWith("https://") ? ig.profile_picture_url : null;
            out.push({ platform: "instagram", externalAccountId: String(ig.id), pageId: String(p.id), name: String(ig.name ?? ig.username ?? ig.id), username: typeof ig.username === "string" ? ig.username : null, pictureUrl: pic, tasks, pageToken });
          }
        }
        const paging = r.body.paging as { next?: string } | undefined;
        next = paging?.next?.startsWith("https://graph.facebook.com/") ? paging.next.replace(/([?&])(access_token|appsecret_proof)=[^&]*/g, "$1").replace(/&&+/g, "&") : null;
        params = undefined;
      }
      return out;
    },
    async revoke(userToken, userId) {
      await g.call("DELETE", `/${encodeURIComponent(userId)}/permissions`, { token: userToken });
    },
  };
}

// What the app may do with an account, from the granted scopes and the user's tasks on the Page.
export function permittedActions(platform: Platform, scopes: string[], tasks: string[]): PermittedAction[] {
  const canCreate = tasks.length === 0 || tasks.some((t) => t === "CREATE_CONTENT" || t === "MANAGE");
  const out: PermittedAction[] = [];
  if (platform === "facebook_page") {
    if (canCreate && scopes.includes("pages_manage_posts")) out.push("publish_text", "publish_link", "publish_image");
    if (scopes.includes("pages_read_engagement")) out.push("read_metrics");
  } else if (platform === "instagram") {
    if (canCreate && scopes.includes("instagram_content_publish")) out.push("publish_image");
    if (scopes.includes("instagram_basic")) out.push("read_metrics");
  }
  return out;
}

// ---- publishing

const withTags = (body: string, tags: string[]) => (tags.length ? `${body.trim()}\n\n${tags.map((t) => `#${t}`).join(" ")}` : body.trim());

export function facebookText(input: PublishInput) {
  return withTags(input.body, input.hashtags);
}

export function instagramCaption(input: PublishInput) {
  return withTags(input.body, input.hashtags);
}

const same = (a: unknown, b: string) => typeof a === "string" && a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");

export function facebookPageAdapter(app: MetaApp): PublishAdapter {
  const g = metaGraph(app);
  return {
    platform: "facebook_page",
    requirements(input, actions) {
      const errors: string[] = [];
      if (input.imageUrl ? !actions.includes("publish_image") : !actions.includes("publish_text")) errors.push("This Facebook Page connection isn't allowed to create posts. Reconnect with a Page role that can create content.");
      return errors;
    },
    async publish(cred, input) {
      const message = facebookText(input);
      const r = input.imageUrl
        ? await g.call("POST", `/${cred.externalAccountId}/photos`, { token: cred.token, params: { url: input.imageUrl, caption: message }, whilePosting: true })
        : await g.call("POST", `/${cred.externalAccountId}/feed`, { token: cred.token, params: { message, ...(input.link && !message.includes(input.link) ? { link: input.link } : {}) }, whilePosting: true });
      const id = String(r.body.post_id ?? r.body.id ?? "");
      if (!id) throw new PublishError("ambiguous", `${MESSAGES.ambiguous} (no post id in the response)`, { response: redact(r.body) });
      return { externalPostId: id, url: `https://www.facebook.com/${id}`, response: redact(r.body), usage: r.usage };
    },
    async findExisting(cred, input, since) {
      const r = await g.call("GET", `/${cred.externalAccountId}/published_posts`, { token: cred.token, params: { fields: "id,message,created_time,permalink_url", since: String(Math.floor(since.getTime() / 1000) - 60), limit: "25" } });
      const want = facebookText(input);
      const hit = ((Array.isArray(r.body.data) ? r.body.data : []) as Record<string, unknown>[]).find((p) => same(p.message, want));
      if (!hit) return null;
      const url = typeof hit.permalink_url === "string" && hit.permalink_url.startsWith("https://") ? hit.permalink_url : `https://www.facebook.com/${hit.id}`;
      return { externalPostId: String(hit.id), url, response: redact(hit) };
    },
    async metrics(cred, postId): Promise<Metrics> {
      const r = await g.call("GET", `/${postId}`, { token: cred.token, params: { fields: "reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares" } });
      const total = (k: string) => {
        const v = (r.body[k] as { summary?: { total_count?: number } } | undefined)?.summary?.total_count;
        return typeof v === "number" ? v : null;
      };
      const shares = (r.body.shares as { count?: number } | undefined)?.count;
      // Facebook omits "shares" when there are none, so a missing count is zero only when reactions are readable.
      return { reactions: total("reactions"), comments: total("comments"), shares: typeof shares === "number" ? shares : total("reactions") === null ? null : 0 };
    },
    async checkAccount(cred) {
      const r = await g.call("GET", `/${cred.externalAccountId}`, { token: cred.token, params: { fields: "id,name" } });
      return { name: String(r.body.name ?? cred.externalAccountId) };
    },
  };
}

export function instagramAdapter(app: MetaApp): PublishAdapter {
  const g = metaGraph(app);
  const sleep = app.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  return {
    platform: "instagram",
    requirements(input, actions) {
      const errors: string[] = [];
      if (!input.imageUrl) errors.push("Instagram posts need an image. Add a public JPEG image URL.");
      if (!actions.includes("publish_image")) errors.push("This Instagram account isn't allowed to publish. Reconnect and grant instagram_content_publish.");
      return errors;
    },
    async publish(cred, input) {
      // Instagram allows 100 API-published posts per account per 24 hours; check before using one.
      const quota = await g.call("GET", `/${cred.externalAccountId}/content_publishing_limit`, { token: cred.token, params: { fields: "config,quota_usage" } });
      const q = (Array.isArray(quota.body.data) ? quota.body.data[0] : null) as { quota_usage?: number; config?: { quota_total?: number } } | null;
      if (q && typeof q.quota_usage === "number" && typeof q.config?.quota_total === "number" && q.quota_usage >= q.config.quota_total) {
        throw new PublishError("rate_limit", `This Instagram account has used its ${q.config.quota_total} API posts for the last 24 hours.`, { retryAfterSeconds: 3600 });
      }
      // Creating and checking the container posts nothing, so failures up to here are safe to retry.
      const container = await g.call("POST", `/${cred.externalAccountId}/media`, { token: cred.token, params: { image_url: input.imageUrl!, caption: instagramCaption(input) } });
      const creationId = String(container.body.id ?? "");
      if (!creationId) throw new PublishError("transient", "Instagram didn't return a media container.");
      let status = "IN_PROGRESS";
      for (let i = 0; i < 10 && status === "IN_PROGRESS"; i++) {
        if (i > 0) await sleep(3000);
        const s = await g.call("GET", `/${creationId}`, { token: cred.token, params: { fields: "status_code" } });
        status = String(s.body.status_code ?? "IN_PROGRESS");
      }
      if (status === "ERROR") throw new PublishError("media", "Instagram couldn't process the image. Check it is a public JPEG between 4:5 and 1.91:1.");
      if (status === "EXPIRED") throw new PublishError("transient", "The Instagram media container expired before publishing.");
      if (status !== "FINISHED") throw new PublishError("transient", "Instagram is still processing the image. Try again in a minute.");
      const published = await g.call("POST", `/${cred.externalAccountId}/media_publish`, { token: cred.token, params: { creation_id: creationId }, whilePosting: true });
      const mediaId = String(published.body.id ?? "");
      if (!mediaId) throw new PublishError("ambiguous", `${MESSAGES.ambiguous} (no media id in the response)`, { response: redact(published.body) });
      let url: string | null = null;
      try {
        const m = await g.call("GET", `/${mediaId}`, { token: cred.token, params: { fields: "permalink" } });
        url = typeof m.body.permalink === "string" && m.body.permalink.startsWith("https://") ? m.body.permalink : null;
      } catch {
        // The post exists; the link can be fetched later.
      }
      return { externalPostId: mediaId, url, response: redact({ container: container.body, published: published.body }), usage: published.usage };
    },
    async findExisting(cred, input, since) {
      const r = await g.call("GET", `/${cred.externalAccountId}/media`, { token: cred.token, params: { fields: "id,caption,timestamp,permalink", limit: "25" } });
      const want = instagramCaption(input);
      const hit = ((Array.isArray(r.body.data) ? r.body.data : []) as Record<string, unknown>[]).find(
        (m) => same(m.caption, want) && (typeof m.timestamp !== "string" || Date.parse(m.timestamp) >= since.getTime() - 60_000),
      );
      if (!hit) return null;
      return { externalPostId: String(hit.id), url: typeof hit.permalink === "string" && hit.permalink.startsWith("https://") ? hit.permalink : null, response: redact(hit) };
    },
    async metrics(cred, mediaId): Promise<Metrics> {
      const r = await g.call("GET", `/${mediaId}`, { token: cred.token, params: { fields: "like_count,comments_count" } });
      const n = (k: string) => (typeof r.body[k] === "number" ? (r.body[k] as number) : null);
      // like_count is hidden when the owner turns off like counts; it then stays "unavailable", not zero.
      return { likes: n("like_count"), comments: n("comments_count") };
    },
    async checkAccount(cred) {
      const r = await g.call("GET", `/${cred.externalAccountId}`, { token: cred.token, params: { fields: "id,username" } });
      return { name: String(r.body.username ?? cred.externalAccountId) };
    },
  };
}

export type { AccountCredential, PublishResult };
