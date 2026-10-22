// Real publishing of approved post variants to connected accounts. Each variant+account pair has one
// job keyed by an idempotency key, so a double click or a retry can't post twice. An ambiguous answer
// from the platform parks the job in "needs_check" until someone confirms whether the post went out.
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertCan, NotFound, type Permission } from "../policy";
import type { SocialContext } from "../repo";
import type { Platform } from "../platforms";
import { PLATFORM_RULES } from "../content/rules";
import { accountCredential, ACCOUNT_COLUMNS, type AccountRow } from "./connections";
import { checkImage, type ImageCheck, type ImageFetcher } from "./media";
import { PublishError, RETRYABLE, type PublishAdapter, type PublishInput, type PublishResult } from "./types";
import { cancelPostJobs, notify } from "../automation/jobs";
import { backoffSeconds } from "../automation/time";

export type PublishDeps = {
  adapters: Partial<Record<Platform, PublishAdapter>>;
  // Why each platform's adapter is off (missing app keys, not built yet), for messages.
  unavailable?: Partial<Record<string, string>>;
  encryptionKey: string;
  fetchImage: ImageFetcher;
  now?: () => Date;
  // How long after an ambiguous attempt "not found on the platform" is trusted.
  settleSeconds?: number;
};

export class PublishBlocked extends Error {
  name = "PublishBlocked";
  reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join(" "));
    this.reasons = reasons;
  }
}

type VariantRow = {
  id: string;
  post_id: string;
  platform: string;
  body: string;
  hashtags: string[];
  link_url: string | null;
  image_url: string | null;
  image_check: ImageCheck | null;
  social_account_id: string | null;
  status: string;
  validation: { errors?: string[]; warnings?: string[] } | null;
  external_post_id: string | null;
  external_url: string | null;
  published_at: string | null;
  metrics: Record<string, number | null> | null;
  metrics_fetched_at: string | null;
};
type PostRow = { id: string; brand_id: string; status: string; title: string };
export type JobRow = {
  id: string;
  variant_id: string;
  social_account_id: string | null;
  status: "pending" | "claimed" | "succeeded" | "failed" | "needs_check" | "cancelled" | "paused" | "skipped" | "dead";
  attempts: number;
  max_attempts: number;
  idempotency_key: string;
  locked_at: string | null;
  last_error: string | null;
  external_post_id: string | null;
  run_at: string;
  updated_at: string;
  source: "manual" | "schedule" | "automation";
  timezone: string;
  local_time: string | null;
  brand_id: string | null;
  requested_by: string | null;
};

// "manual": a person pressed Publish and sees the result. "queue": the worker ran a scheduled job,
// so retryable errors are retried later and anything else ends in the dead-letter state with an alert.
type RunMode = "manual" | "queue";

const MAX_ATTEMPTS = 5;
const STALE_LOCK_MS = 5 * 60_000;

function check<T>({ data, error }: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as T;
}

export const jobKey = (variantId: string, accountId: string) => `publish:${variantId}:${accountId}`;

export function publishService(client: SupabaseClient, ctx: SocialContext, deps: PublishDeps) {
  const ws = ctx.workspaceId;
  const now = () => deps.now?.() ?? new Date();
  const can = (p: Permission) => assertCan(ctx.role, p);

  async function audit(action: string, entityType: string, entityId: string | null, details: Record<string, unknown> = {}) {
    check(await client.from("audit_events").insert({ workspace_id: ws, actor_email: ctx.email, action, entity_type: entityType, entity_id: entityId, details }));
  }

  async function variant(id: string) {
    const v = check(await client.from("post_variants").select("*").eq("workspace_id", ws).eq("id", id).maybeSingle()) as VariantRow | null;
    if (!v) throw new NotFound("Post version");
    return v;
  }
  async function post(id: string) {
    const p = check(await client.from("posts").select("id, brand_id, status, title").eq("workspace_id", ws).eq("id", id).maybeSingle()) as PostRow | null;
    if (!p) throw new NotFound("Post");
    return p;
  }
  async function account(id: string) {
    const a = check(await client.from("social_accounts").select(ACCOUNT_COLUMNS).eq("workspace_id", ws).eq("id", id).maybeSingle()) as AccountRow | null;
    if (!a) throw new NotFound("Account");
    return a;
  }
  async function jobByKey(key: string) {
    return check(await client.from("scheduled_jobs").select("*").eq("workspace_id", ws).eq("idempotency_key", key).maybeSingle()) as JobRow | null;
  }
  async function job(id: string) {
    const j = check(await client.from("scheduled_jobs").select("*").eq("workspace_id", ws).eq("id", id).maybeSingle()) as JobRow | null;
    if (!j) throw new NotFound("Publishing job");
    return j;
  }

  const inputOf = (v: VariantRow): PublishInput => ({ body: v.body, hashtags: v.hashtags ?? [], link: v.link_url, imageUrl: v.image_url });

  // The post's status follows its variants that have an account.
  async function syncPostStatus(postId: string) {
    const vs = (check(await client.from("post_variants").select("status, social_account_id").eq("workspace_id", ws).eq("post_id", postId)) as { status: string; social_account_id: string | null }[]).filter((v) => v.social_account_id);
    const p = await post(postId);
    if (!["approved", "scheduled", "publishing", "published", "failed"].includes(p.status)) return;
    const status = vs.some((v) => v.status === "publishing")
      ? "publishing"
      : vs.length && vs.every((v) => v.status === "published")
        ? "published"
        : vs.some((v) => v.status === "failed")
          ? "failed"
          : vs.some((v) => v.status === "scheduled")
            ? "scheduled"
            : "approved";
    if (status !== p.status) check(await client.from("posts").update({ status }).eq("workspace_id", ws).eq("id", postId));
  }

  async function recordSuccess(j: JobRow, v: VariantRow, a: AccountRow, attemptNo: number, r: PublishResult, outcome: "success" | "reconciled") {
    const at = now().toISOString();
    check(await client.from("publish_attempts").update({ finished_at: at, outcome, external_post_id: r.externalPostId, response: r.response ?? null, error_kind: null, error_code: null, error_message: null }).eq("workspace_id", ws).eq("job_id", j.id).eq("attempt_no", attemptNo));
    check(await client.from("scheduled_jobs").update({ status: "succeeded", locked_at: null, locked_by: null, last_error: null, external_post_id: r.externalPostId }).eq("workspace_id", ws).eq("id", j.id));
    check(await client.from("post_variants").update({ status: "published", external_post_id: r.externalPostId, external_url: r.url, published_at: at }).eq("workspace_id", ws).eq("id", v.id));
    if (r.usage && (r.usage.percent >= 95 || r.usage.regainSeconds)) {
      const until = new Date(now().getTime() + (r.usage.regainSeconds ?? 900) * 1000).toISOString();
      check(await client.from("social_accounts").update({ rate_limited_until: until }).eq("workspace_id", ws).eq("id", a.id));
    }
    await syncPostStatus(v.post_id);
    await audit(outcome === "success" ? "post.published" : "post.publish_confirmed", "post", v.post_id, { variant_id: v.id, platform: v.platform, account_id: a.id, external_post_id: r.externalPostId });
  }

  async function recordFailure(j: JobRow, v: VariantRow, a: AccountRow, attemptNo: number, e: PublishError, mode: RunMode) {
    const at = now().toISOString();
    const ambiguous = e.kind === "ambiguous";
    const retry = mode === "queue" && !ambiguous && RETRYABLE.includes(e.kind) && j.attempts < j.max_attempts;
    const status: JobRow["status"] = ambiguous ? "needs_check" : mode === "manual" ? "failed" : retry ? "pending" : "dead";
    check(
      await client
        .from("publish_attempts")
        .update({ finished_at: at, outcome: ambiguous ? "ambiguous" : "error", http_status: e.status, error_kind: e.kind, error_code: e.code, error_message: e.message.slice(0, 1000), response: e.response ?? null })
        .eq("workspace_id", ws)
        .eq("job_id", j.id)
        .eq("attempt_no", attemptNo),
    );
    const runAt = retry ? new Date(now().getTime() + backoffSeconds(j.attempts, e.retryAfterSeconds) * 1000).toISOString() : undefined;
    check(await client.from("scheduled_jobs").update({ status, locked_at: null, locked_by: null, last_error: e.message.slice(0, 1000), ...(runAt ? { run_at: runAt } : {}) }).eq("workspace_id", ws).eq("id", j.id));
    if (!ambiguous) check(await client.from("post_variants").update({ status: retry ? "scheduled" : "failed" }).eq("workspace_id", ws).eq("id", v.id));
    if (e.kind === "auth" || e.kind === "permission") check(await client.from("social_accounts").update({ status: "needs_reconnect", last_error: e.message.slice(0, 1000) }).eq("workspace_id", ws).eq("id", a.id));
    if (e.kind === "rate_limit") check(await client.from("social_accounts").update({ rate_limited_until: new Date(now().getTime() + (e.retryAfterSeconds ?? 900) * 1000).toISOString() }).eq("workspace_id", ws).eq("id", a.id));
    await syncPostStatus(v.post_id);
    await audit(ambiguous ? "post.publish_unclear" : retry ? "post.publish_retry" : "post.publish_failed", "post", v.post_id, { variant_id: v.id, platform: v.platform, kind: e.kind, code: e.code, ...(runAt ? { retry_at: runAt } : {}) });
    if (mode === "queue" && !retry) {
      const p = await post(v.post_id);
      await notify(client, ws, ambiguous
        ? { brand_id: p.brand_id, kind: "publish_unclear", severity: "warning", title: `Check whether "${p.title}" posted to ${a.display_name}`, body: "The platform's answer was unclear. It won't be retried until it is checked.", entity_type: "job", entity_id: j.id, dedupe_key: `job:${j.id}` }
        : { brand_id: p.brand_id, kind: "publish_failed", severity: "error", title: `"${p.title}" was not published to ${a.display_name}`, body: e.message, entity_type: "job", entity_id: j.id, dedupe_key: `job:${j.id}` });
      if (e.kind === "auth" || e.kind === "permission")
        await notify(client, ws, { brand_id: a.brand_id, kind: "account_disconnected", severity: "error", title: `${a.display_name} needs to be reconnected`, body: e.message, entity_type: "social_account", entity_id: a.id, dedupe_key: `account:${a.id}:reconnect` });
    }
  }

  // Sends one claimed job's post to the platform and records the result. The caller has claimed the job.
  async function attempt(j: JobRow, v: VariantRow, a: AccountRow, adapter: PublishAdapter, mode: RunMode) {
    const attemptNo = j.attempts;
    check(await client.from("publish_attempts").insert({ workspace_id: ws, job_id: j.id, attempt_no: attemptNo, started_at: now().toISOString() }));
    check(await client.from("post_variants").update({ status: "publishing" }).eq("workspace_id", ws).eq("id", v.id));
    await syncPostStatus(v.post_id);

    const token = await accountCredential(client, ws, a.id, deps.encryptionKey);
    try {
      if (!token) throw new PublishError("auth", "This account has no stored token. Connect it again.");
      const r = await adapter.publish({ externalAccountId: a.external_account_id, token }, inputOf(v));
      await recordSuccess(j, v, a, attemptNo, r, "success");
      return { outcome: "published" as const, url: r.url, externalPostId: r.externalPostId };
    } catch (e) {
      const err = e instanceof PublishError ? e : new PublishError("unknown", e instanceof Error ? e.message : String(e));
      await recordFailure(j, v, a, attemptNo, err, mode);
      return { outcome: err.kind === "ambiguous" ? ("needs_check" as const) : ("failed" as const), kind: err.kind, message: err.message, retryable: RETRYABLE.includes(err.kind) };
    }
  }

  // A claimed job whose lock is older than STALE_LOCK_MS: if an attempt started, it may have posted.
  async function settleStaleClaim(j: JobRow) {
    const open = check(await client.from("publish_attempts").select("attempt_no").eq("workspace_id", ws).eq("job_id", j.id).eq("attempt_no", j.attempts).maybeSingle());
    if (!open) return;
    check(await client.from("publish_attempts").update({ finished_at: now().toISOString(), outcome: "ambiguous", error_kind: "ambiguous", error_message: "Publishing stopped before the platform's answer was recorded." }).eq("workspace_id", ws).eq("job_id", j.id).eq("attempt_no", j.attempts).is("finished_at", null));
    check(await client.from("scheduled_jobs").update({ status: "needs_check", locked_at: null, locked_by: null, last_error: "Publishing stopped midway. Check whether it posted before trying again." }).eq("workspace_id", ws).eq("id", j.id).eq("status", "claimed"));
    throw new PublishBlocked(["The last attempt stopped midway and may have posted. Check it before trying again."]);
  }

  const service = {
    // Everything that would stop this variant from being published right now, in plain words.
    async preflight(variantId: string, opts: { recheckImage?: boolean } = {}) {
      can("workspace.view");
      const v = await variant(variantId);
      const p = await post(v.post_id);
      const errors: string[] = [];
      const warnings: string[] = [...(v.validation?.warnings ?? [])];
      if (!["approved", "scheduled", "failed", "publishing", "published"].includes(p.status)) errors.push("Approve the post first.");
      if (v.status === "published") errors.push("This version is already published.");
      if (v.validation?.errors?.length) errors.push(...v.validation.errors);
      const adapter = deps.adapters[v.platform as Platform];
      if (!adapter) errors.push(deps.unavailable?.[v.platform] ?? `Publishing to ${PLATFORM_RULES[v.platform]?.label ?? v.platform} isn't available yet.`);
      let acc: AccountRow | null = null;
      if (!v.social_account_id) errors.push("Choose which account to post to.");
      else {
        acc = await account(v.social_account_id);
        if (acc.brand_id !== p.brand_id) errors.push("That account belongs to another brand.");
        if (acc.status !== "connected") errors.push(`${acc.display_name} needs to be reconnected (${acc.status.replace("_", " ")}).`);
        if (acc.rate_limited_until && new Date(acc.rate_limited_until) > now()) errors.push(`${acc.display_name} is rate limited until ${acc.rate_limited_until.slice(11, 16)} UTC.`);
        if (adapter) errors.push(...adapter.requirements(inputOf(v), acc.permitted_actions));
      }
      let image = v.image_check;
      if (v.image_url && (opts.recheckImage || !image || image.url !== v.image_url)) {
        image = await checkImage(v.image_url, v.platform, deps.fetchImage, now());
        check(await client.from("post_variants").update({ image_check: image }).eq("workspace_id", ws).eq("id", v.id));
      }
      if (image && v.image_url) {
        errors.push(...image.errors);
        warnings.push(...image.warnings);
      }
      return { errors: [...new Set(errors)], warnings: [...new Set(warnings)].filter((w) => !/needs an image when/.test(w) || !v.image_url), account: acc };
    },

    async assignAccount(variantId: string, accountId: string | null) {
      can("post.edit");
      const v = await variant(variantId);
      const p = await post(v.post_id);
      if (!["draft", "approved", "scheduled", "rejected", "failed"].includes(p.status) || ["published", "publishing", "scheduled"].includes(v.status)) throw new Error("This post can't change accounts now. Take it out of the queue first.");
      if (accountId) {
        const a = await account(accountId);
        if (a.brand_id !== p.brand_id) throw new Error("Choose an account of this post's brand.");
        if (a.platform !== v.platform) throw new Error(`Choose a ${PLATFORM_RULES[v.platform]?.label ?? v.platform} account.`);
      }
      const { error } = await client.from("post_variants").update({ social_account_id: accountId }).eq("workspace_id", ws).eq("id", v.id);
      if (error?.code === "23505") throw new Error("Another version of this post already goes to that account.");
      if (error) throw new Error(error.message);
      await audit("post_variant.account_set", "post", v.post_id, { variant_id: v.id, account_id: accountId });
    },

    // Attaches or removes an image link. Changing media sends an approved post back for approval.
    async setImage(variantId: string, url: string | null) {
      can("post.edit");
      const v = await variant(variantId);
      const p = await post(v.post_id);
      if (!["draft", "approved", "scheduled", "rejected", "failed"].includes(p.status) || ["published", "publishing"].includes(v.status)) throw new Error("This post can't be changed now.");
      const image = url ? await checkImage(url, v.platform, deps.fetchImage, now()) : null;
      if (await cancelPostJobs(client, ws, p.id, "The image changed, so the post needs approval again.")) await audit("post.unscheduled", "post", p.id, { reason: "edited" });
      check(await client.from("post_variants").update({ image_url: url, image_check: image, status: "draft" }).eq("workspace_id", ws).eq("id", v.id));
      if (p.status !== "draft") check(await client.from("posts").update({ status: "draft", approved_by: null, approved_at: null }).eq("workspace_id", ws).eq("id", p.id));
      return image;
    },

    // Publishes one approved variant now. Safe to call twice: the second call sees the first job.
    async publishNow(variantId: string) {
      can("post.publish");
      const current = await variant(variantId);
      if (current.status === "published") return { outcome: "already_published" as const, url: current.external_url };
      const pre = await service.preflight(variantId, { recheckImage: true });
      if (pre.errors.length) throw new PublishBlocked(pre.errors);
      const v = await variant(variantId);
      const a = pre.account!;
      const adapter = deps.adapters[v.platform as Platform]!;
      const key = jobKey(v.id, a.id);
      let j = await jobByKey(key);
      const stamp = now().toISOString();
      if (j?.status === "succeeded") return { outcome: "already_published" as const, url: v.external_url };
      if (j?.status === "needs_check") throw new PublishBlocked(["The last attempt may have posted. Check it before trying again."]);
      if (j?.status === "claimed") {
        if (j.locked_at && now().getTime() - new Date(j.locked_at).getTime() < STALE_LOCK_MS) throw new PublishBlocked(["This post is being published right now."]);
        await settleStaleClaim(j);
      }
      if (j && j.attempts >= j.max_attempts) throw new PublishBlocked([`This version has been tried ${j.attempts} times. See Publishing History.`]);

      if (!j) {
        const { data, error } = await client
          .from("scheduled_jobs")
          .insert({ workspace_id: ws, brand_id: a.brand_id, variant_id: v.id, social_account_id: a.id, run_at: stamp, status: "claimed", attempts: 1, max_attempts: MAX_ATTEMPTS, idempotency_key: key, locked_at: stamp, locked_by: ctx.email, requested_by: ctx.email })
          .select("*")
          .single();
        if (error?.code === "23505") throw new PublishBlocked(["This post is being published right now."]);
        if (error) throw new Error(error.message);
        j = data as JobRow;
      } else {
        // Claim only if nobody else changed the job since we read it.
        const claimed = check(
          await client
            .from("scheduled_jobs")
            .update({ status: "claimed", attempts: j.attempts + 1, max_attempts: Math.max(j.max_attempts, Math.min(100, j.attempts + 1)), locked_at: stamp, locked_by: ctx.email, last_error: null })
            .eq("workspace_id", ws)
            .eq("id", j.id)
            .eq("status", j.status)
            .eq("attempts", j.attempts)
            .select("*"),
        ) as JobRow[];
        if (!claimed.length) throw new PublishBlocked(["This post is being published right now."]);
        j = claimed[0];
      }
      return attempt(j, v, a, adapter, "manual");
    },

    // The worker's half of publishNow, for a job it already claimed: check everything again, then post.
    // Anything that fails the checks ends the job (dead letter) with the reasons; it is never sent.
    async runClaimedJob(jobId: string) {
      can("post.publish");
      const j = await job(jobId);
      if (j.status !== "claimed") throw new Error(`Job ${j.id} is ${j.status}, not claimed.`);
      const v = await variant(j.variant_id);
      const p = await post(v.post_id);
      const fail = async (reasons: string[], kind: string) => {
        check(await client.from("scheduled_jobs").update({ status: "dead", attempts: Math.max(0, j.attempts - 1), locked_at: null, locked_by: null, last_error: reasons.join(" ").slice(0, 1000) }).eq("workspace_id", ws).eq("id", j.id));
        check(await client.from("post_variants").update({ status: "failed" }).eq("workspace_id", ws).eq("id", v.id).neq("status", "published"));
        await syncPostStatus(v.post_id);
        await audit("post.publish_blocked", "post", v.post_id, { job_id: j.id, reasons });
        await notify(client, ws, { brand_id: p.brand_id, kind, severity: "error", title: `"${p.title}" was not published`, body: reasons.join(" "), entity_type: "job", entity_id: j.id, dedupe_key: `job:${j.id}` });
        return { outcome: "blocked" as const, reasons };
      };
      if (v.status === "published") {
        check(await client.from("scheduled_jobs").update({ status: "succeeded", attempts: Math.max(0, j.attempts - 1), locked_at: null, locked_by: null, external_post_id: v.external_post_id }).eq("workspace_id", ws).eq("id", j.id));
        return { outcome: "already_published" as const };
      }
      // Never post to a different account than the one this job was queued for.
      if (j.social_account_id !== v.social_account_id) return fail(["The post's account changed after it was queued. Schedule it again."], "publish_blocked");
      const pre = await service.preflight(v.id, { recheckImage: true });
      // Only a rate limit in the way: wait until the platform says it's safe, without using up an attempt.
      if (pre.errors.length && pre.errors.every((e) => /rate limited/.test(e)) && pre.account?.rate_limited_until) {
        check(await client.from("scheduled_jobs").update({ status: "pending", attempts: Math.max(0, j.attempts - 1), run_at: pre.account.rate_limited_until, locked_at: null, locked_by: null, last_error: pre.errors[0] }).eq("workspace_id", ws).eq("id", j.id));
        return { outcome: "deferred" as const, until: pre.account.rate_limited_until };
      }
      if (pre.errors.length) {
        const kind = pre.account && pre.account.status !== "connected" ? "account_disconnected" : v.image_url && pre.errors.some((e) => /image/i.test(e)) ? "media_failed" : "publish_blocked";
        return fail(pre.errors, kind);
      }
      return attempt(j, await variant(v.id), pre.account!, deps.adapters[v.platform as Platform]!, "queue");
    },

    // Settles an ambiguous attempt by looking for the post on the platform. Only after that can it be retried.
    async checkJob(jobId: string, opts: { requeue?: boolean } = {}) {
      can("post.publish");
      const j = await job(jobId);
      if (j.status !== "needs_check") throw new Error("This job doesn't need checking.");
      const v = await variant(j.variant_id);
      const a = await account(j.social_account_id ?? v.social_account_id ?? "");
      const adapter = deps.adapters[v.platform as Platform];
      if (!adapter) throw new Error("Publishing to this platform is switched off, so it can't be checked.");
      const token = await accountCredential(client, ws, a.id, deps.encryptionKey);
      if (!token) throw new Error("This account has no stored token. Reconnect it, then check again.");
      const last = check(await client.from("publish_attempts").select("attempt_no, started_at").eq("workspace_id", ws).eq("job_id", j.id).order("attempt_no", { ascending: false }).limit(1).single()) as { attempt_no: number; started_at: string };
      const since = new Date(last.started_at);
      const found = await adapter.findExisting({ externalAccountId: a.external_account_id, token }, inputOf(v), since);
      if (found) {
        await recordSuccess(j, v, a, last.attempt_no, found, "reconciled");
        return { outcome: "published" as const, url: found.url };
      }
      if (now().getTime() - since.getTime() < (deps.settleSeconds ?? 120) * 1000) {
        return { outcome: "wait" as const, message: "Not visible on the platform yet. Check again in a couple of minutes." };
      }
      // Not there: a queued job goes back in the queue, a manual one waits for a person to retry.
      const requeue = opts.requeue && j.attempts < j.max_attempts;
      check(await client.from("scheduled_jobs").update({ status: requeue ? "pending" : "failed", run_at: requeue ? now().toISOString() : j.run_at, last_error: "Checked: the post isn't on the platform, so it's safe to try again." }).eq("workspace_id", ws).eq("id", j.id));
      check(await client.from("post_variants").update({ status: requeue ? "scheduled" : "failed" }).eq("workspace_id", ws).eq("id", v.id));
      await syncPostStatus(v.post_id);
      await audit("post.publish_checked", "post", v.post_id, { variant_id: v.id, found: false });
      return { outcome: "not_found" as const };
    },

    // Puts an approved variant in the queue for `at`. The same checks as publishing run now, so a post
    // that can't go out is refused here instead of failing later (a rate limit is only a warning).
    async enqueue(variantId: string, at: { runAt: Date; timezone: string; local: string; source: "schedule" | "automation" }) {
      can("post.publish");
      if (at.runAt.getTime() <= now().getTime()) throw new Error("Choose a time in the future.");
      const pre = await service.preflight(variantId);
      const blocking = pre.errors.filter((e) => !/rate limited/.test(e));
      if (blocking.length) throw new PublishBlocked(blocking);
      const v = await variant(variantId);
      const a = pre.account!;
      const key = jobKey(v.id, a.id);
      const existing = await jobByKey(key);
      const fields = { run_at: at.runAt.toISOString(), timezone: at.timezone, local_time: at.local, source: at.source, status: "pending", last_error: null, locked_at: null, locked_by: null, requested_by: ctx.email };
      const conflict = (error: { message: string; code?: string } | null) => {
        if (error?.code === "23505" && /account_slot/.test(error.message)) throw new Error(`Another post is already queued for ${a.display_name} at ${at.local}.`);
        if (error?.code === "23505") throw new Error("This post is already in the queue.");
        if (error) throw new Error(error.message);
      };
      let jobId: string;
      if (existing) {
        if (["pending", "claimed", "paused"].includes(existing.status)) throw new Error("This post is already in the queue. Reschedule it from the Queue page.");
        if (existing.status === "succeeded") throw new Error("This version is already published.");
        if (existing.status === "needs_check") throw new Error("The last attempt may have posted. Check it before scheduling again.");
        const { data, error } = await client
          .from("scheduled_jobs")
          .update({ ...fields, max_attempts: Math.min(100, existing.attempts + MAX_ATTEMPTS) })
          .eq("workspace_id", ws)
          .eq("id", existing.id)
          .eq("status", existing.status)
          .select("id");
        conflict(error);
        if (!data?.length) throw new Error("The queue changed while scheduling. Try again.");
        jobId = existing.id;
      } else {
        const { data, error } = await client
          .from("scheduled_jobs")
          .insert({ ...fields, workspace_id: ws, brand_id: a.brand_id, variant_id: v.id, social_account_id: a.id, idempotency_key: key, attempts: 0, max_attempts: MAX_ATTEMPTS })
          .select("id")
          .single();
        conflict(error);
        jobId = (data as { id: string }).id;
      }
      check(await client.from("post_variants").update({ status: "scheduled" }).eq("workspace_id", ws).eq("id", v.id));
      await syncPostStatus(v.post_id);
      await audit("post.scheduled", "post", v.post_id, { variant_id: v.id, job_id: jobId, run_at: fields.run_at, timezone: at.timezone, source: at.source });
      return { jobId, warnings: pre.warnings.concat(pre.errors.filter((e) => /rate limited/.test(e))) };
    },

    syncPostStatus: (postId: string) => syncPostStatus(postId),

    // Reads the metrics the platform supports. Missing values stay null ("unavailable"), never zero.
    async refreshMetrics(variantId: string) {
      can("workspace.view");
      const v = await variant(variantId);
      if (v.status !== "published" || !v.external_post_id || !v.social_account_id) throw new Error("Only published posts have metrics.");
      const a = await account(v.social_account_id);
      if (!a.permitted_actions.includes("read_metrics")) throw new Error("This account wasn't granted access to read metrics.");
      const adapter = deps.adapters[v.platform as Platform];
      const token = await accountCredential(client, ws, a.id, deps.encryptionKey);
      if (!adapter || !token) throw new Error("Metrics can't be read for this account right now.");
      const metrics = await adapter.metrics({ externalAccountId: a.external_account_id, token }, v.external_post_id);
      check(await client.from("post_variants").update({ metrics, metrics_fetched_at: now().toISOString() }).eq("workspace_id", ws).eq("id", v.id));
      return metrics;
    },

    async jobsForPosts(postIds: string[]) {
      can("workspace.view");
      if (!postIds.length) return [] as (JobRow & { variant_id: string })[];
      const variants = check(await client.from("post_variants").select("id").eq("workspace_id", ws).in("post_id", postIds)) as { id: string }[];
      if (!variants.length) return [];
      return check(await client.from("scheduled_jobs").select("*").eq("workspace_id", ws).in("variant_id", variants.map((x) => x.id)).order("updated_at", { ascending: false })) as JobRow[];
    },
  };
  return service;
}

export type PublishService = ReturnType<typeof publishService>;
