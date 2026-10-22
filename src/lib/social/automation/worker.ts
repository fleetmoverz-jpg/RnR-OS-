// The background worker, run every few minutes by /api/cron/social. One run:
//   1. recovers jobs whose worker died (they become "needs check" if they might have posted)
//   2. per workspace (skipped entirely while paused): settles unclear attempts, raises alerts for
//      disconnected accounts and expiring logins, writes drafts and fills free slots per brand
//   3. claims due jobs (FOR UPDATE SKIP LOCKED) and publishes them, within the daily and monthly limits
// Every step is idempotent, so a crash or an overlapping run can't post twice.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SocialContext } from "../repo";
import type { Platform } from "../platforms";
import { contentService, ProfileNotApproved, UsageLimitReached, type ContentDeps } from "../content/service";
import { publishService, jobKey, type JobRow, type PublishDeps } from "../publish/service";
import { notify } from "./jobs";
import { errorText, logError, scrub } from "../log";
import { MODE_INFO, DEFAULT_SETTINGS, type AutomationSettings, type BrandAutomation } from "./queue";
import { upcomingSlots, utcDayStart, utcMonthStart, weekOfInstant } from "./time";

// Who the worker acts as in audit logs and on generated posts.
export const AUTOMATION_ACTOR = "automation@rnr-os";

export type WorkerDeps = {
  workerId: string;
  publish: PublishDeps;
  // AI for writing drafts. Null when no provider is configured: generation is skipped with an alert.
  content: ContentDeps | null;
  now?: () => Date;
  // Stop starting new work after this many milliseconds.
  budgetMs?: number;
  staleSeconds?: number;
  settleSeconds?: number;
  horizonDays?: number;
  // Minimum gap between two generation rounds for one brand.
  generateEverySeconds?: number;
  // Only these workspaces (tests, or one tenant's manual run). Default: all.
  workspaceIds?: string[];
};

export type WorkerStats = {
  recovered: number;
  needsCheck: number;
  reconciled: number;
  planned: number;
  generated: number;
  autoApproved: number;
  claimed: number;
  published: number;
  failed: number;
  pausedWorkspaces: number;
  limitedWorkspaces: number;
  errors: string[];
};

function check<T>({ data, error }: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as T;
}
export { scrub };
const message = errorText;

export async function runWorker(client: SupabaseClient, deps: WorkerDeps): Promise<WorkerStats> {
  const now = () => deps.now?.() ?? new Date();
  const started = Date.now();
  const timeLeft = () => Date.now() - started < (deps.budgetMs ?? 45_000);
  const stats: WorkerStats = { recovered: 0, needsCheck: 0, reconciled: 0, planned: 0, generated: 0, autoApproved: 0, claimed: 0, published: 0, failed: 0, pausedWorkspaces: 0, limitedWorkspaces: 0, errors: [] };
  const run = check(await client.from("worker_runs").insert({ worker: deps.workerId, started_at: now().toISOString() }).select("id").single()) as { id: number };
  const ctxFor = (workspaceId: string): SocialContext => ({ workspaceId, email: AUTOMATION_ACTOR, role: "admin" });
  const pub = (ws: string) => publishService(client, ctxFor(ws), { ...deps.publish, now, settleSeconds: deps.settleSeconds });

  try {
    // 1. Jobs whose worker vanished mid-run.
    const recovered = check(await client.rpc("social_recover_stale_jobs", { p_stale_seconds: deps.staleSeconds ?? 300, p_now: now().toISOString(), p_only: deps.workspaceIds ?? null })) as { job_id: string; workspace_id: string; outcome: string }[];
    stats.recovered = recovered.length;
    for (const r of recovered.filter((x) => x.outcome === "needs_check")) {
      stats.needsCheck++;
      await notify(client, r.workspace_id, { kind: "publish_unclear", severity: "warning", title: "A post may or may not have gone out", body: "Publishing stopped midway. It will be checked on the platform before any retry.", entity_type: "job", entity_id: r.job_id, dedupe_key: `job:${r.job_id}` });
    }

    // 2. Each workspace.
    const workspaces = deps.workspaceIds ? deps.workspaceIds.map((id) => ({ id })) : (check(await client.from("workspaces").select("id")) as { id: string }[]);
    const skip: string[] = [];
    const remaining = new Map<string, number>();
    for (const { id: ws } of workspaces) {
      if (!timeLeft()) break;
      try {
        const settings = ((check(await client.from("automation_settings").select("*").eq("workspace_id", ws).maybeSingle()) as AutomationSettings | null) ?? { workspace_id: ws, ...DEFAULT_SETTINGS });
        if (settings.paused) {
          stats.pausedWorkspaces++;
          skip.push(ws);
          continue;
        }
        await settleUnclear(ws);
        await healthAlerts(ws);
        const left = await postsLeft(ws, settings);
        if (left <= 0) {
          stats.limitedWorkspaces++;
          skip.push(ws);
        } else remaining.set(ws, left);
        const brands = check(await client.from("brand_automation").select("*, brands!inner(name, timezone, status)").eq("workspace_id", ws).eq("enabled", true).eq("paused", false).eq("brands.status", "active")) as (BrandAutomation & { brands: { name: string; timezone: string } })[];
        for (const b of brands) {
          if (!timeLeft()) break;
          try {
            await planBrand(ws, b, settings);
          } catch (e) {
            stats.errors.push(`brand ${b.brand_id}: ${message(e)}`);
            await notify(client, ws, { brand_id: b.brand_id, kind: "automation_error", severity: "error", title: `Automation for ${b.brands.name} hit a problem`, body: message(e), dedupe_key: `brand:${b.brand_id}:error` });
          }
        }
      } catch (e) {
        stats.errors.push(`workspace ${ws}: ${message(e)}`);
      }
    }

    // 3. Publish what is due.
    while (timeLeft()) {
      const jobs = check(await client.rpc("social_claim_due_jobs", { p_worker: deps.workerId, p_limit: 5, p_now: now().toISOString(), p_skip: skip, p_only: deps.workspaceIds ?? null })) as JobRow[] & { workspace_id: string }[];
      if (!jobs.length) break;
      for (const j of jobs as (JobRow & { workspace_id: string })[]) {
        stats.claimed++;
        const ws = j.workspace_id;
        if (skip.includes(ws)) {
          // The limit was reached by an earlier job in this batch: give the claim back untouched.
          check(await client.from("scheduled_jobs").update({ status: "pending", attempts: j.attempts - 1, locked_at: null, locked_by: null }).eq("id", j.id).eq("status", "claimed"));
          continue;
        }
        try {
          const r = await pub(ws).runClaimedJob(j.id);
          if (r.outcome === "published") {
            stats.published++;
            const left = (remaining.get(ws) ?? 1) - 1;
            remaining.set(ws, left);
            if (left <= 0) {
              skip.push(ws);
              await notify(client, ws, { kind: "limit_reached", severity: "info", title: "Post limit reached", body: "Queued posts wait until the daily or monthly limit allows more. Change it in Automation.", dedupe_key: `limit:${utcDayStart(now())}` });
            }
          } else if (r.outcome === "failed" || r.outcome === "needs_check" || r.outcome === "blocked") stats.failed++;
        } catch (e) {
          // Left claimed on purpose: stale-job recovery decides later whether it might have posted.
          stats.failed++;
          stats.errors.push(`job ${j.id}: ${message(e)}`);
        }
      }
    }
  } catch (e) {
    stats.errors.push(message(e));
    logError("worker", e, { worker: deps.workerId });
  }

  check(await client.from("worker_runs").update({ finished_at: now().toISOString(), stats, error: stats.errors.length ? stats.errors.join("\n").slice(0, 2000) : null }).eq("id", run.id));
  // Keep two weeks of run history.
  await client.from("worker_runs").delete().lt("started_at", new Date(now().getTime() - 14 * 864e5).toISOString());
  return stats;

  // ---- steps

  // Queued jobs left unclear are looked up on the platform once the platform had time to settle.
  async function settleUnclear(ws: string) {
    const settle = (deps.settleSeconds ?? 120) * 1000;
    const jobs = check(await client.from("scheduled_jobs").select("id").eq("workspace_id", ws).eq("status", "needs_check").in("source", ["schedule", "automation"]).lt("updated_at", new Date(now().getTime() - settle).toISOString()).limit(10)) as { id: string }[];
    for (const j of jobs) {
      try {
        const r = await pub(ws).checkJob(j.id, { requeue: true });
        if (r.outcome === "published") stats.reconciled++;
      } catch (e) {
        stats.errors.push(`check ${j.id}: ${message(e)}`);
      }
    }
  }

  async function healthAlerts(ws: string) {
    const soon = new Date(now().getTime() + 24 * 3600_000).toISOString();
    const queued = check(await client.from("scheduled_jobs").select("social_account_id, social_accounts(display_name, status, brand_id)").eq("workspace_id", ws).in("status", ["pending", "paused"]).lt("run_at", soon)) as unknown as { social_account_id: string; social_accounts: { display_name: string; status: string; brand_id: string } | null }[];
    for (const q of queued) {
      const a = q.social_accounts;
      if (a && a.status !== "connected")
        await notify(client, ws, { brand_id: a.brand_id, kind: "account_disconnected", severity: "error", title: `${a.display_name} needs to be reconnected`, body: "Posts are queued for this account in the next 24 hours. They will fail until it is reconnected. They will not be sent to another account.", entity_type: "social_account", entity_id: q.social_account_id, dedupe_key: `account:${q.social_account_id}:reconnect` });
    }
    const expiring = check(await client.from("meta_connections").select("id, meta_user_name, token_expires_at").eq("workspace_id", ws).eq("status", "active").lt("token_expires_at", new Date(now().getTime() + 7 * 864e5).toISOString())) as { id: string; meta_user_name: string | null; token_expires_at: string }[];
    for (const c of expiring)
      await notify(client, ws, { kind: "login_expiring", severity: "warning", title: `The Facebook login for ${c.meta_user_name ?? "your Pages"} expires ${c.token_expires_at.slice(0, 10)}`, body: "Reconnect it on Connected Accounts so scheduled posts keep going out.", entity_type: "meta_connection", entity_id: c.id, dedupe_key: `meta:${c.id}:expiring` });
  }

  async function postsLeft(ws: string, s: AutomationSettings) {
    const count = async (since: string) => {
      const { count, error } = await client.from("publish_attempts").select("id", { count: "exact", head: true }).eq("workspace_id", ws).in("outcome", ["success", "reconciled"]).gte("finished_at", since);
      if (error) throw new Error(error.message);
      return count ?? 0;
    };
    const left = Math.min(s.daily_post_limit - (await count(utcDayStart(now()))), s.monthly_post_limit - (await count(utcMonthStart(now()))));
    if (left <= 0) {
      const pending = check(await client.from("scheduled_jobs").select("id").eq("workspace_id", ws).eq("status", "pending").lte("run_at", now().toISOString()).limit(1)) as unknown[];
      if (pending.length) await notify(client, ws, { kind: "limit_reached", severity: "info", title: "Post limit reached", body: "Queued posts wait until the daily or monthly limit allows more. Change it in Automation.", dedupe_key: `limit:${utcDayStart(now())}` });
    }
    return left;
  }

  // Writes drafts ahead of the schedule and fills free slots, as the brand's mode allows.
  async function planBrand(ws: string, b: BrandAutomation & { brands: { name: string; timezone: string } }, settings: AutomationSettings) {
    const mode = MODE_INFO[b.mode];
    const tz = b.brands.timezone || "UTC";
    const horizon = deps.horizonDays ?? 7;
    const slots = upcomingSlots({ daysOfWeek: b.days_of_week, times: b.times, postsPerWeek: b.posts_per_week, timezone: tz }, now(), horizon);

    // Weekly counts include posts already published or queued this week, whoever scheduled them.
    const jobs = check(await client.from("scheduled_jobs").select("run_at, status").eq("workspace_id", ws).eq("brand_id", b.brand_id).in("status", ["pending", "claimed", "paused", "succeeded", "needs_check"]).gte("run_at", new Date(now().getTime() - 8 * 864e5).toISOString())) as { run_at: string; status: string }[];
    const taken = new Set(jobs.map((j) => Math.floor(new Date(j.run_at).getTime() / 60_000)));
    const perWeek = new Map<string, number>();
    for (const t of taken) {
      const wk = weekOfInstant(new Date(t * 60_000), tz);
      perWeek.set(wk, (perWeek.get(wk) ?? 0) + 1);
    }
    const free = slots.filter((s) => !taken.has(Math.floor(s.runAt.getTime() / 60_000)));
    const open = () => free.filter((s) => (perWeek.get(s.week) ?? 0) < b.posts_per_week);

    // Accounts this brand may post to automatically.
    const accounts = check(await client.from("social_accounts").select("id, platform, status, automation_paused, display_name").eq("workspace_id", ws).eq("brand_id", b.brand_id).eq("status", "connected").eq("automation_paused", false)) as { id: string; platform: string; display_name: string }[];
    const usable = accounts.filter((a) => deps.publish.adapters[a.platform as Platform]);
    const onlyAccount = (platform: string) => {
      const list = usable.filter((a) => a.platform === platform);
      return list.length === 1 ? list[0].id : null;
    };
    const content = deps.content ? contentService(client, ctxFor(ws), { ...deps.content, now }) : null;

    // Generation.
    if (mode.generates) {
      const due = !b.last_generated_at || now().getTime() - new Date(b.last_generated_at).getTime() >= (deps.generateEverySeconds ?? 3 * 3600) * 1000;
      const waiting = check(await client.from("posts").select("id").eq("workspace_id", ws).eq("brand_id", b.brand_id).in("status", ["draft", "approved"]).gte("created_at", new Date(now().getTime() - 30 * 864e5).toISOString())) as unknown[];
      const need = Math.min(3, open().length - waiting.length);
      const platforms = b.mode === "draft_only" && !usable.length ? null : [...new Set(usable.map((a) => a.platform))];
      if (due && need > 0) {
        if (!content || !deps.content?.text) {
          await notify(client, ws, { brand_id: b.brand_id, kind: "ai_unavailable", severity: "warning", title: `Automation can't write drafts for ${b.brands.name}`, body: deps.content?.textUnavailable ?? "No AI provider is configured.", dedupe_key: `brand:${b.brand_id}:ai` });
        } else if (platforms && !platforms.length) {
          await notify(client, ws, { brand_id: b.brand_id, kind: "no_accounts", severity: "warning", title: `${b.brands.name} has no connected account automation can post to`, body: "Connect a Facebook Page or Instagram account, or switch the account's automation on.", dedupe_key: `brand:${b.brand_id}:no_accounts` });
        } else if (await spentToday(ws) >= settings.daily_ai_cost_limit_usd) {
          await notify(client, ws, { kind: "spend_limit", severity: "warning", title: "Daily AI spending limit reached", body: `Automation stops writing drafts until tomorrow (UTC). The limit is $${settings.daily_ai_cost_limit_usd}.`, dedupe_key: `spend:${utcDayStart(now())}` });
        } else {
          check(await client.from("brand_automation").update({ last_generated_at: now().toISOString() }).eq("workspace_id", ws).eq("brand_id", b.brand_id));
          try {
            const strategy = await content.getStrategy(b.brand_id);
            const categories = b.categories.length ? b.categories : strategy.categories;
            const category = (categories[Math.floor(now().getTime() / 864e5) % categories.length] ?? null) as Parameters<typeof content.generateDrafts>[1]["category"];
            const r = await content.generateDrafts(b.brand_id, { platforms: platforms ?? strategy.platforms, quantity: need, category });
            stats.generated += r.postIds.length;
            if (b.mode === "fully_automatic") await autoApprove(ws, b, r.postIds, onlyAccount);
            else if (r.postIds.length) await notify(client, ws, { brand_id: b.brand_id, kind: "drafts_ready", severity: "info", title: `${r.postIds.length} new draft${r.postIds.length === 1 ? "" : "s"} for ${b.brands.name}`, body: b.mode === "approval_required" ? "Approve them in Content Studio and they go into the next free slots." : "Review them in Content Studio.", dedupe_key: `brand:${b.brand_id}:drafts:${utcDayStart(now())}` });
          } catch (e) {
            if (!(e instanceof UsageLimitReached || e instanceof ProfileNotApproved)) throw e;
            await notify(client, ws, { brand_id: b.brand_id, kind: e instanceof UsageLimitReached ? "spend_limit" : "profile_needed", severity: "warning", title: `Automation can't write drafts for ${b.brands.name}`, body: e.message, dedupe_key: `brand:${b.brand_id}:${e.name}` });
          }
        }
      }
    }

    // Queueing approved posts into free slots, oldest approval first.
    if (!mode.queues) return;
    const posts = check(await client.from("posts").select("id, title, approved_at").eq("workspace_id", ws).eq("brand_id", b.brand_id).eq("status", "approved").order("approved_at", { ascending: true }).limit(20)) as { id: string; title: string; approved_at: string }[];
    const p = pub(ws);
    for (const post of posts) {
      if (!open().length) break;
      const variants = check(await client.from("post_variants").select("id, platform, social_account_id, status, validation").eq("workspace_id", ws).eq("post_id", post.id).eq("status", "approved")) as { id: string; platform: string; social_account_id: string | null; validation: { errors?: string[] } | null }[];
      const eligible: string[] = [];
      for (const v of variants) {
        if (v.validation?.errors?.length) continue;
        let account = v.social_account_id;
        if (!account) {
          // Only an obvious choice is made automatically: the brand's single account for that platform.
          account = onlyAccount(v.platform);
          if (!account) continue;
          await p.assignAccount(v.id, account);
        }
        if (!usable.some((a) => a.id === account)) continue;
        // A person skipped or cancelled this after its last approval: leave it alone.
        const prior = check(await client.from("scheduled_jobs").select("status, updated_at").eq("workspace_id", ws).eq("idempotency_key", jobKey(v.id, account)).maybeSingle()) as { status: string; updated_at: string } | null;
        if (prior && !(["cancelled", "skipped"].includes(prior.status) && new Date(prior.updated_at) < new Date(post.approved_at))) continue;
        eligible.push(v.id);
      }
      if (!eligible.length) {
        if (variants.length)
          await notify(client, ws, { brand_id: b.brand_id, kind: "needs_account", severity: "warning", title: `"${post.title}" can't be queued`, body: "Choose which account each version goes to in Content Studio, or connect one.", entity_type: "post", entity_id: post.id, dedupe_key: `post:${post.id}:needs_account` });
        continue;
      }
      const slot = open()[0];
      let queued = 0;
      for (const id of eligible) {
        try {
          await p.enqueue(id, { runAt: slot.runAt, timezone: tz, local: slot.local, source: "automation" });
          queued++;
        } catch (e) {
          await notify(client, ws, { brand_id: b.brand_id, kind: "publish_blocked", severity: "warning", title: `"${post.title}" can't be queued`, body: message(e), entity_type: "post", entity_id: post.id, dedupe_key: `post:${post.id}:blocked` });
        }
      }
      if (queued) {
        stats.planned += queued;
        free.splice(free.indexOf(slot), 1);
        perWeek.set(slot.week, (perWeek.get(slot.week) ?? 0) + 1);
      }
    }
  }

  // Fully automatic: approve each new post only if every version passed validation and has an account.
  async function autoApprove(ws: string, b: BrandAutomation & { brands: { name: string } }, postIds: string[], onlyAccount: (platform: string) => string | null) {
    const p = pub(ws);
    const content = contentService(client, ctxFor(ws), { ...deps.content!, now });
    for (const postId of postIds) {
      const variants = check(await client.from("post_variants").select("id, platform, social_account_id, validation").eq("workspace_id", ws).eq("post_id", postId)) as { id: string; platform: string; social_account_id: string | null; validation: { errors?: string[] } | null }[];
      const problems = variants.flatMap((v) => v.validation?.errors ?? []);
      const unassigned = variants.filter((v) => !v.social_account_id && !onlyAccount(v.platform));
      if (!variants.length || problems.length || unassigned.length) {
        await notify(client, ws, { brand_id: b.brand_id, kind: "draft_needs_review", severity: "warning", title: `A draft for ${b.brands.name} needs your review`, body: problems.length ? `It failed checks: ${problems.slice(0, 3).join(" ")}` : "It has no clear account to post to.", entity_type: "post", entity_id: postId, dedupe_key: `post:${postId}:review` });
        continue;
      }
      for (const v of variants) if (!v.social_account_id) await p.assignAccount(v.id, onlyAccount(v.platform));
      await content.approvePost(postId);
      stats.autoApproved++;
    }
  }

  async function spentToday(ws: string) {
    const rows = check(await client.from("ai_generations").select("cost_usd").eq("workspace_id", ws).eq("status", "succeeded").gte("created_at", utcDayStart(now()))) as { cost_usd: number | null }[];
    return rows.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
  }
}
