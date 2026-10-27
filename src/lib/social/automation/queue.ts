// What people do with the queue and automation settings: schedule, pause, resume, reschedule, skip,
// cancel, the pause-all switch, limits, per-brand automation and per-account switches, and alerts.
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertCan, NotFound } from "../policy";
import type { SocialContext } from "../repo";
import type { PublishService } from "../publish/service";
import { isTimeZone, localLabel, utcDayStart, utcMonthStart, zonedToUtc } from "./time";

export const MODES = ["draft_only", "approval_required", "auto_publish_approved", "fully_automatic"] as const;
export type Mode = (typeof MODES)[number];
export const MODE_INFO: Record<Mode, { label: string; help: string; generates: boolean; queues: boolean }> = {
  draft_only: { label: "Draft only", help: "Writes drafts ahead of the schedule. Nothing is queued or published.", generates: true, queues: false },
  approval_required: { label: "Generate, then wait for approval", help: "Writes drafts. Each one you approve goes into the next free slot and is published then.", generates: true, queues: true },
  auto_publish_approved: { label: "Publish approved posts", help: "Writes nothing. Posts you approve go into the next free slots and are published then.", generates: false, queues: true },
  fully_automatic: { label: "Fully automatic", help: "Writes drafts, approves the ones that pass every check, and publishes them on schedule. Drafts with problems wait for you.", generates: true, queues: true },
};

export type AutomationSettings = {
  workspace_id: string;
  paused: boolean;
  paused_by: string | null;
  paused_at: string | null;
  daily_post_limit: number;
  monthly_post_limit: number;
  daily_ai_cost_limit_usd: number;
};
export type BrandAutomation = {
  brand_id: string;
  enabled: boolean;
  paused: boolean;
  mode: Mode;
  days_of_week: number[];
  times: string[];
  posts_per_week: number;
  categories: string[];
  full_auto_confirmed_by: string | null;
  full_auto_confirmed_at: string | null;
  last_generated_at: string | null;
};
export type QueueItem = {
  id: string;
  status: string;
  run_at: string;
  timezone: string;
  local_time: string | null;
  source: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  requested_by: string | null;
  brand_id: string | null;
  updated_at: string;
  social_accounts: { display_name: string; platform: string; status: string } | null;
  post_variants: { id: string; platform: string; body: string; external_url: string | null; posts: { id: string; title: string } | null } | null;
};
export type Notification = { id: string; brand_id: string | null; kind: string; severity: "info" | "warning" | "error"; title: string; body: string | null; entity_type: string | null; entity_id: string | null; created_at: string; read_at: string | null };
// Worker runs are shared by every workspace, so only their timing and health are shown, never their stats.
export type WorkerRun = { id: number; worker: string; started_at: string; finished_at: string | null; error: string | null };

export const DEFAULT_SETTINGS = { paused: false, paused_by: null, paused_at: null, daily_post_limit: 10, monthly_post_limit: 150, daily_ai_cost_limit_usd: 2 };
export const DEFAULT_BRAND_AUTOMATION = { enabled: false, paused: false, mode: "draft_only" as Mode, days_of_week: [1, 3, 5], times: ["10:00"], posts_per_week: 3, categories: [] as string[], full_auto_confirmed_by: null, full_auto_confirmed_at: null, last_generated_at: null };

export const VIEWS = {
  upcoming: ["pending", "claimed", "paused"],
  attention: ["needs_check", "dead", "failed"],
  done: ["succeeded", "skipped", "cancelled"],
} as const;
export type QueueView = keyof typeof VIEWS;

function check<T>({ data, error }: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as T;
}

const LOCAL = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/;

export function queueService(client: SupabaseClient, ctx: SocialContext, deps: { publish: PublishService; now?: () => Date }) {
  const ws = ctx.workspaceId;
  const now = () => deps.now?.() ?? new Date();
  const can = (p: Parameters<typeof assertCan>[1]) => assertCan(ctx.role, p);

  async function audit(action: string, entityType: string, entityId: string | null, details: Record<string, unknown> = {}) {
    check(await client.from("audit_events").insert({ workspace_id: ws, actor_email: ctx.email, action, entity_type: entityType, entity_id: entityId, details }));
  }
  async function job(id: string) {
    const j = check(await client.from("scheduled_jobs").select("id, status, run_at, variant_id, brand_id, social_account_id, attempts, max_attempts, timezone").eq("workspace_id", ws).eq("id", id).maybeSingle()) as
      | { id: string; status: string; run_at: string; variant_id: string; brand_id: string | null; social_account_id: string | null; attempts: number; max_attempts: number; timezone: string }
      | null;
    if (!j) throw new NotFound("Queued post");
    return j;
  }
  async function brandTimezone(brandId: string) {
    const b = check(await client.from("brands").select("timezone").eq("workspace_id", ws).eq("id", brandId).maybeSingle()) as { timezone: string } | null;
    if (!b) throw new NotFound("Brand");
    return isTimeZone(b.timezone) ? b.timezone : "UTC";
  }
  // "2026-10-23T10:00" in the brand's zone → the UTC instant, refusing the past.
  function when(local: string, tz: string) {
    const m = LOCAL.exec(local.trim());
    if (!m) throw new Error("Choose a date and time.");
    const runAt = zonedToUtc(m[1], m[2], tz);
    if (runAt.getTime() <= now().getTime() + 60_000) throw new Error("Choose a time at least a minute from now.");
    return { runAt, timezone: tz, local: localLabel(runAt, tz) };
  }
  // Conditional status change: only applies if the job is still in one of `from`.
  async function move(id: string, from: string[], fields: Record<string, unknown>) {
    const { data, error } = await client.from("scheduled_jobs").update(fields).eq("workspace_id", ws).eq("id", id).in("status", from).select("id, variant_id");
    if (error?.code === "23505") throw new Error("Another post is already queued for that account at that time.");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Error("The queue changed. Refresh and try again.");
    return data[0] as { id: string; variant_id: string };
  }
  async function variantBack(variantId: string, status: "approved" | "scheduled") {
    const v = check(await client.from("post_variants").update({ status }).eq("workspace_id", ws).eq("id", variantId).in("status", ["approved", "scheduled", "failed"]).select("post_id")) as { post_id: string }[];
    if (v[0]) await deps.publish.syncPostStatus(v[0].post_id);
  }

  return {
    // ---- workspace switches and limits
    async settings(): Promise<AutomationSettings> {
      can("workspace.view");
      const row = check(await client.from("automation_settings").select("*").eq("workspace_id", ws).maybeSingle()) as AutomationSettings | null;
      return row ? { ...row, daily_ai_cost_limit_usd: Number(row.daily_ai_cost_limit_usd) } : { workspace_id: ws, ...DEFAULT_SETTINGS };
    },

    async saveLimits(input: { daily_post_limit: number; monthly_post_limit: number; daily_ai_cost_limit_usd: number }) {
      can("automation.manage");
      check(await client.from("automation_settings").upsert({ workspace_id: ws, ...input, updated_by: ctx.email }, { onConflict: "workspace_id" }));
      await audit("automation.limits_updated", "workspace", ws, input);
    },

    // The pause-all switch. While paused nothing is published or generated by the queue.
    async setPaused(paused: boolean) {
      can("automation.manage");
      check(await client.from("automation_settings").upsert({ workspace_id: ws, paused, paused_by: paused ? ctx.email : null, paused_at: paused ? now().toISOString() : null, updated_by: ctx.email }, { onConflict: "workspace_id" }));
      await audit(paused ? "automation.paused" : "automation.resumed", "workspace", ws);
    },

    // ---- per brand
    async brandAutomation(): Promise<Map<string, BrandAutomation>> {
      can("workspace.view");
      const rows = check(await client.from("brand_automation").select("*").eq("workspace_id", ws)) as BrandAutomation[];
      return new Map(rows.map((r) => [r.brand_id, r]));
    },

    async saveBrandAutomation(brandId: string, input: { enabled: boolean; mode: Mode; days_of_week: number[]; times: string[]; posts_per_week: number; categories: string[]; confirm_full_auto: boolean }) {
      can("automation.manage");
      await brandTimezone(brandId);
      const current = check(await client.from("brand_automation").select("mode, full_auto_confirmed_by, full_auto_confirmed_at").eq("workspace_id", ws).eq("brand_id", brandId).maybeSingle()) as Pick<BrandAutomation, "mode" | "full_auto_confirmed_by" | "full_auto_confirmed_at"> | null;
      const full = input.mode === "fully_automatic";
      const alreadyConfirmed = current?.mode === "fully_automatic" && current.full_auto_confirmed_by;
      if (full && !alreadyConfirmed && !input.confirm_full_auto) throw new Error("Fully automatic publishing posts without asking you. Tick the confirmation box to switch it on.");
      const confirmation = full ? (alreadyConfirmed ? { full_auto_confirmed_by: current!.full_auto_confirmed_by, full_auto_confirmed_at: current!.full_auto_confirmed_at } : { full_auto_confirmed_by: ctx.email, full_auto_confirmed_at: now().toISOString() }) : { full_auto_confirmed_by: null, full_auto_confirmed_at: null };
      const fields = { enabled: input.enabled, mode: input.mode, days_of_week: input.days_of_week, times: input.times, posts_per_week: input.posts_per_week, categories: input.categories };
      check(await client.from("brand_automation").upsert({ brand_id: brandId, workspace_id: ws, ...fields, ...confirmation, updated_by: ctx.email }, { onConflict: "brand_id" }));
      await audit(full && !alreadyConfirmed ? "automation.full_auto_enabled" : "automation.brand_updated", "brand", brandId, { enabled: input.enabled, mode: input.mode, days: input.days_of_week, times: input.times, posts_per_week: input.posts_per_week });
    },

    async setBrandPaused(brandId: string, paused: boolean) {
      can("automation.manage");
      await brandTimezone(brandId);
      check(await client.from("brand_automation").upsert({ brand_id: brandId, workspace_id: ws, paused, updated_by: ctx.email }, { onConflict: "brand_id" }));
      await audit(paused ? "automation.brand_paused" : "automation.brand_resumed", "brand", brandId);
    },

    async setAccountPaused(accountId: string, paused: boolean) {
      can("automation.manage");
      const rows = check(await client.from("social_accounts").update({ automation_paused: paused }).eq("workspace_id", ws).eq("id", accountId).select("id")) as { id: string }[];
      if (!rows.length) throw new NotFound("Account");
      await audit(paused ? "automation.account_paused" : "automation.account_resumed", "social_account", accountId);
    },

    // ---- the queue
    async list(view: QueueView, opts: { brandId?: string | null; limit?: number } = {}): Promise<QueueItem[]> {
      can("workspace.view");
      let q = client
        .from("scheduled_jobs")
        .select("id, status, run_at, timezone, local_time, source, attempts, max_attempts, last_error, requested_by, brand_id, updated_at, social_accounts(display_name, platform, status), post_variants(id, platform, body, external_url, posts(id, title))")
        .eq("workspace_id", ws)
        .in("status", [...VIEWS[view]]);
      if (opts.brandId) q = q.eq("brand_id", opts.brandId);
      q = view === "upcoming" ? q.order("run_at", { ascending: true }) : q.order("updated_at", { ascending: false });
      return check(await q.limit(opts.limit ?? 100)) as unknown as QueueItem[];
    },

    async counts() {
      can("workspace.view");
      const out: Record<QueueView, number> = { upcoming: 0, attention: 0, done: 0 };
      for (const view of Object.keys(VIEWS) as QueueView[]) {
        const { count, error } = await client.from("scheduled_jobs").select("id", { count: "exact", head: true }).eq("workspace_id", ws).in("status", [...VIEWS[view]]);
        if (error) throw new Error(error.message);
        out[view] = count ?? 0;
      }
      return out;
    },

    // Posts published today and this month (UTC), for the limits.
    async published() {
      can("workspace.view");
      const since = async (iso: string) => {
        const { count, error } = await client.from("publish_attempts").select("id", { count: "exact", head: true }).eq("workspace_id", ws).in("outcome", ["success", "reconciled"]).gte("finished_at", iso);
        if (error) throw new Error(error.message);
        return count ?? 0;
      };
      return { today: await since(utcDayStart(now())), month: await since(utcMonthStart(now())) };
    },

    // Schedules one approved version at a local date and time in its brand's time zone.
    async schedule(variantId: string, local: string) {
      can("post.publish");
      const v = check(await client.from("post_variants").select("posts(brand_id)").eq("workspace_id", ws).eq("id", variantId).maybeSingle()) as { posts: { brand_id: string } | null } | null;
      if (!v?.posts) throw new NotFound("Post version");
      return deps.publish.enqueue(variantId, { ...when(local, await brandTimezone(v.posts.brand_id)), source: "schedule" });
    },

    async pause(jobId: string) {
      can("post.publish");
      await move(jobId, ["pending"], { status: "paused" });
      await audit("queue.paused", "job", jobId);
    },

    // A paused post whose time has passed goes out at the next worker run.
    async resume(jobId: string) {
      can("post.publish");
      const j = await job(jobId);
      const late = new Date(j.run_at).getTime() < now().getTime();
      await move(jobId, ["paused"], { status: "pending", ...(late ? { run_at: now().toISOString() } : {}) });
      await audit("queue.resumed", "job", jobId, { late });
      return { late };
    },

    async reschedule(jobId: string, local: string) {
      can("post.publish");
      const j = await job(jobId);
      if (!j.brand_id) throw new Error("This job has no brand. Schedule it again from Content Studio.");
      const at = when(local, await brandTimezone(j.brand_id));
      if (["pending", "paused"].includes(j.status)) {
        await move(jobId, [j.status], { run_at: at.runAt.toISOString(), timezone: at.timezone, local_time: at.local });
      } else if (["skipped", "cancelled", "failed", "dead"].includes(j.status)) {
        // Back into the queue: the full checks run again.
        await deps.publish.enqueue(j.variant_id, { ...at, source: "schedule" });
      } else {
        throw new Error(j.status === "needs_check" ? "Check whether the last attempt posted first." : `A ${j.status} post can't be rescheduled.`);
      }
      await audit("queue.rescheduled", "job", jobId, { run_at: at.runAt.toISOString(), timezone: at.timezone });
    },

    // Frees this slot. The post stays approved but automation won't queue it again unless it is re-approved.
    async skip(jobId: string) {
      can("post.publish");
      const j = await move(jobId, ["pending", "paused"], { status: "skipped" });
      await variantBack(j.variant_id, "approved");
      await audit("queue.skipped", "job", jobId);
    },

    // Takes the post out of the queue for good (until someone schedules it again).
    async cancel(jobId: string) {
      can("post.publish");
      const j = await move(jobId, ["pending", "paused", "skipped", "dead", "failed"], { status: "cancelled" });
      await variantBack(j.variant_id, "approved");
      await audit("queue.cancelled", "job", jobId);
    },

    // ---- alerts and monitoring
    async notifications(opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<Notification[]> {
      can("workspace.view");
      let q = client.from("notifications").select("*").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(opts.limit ?? 30);
      if (opts.unreadOnly) q = q.is("read_at", null);
      return check(await q) as Notification[];
    },

    async markRead(id: string | "all") {
      can("workspace.view");
      let q = client.from("notifications").update({ read_at: now().toISOString(), read_by: ctx.email }).eq("workspace_id", ws).is("read_at", null);
      if (id !== "all") q = q.eq("id", id);
      check(await q);
    },

    async lastWorkerRun(): Promise<WorkerRun | null> {
      can("workspace.view");
      return check(await client.from("worker_runs").select("id, worker, started_at, finished_at, error").order("started_at", { ascending: false }).limit(1).maybeSingle()) as WorkerRun | null;
    },
  };
}

export type QueueService = ReturnType<typeof queueService>;
