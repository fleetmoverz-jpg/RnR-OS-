"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import type { ActionResult } from "../actions";
import { db } from "@/lib/db";
import { requireWorkspace, WORKSPACE_COOKIE } from "@/lib/social/workspace";
import { describeGoogleError, googleService } from "@/lib/social/googleConnections";
import { googleDeps, googleSetupProblems } from "@/lib/social/googleServer";
import { analysisService, type WebsiteScan } from "@/lib/social/analysis";
import { analysisDeps } from "@/lib/social/analysisServer";
import { PROFILE_FIELDS } from "@/lib/social/extract";
import { contentService } from "@/lib/social/content/service";
import { contentDeps } from "@/lib/social/content/server";
import { connectionService } from "@/lib/social/publish/connections";
import { publishService, PublishBlocked } from "@/lib/social/publish/service";
import { connectionDeps, metaSetupProblems, publishDeps } from "@/lib/social/publish/server";
import { queueService } from "@/lib/social/automation/queue";
import { runWorker } from "@/lib/social/automation/worker";
import { assertCan } from "@/lib/social/policy";
import {
  aiLimitsInput,
  automationLimitsInput,
  brandAutomationInput,
  brandInput,
  brandProfileInput,
  firstIssue,
  formObject,
  formWithLists,
  generateInput,
  postDraftInput,
  scheduleInput,
  strategyInput,
  variantInput,
  websiteInput,
  workspaceInput,
} from "@/lib/social/validation";

// Runs a Social action and turns any failure (validation, permission, not found, database) into a message.
async function run(work: () => Promise<string>): Promise<ActionResult> {
  try {
    const message = await work();
    revalidatePath("/social", "layout");
    return { ok: true, message };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

class Invalid extends Error {}
function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: import("zod").ZodError } }, form: FormData, lists: string[] = []): T {
  const parsed = schema.safeParse(lists.length ? formWithLists(form, lists) : formObject(form));
  if (!parsed.success) throw new Invalid(firstIssue(parsed.error));
  return parsed.data;
}

const optionalId = (v: FormDataEntryValue | null) => (typeof v === "string" && v ? v : null);

export async function createBrandAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  let id: string | null = null;
  const result = await run(async () => {
    const { repo } = await requireWorkspace();
    const brand = await repo.createBrand(parse(brandInput, form));
    id = brand.id;
    return `Created ${brand.name}.`;
  });
  if (id) redirect(`/social/brands/${id}`);
  return result;
}

export async function updateBrandAction(brandId: string, _: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const { repo } = await requireWorkspace();
    await repo.updateBrand(brandId, parse(brandInput, form));
    return "Brand saved.";
  });
}

async function analysis() {
  const { repo } = await requireWorkspace();
  return analysisService(db(), repo.ctx, analysisDeps());
}

// "Found: …. Needs your confirmation: …." for the fields of one scan.
async function describeScan(scan: WebsiteScan): Promise<string> {
  const fields = scan.report.fields ?? {};
  const found = PROFILE_FIELDS.filter((f) => fields[f.field] === "found").map((f) => f.label.toLowerCase());
  const confirm = PROFILE_FIELDS.filter((f) => fields[f.field] && fields[f.field] !== "found").map((f) => f.label.toLowerCase());
  const parts = [`Read ${scan.pages_fetched} ${scan.pages_fetched === 1 ? "page" : "pages"}${scan.pages_skipped ? ` (${scan.pages_skipped} skipped)` : ""}.`];
  if (scan.report.brand_created) parts.push("Created a brand for this website.");
  if (found.length) parts.push(`Found on the website: ${found.join(", ")}.`);
  if (confirm.length) parts.push(`Needs your confirmation: ${confirm.join(", ")}.`);
  return parts.join(" ");
}

export async function scanWebsiteAction(websiteId: string): Promise<ActionResult> {
  return run(async () => describeScan(await (await analysis()).scanWebsite(websiteId)));
}

export async function saveProfileAction(brandId: string, _: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    await (await analysis()).saveProfile(brandId, parse(brandProfileInput, form));
    return "Profile saved. Every filled field is now marked as confirmed by you.";
  });
}

export async function confirmFactAction(factId: string): Promise<ActionResult> {
  return run(async () => {
    await (await analysis()).confirmFact(factId);
    return "Confirmed.";
  });
}

export async function rejectFactAction(factId: string): Promise<ActionResult> {
  return run(async () => {
    await (await analysis()).rejectFact(factId);
    return "Rejected. It won't be used.";
  });
}

export async function approveProfileAction(brandId: string): Promise<ActionResult> {
  return run(async () => {
    await (await analysis()).approveProfile(brandId);
    return "Profile approved.";
  });
}

export async function reopenProfileAction(brandId: string): Promise<ActionResult> {
  return run(async () => {
    await (await analysis()).reopenProfile(brandId);
    return "Profile moved back to draft.";
  });
}

// Newly added websites are analysed after the response is sent, a few at a time.
function analyseLater(websiteIds: string[]) {
  if (!websiteIds.length) return;
  after(async () => {
    const service = await analysis();
    for (const id of websiteIds.slice(0, 3)) {
      try {
        await service.scanWebsite(id);
      } catch {
        // The scan row records the failure; the Websites page shows it.
      }
    }
    revalidatePath("/social", "layout");
  });
}

export async function setBrandArchivedAction(brandId: string, archived: boolean): Promise<ActionResult> {
  return run(async () => {
    const { repo } = await requireWorkspace();
    await repo.setBrandArchived(brandId, archived);
    return archived ? "Brand archived." : "Brand restored.";
  });
}

export async function addWebsiteAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const { repo } = await requireWorkspace();
    const { url } = parse(websiteInput, form);
    const site = await repo.addWebsiteManually(url, optionalId(form.get("brand_id")));
    analyseLater([site.id]);
    return `Added ${site.domain}. It stays unverified until it's imported from Search Console as an owner. Analysing the website now.`;
  });
}

async function google() {
  const { repo } = await requireWorkspace();
  const problems = googleSetupProblems();
  if (problems.length) throw new Error(problems.join(" "));
  return googleService(db(), repo.ctx, googleDeps());
}

export async function discoverPropertiesAction(connectionId: string): Promise<ActionResult> {
  return run(async () => {
    try {
      const { count } = await (await google()).discover(connectionId);
      return count ? `Found ${count} Search Console ${count === 1 ? "property" : "properties"}.` : "This Google account has no Search Console properties.";
    } catch (e) {
      throw new Error(describeGoogleError(e));
    }
  });
}

export async function importPropertiesAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const ids = form.getAll("property_id").filter((v): v is string => typeof v === "string" && v.length > 0);
    if (!ids.length) throw new Invalid("Select at least one property to import.");
    const r = await (await google()).importProperties(ids, optionalId(form.get("brand_id")));
    if (r.imported.length) {
      const { repo } = await requireWorkspace();
      const sites = await repo.listWebsites();
      analyseLater(sites.filter((w) => w.gsc_property_url && r.imported.includes(w.gsc_property_url)).map((w) => w.id));
    }
    const parts = [`Imported ${r.imported.length}`];
    if (r.skipped.length) parts.push(`skipped ${r.skipped.length} already in this workspace`);
    if (r.notFound) parts.push(`${r.notFound} no longer available`);
    return `${parts.join(", ")}.${r.imported.length ? ` Analysing ${r.imported.length > 3 ? "the first 3 websites" : r.imported.length === 1 ? "the website" : "the websites"} now.` : ""}`;
  });
}

export async function disconnectGoogleAction(connectionId: string): Promise<ActionResult> {
  return run(async () => {
    const { revokedAtGoogle } = await (await google()).disconnect(connectionId);
    return revokedAtGoogle
      ? "Disconnected. Access was revoked at Google and the saved tokens were deleted."
      : "Disconnected and saved tokens deleted. Google didn't confirm the revocation; you can also remove access at myaccount.google.com/permissions.";
  });
}

export async function assignWebsiteAction(websiteId: string, _: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const { repo } = await requireWorkspace();
    await repo.assignWebsite(websiteId, optionalId(form.get("brand_id")));
    return "Website updated.";
  });
}

export async function removeWebsiteAction(websiteId: string): Promise<ActionResult> {
  return run(async () => {
    const { repo } = await requireWorkspace();
    await repo.removeWebsite(websiteId);
    return "Website removed.";
  });
}

export async function createDraftAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const { repo } = await requireWorkspace();
    const post = await repo.createDraftPost(parse(postDraftInput, form));
    return `Saved draft "${post.title}".`;
  });
}

export async function deleteDraftAction(postId: string): Promise<ActionResult> {
  return run(async () => {
    const { repo } = await requireWorkspace();
    await repo.deleteDraftPost(postId);
    return "Draft deleted.";
  });
}

export async function renameWorkspaceAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const { repo } = await requireWorkspace();
    await repo.renameWorkspace(parse(workspaceInput, form).name);
    return "Workspace renamed.";
  });
}

export async function switchWorkspaceAction(workspaceId: string) {
  const { workspaces } = await requireWorkspace();
  if (!workspaces.some((w) => w.id === workspaceId)) return;
  (await cookies()).set(WORKSPACE_COOKIE, workspaceId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  revalidatePath("/social", "layout");
}

// ---- Content Studio

async function content() {
  const { repo } = await requireWorkspace();
  return contentService(db(), repo.ctx, contentDeps());
}

export async function saveStrategyAction(brandId: string, _: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    await (await content()).saveStrategy(brandId, parse(strategyInput, form, ["categories", "platforms", "preferred_days"]));
    return "Content strategy saved.";
  });
}

export async function planTopicsAction(brandId: string, _: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const count = Number(form.get("count") ?? 5);
    const category = String(form.get("category") ?? "");
    const r = await (await content()).planTopics(brandId, { count, categories: category ? [category as never] : undefined });
    return `Added ${r.created.length} ${r.created.length === 1 ? "topic" : "topics"} to the calendar${r.skipped.length ? `; skipped ${r.skipped.length} too close to recent topics` : ""}.`;
  });
}

export async function researchTopicAction(topicId: string): Promise<ActionResult> {
  return run(async () => {
    const r = await (await content()).researchTopic(topicId);
    return r.sources ? `Saved ${r.sources} ${r.sources === 1 ? "source" : "sources"}.` : "The search found no usable sources.";
  });
}

export async function dismissTopicAction(topicId: string): Promise<ActionResult> {
  return run(async () => {
    await (await content()).dismissTopic(topicId);
    return "Topic removed.";
  });
}

export async function generateDraftsAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const input = parse(generateInput, form, ["platforms"]);
    const r = await (await content()).generateDrafts(input.brand_id, { topicId: input.topic_id, category: input.category ?? null, platforms: input.platforms, tone: input.tone, quantity: input.quantity });
    return [`Created ${r.postIds.length} ${r.postIds.length === 1 ? "draft" : "drafts"}. Review them below; nothing is published.`, ...r.notes].join(" ");
  });
}

export async function updateVariantAction(variantId: string, _: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const v = await (await content()).updateVariant(variantId, parse(variantInput, form));
    return v.errors.length ? `Saved, but it still needs fixing: ${v.errors.join(" ")}` : "Saved.";
  });
}

export async function regenerateVariantAction(variantId: string): Promise<ActionResult> {
  return run(async () => {
    const v = await (await content()).regenerateVariant(variantId);
    return v.errors.length ? `Regenerated, but it needs fixing: ${v.errors.join(" ")}` : "Regenerated.";
  });
}

export async function approvePostAction(postId: string): Promise<ActionResult> {
  return run(async () => {
    await (await content()).approvePost(postId);
    return "Approved. Nothing is posted until you publish it.";
  });
}

export async function rejectPostAction(postId: string): Promise<ActionResult> {
  return run(async () => {
    await (await content()).rejectPost(postId, null);
    return "Rejected.";
  });
}

export async function saveAiLimitsAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    await (await content()).setLimits(parse(aiLimitsInput, form));
    return "Limits saved.";
  });
}

// ---- accounts and publishing

async function connections() {
  const { repo } = await requireWorkspace();
  const problems = metaSetupProblems();
  if (problems.length) throw new Error(problems.join(" "));
  return connectionService(db(), repo.ctx, connectionDeps());
}

async function publishing() {
  const { repo } = await requireWorkspace();
  return publishService(db(), repo.ctx, publishDeps());
}

export async function discoverMetaAction(connectionId: string): Promise<ActionResult> {
  return run(async () => {
    const { count } = await (await connections()).discover(connectionId);
    return `Found ${count} ${count === 1 ? "Page or account" : "Pages and accounts"}.`;
  });
}

export async function addMetaAccountAction(assetId: string, _: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const brandId = optionalId(form.get("brand_id"));
    if (!brandId) throw new Error("Choose a brand.");
    await (await connections()).addAccount(assetId, brandId);
    return "Account added to the brand.";
  });
}

export async function checkAccountAction(accountId: string): Promise<ActionResult> {
  return run(async () => {
    const r = await (await connections()).checkAccount(accountId);
    return r.ok ? `Working: ${r.name}.` : `Problem: ${r.message}`;
  });
}

export async function disconnectAccountAction(accountId: string): Promise<ActionResult> {
  return run(async () => {
    await (await connections()).disconnectAccount(accountId);
    return "Disconnected. Its token was deleted.";
  });
}

export async function revokeMetaAction(connectionId: string): Promise<ActionResult> {
  return run(async () => {
    const r = await (await connections()).revokeConnection(connectionId);
    return r.revokedAtMeta ? "Disconnected and revoked at Meta. All its tokens were deleted." : `Tokens deleted. Meta didn't confirm the revoke${r.note ? ` (${r.note})` : ""}; you can also remove the app in Facebook settings.`;
  });
}

export async function assignAccountAction(variantId: string, _: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    await (await publishing()).assignAccount(variantId, optionalId(form.get("account_id")));
    return "Account saved.";
  });
}

export async function setImageAction(variantId: string, _: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const url = optionalId(form.get("image_url"))?.trim() || null;
    const check = await (await publishing()).setImage(variantId, url);
    if (!check) return "Image removed.";
    return check.ok ? `Image OK (${check.width}×${check.height}). Approve the post again.` : `Saved, but: ${check.errors.join(" ")}`;
  });
}

export async function publishNowAction(variantId: string): Promise<ActionResult> {
  try {
    const r = await (await publishing()).publishNow(variantId);
    revalidatePath("/social", "layout");
    if (r.outcome === "published" || r.outcome === "already_published") return { ok: true, message: r.outcome === "published" ? "Published. The platform confirmed it." : "Already published." };
    if (r.outcome === "needs_check") return { ok: false, message: "The platform's answer was unclear. Use \"Check if it posted\" before trying again." };
    return { ok: false, message: r.message ?? "Publishing failed." };
  } catch (e) {
    return { ok: false, message: e instanceof PublishBlocked ? `Not published: ${e.reasons.join(" ")}` : e instanceof Error ? e.message : String(e) };
  }
}

export async function checkJobAction(jobId: string): Promise<ActionResult> {
  return run(async () => {
    const r = await (await publishing()).checkJob(jobId);
    if (r.outcome === "published") return "It did post. Marked as published.";
    if (r.outcome === "wait") return r.message;
    return "It didn't post. You can publish it again.";
  });
}

export async function refreshMetricsAction(variantId: string): Promise<ActionResult> {
  return run(async () => {
    await (await publishing()).refreshMetrics(variantId);
    return "Metrics updated.";
  });
}

// ---- Queue and automation

async function queue() {
  const { repo } = await requireWorkspace();
  return queueService(db(), repo.ctx, { publish: publishService(db(), repo.ctx, publishDeps()) });
}

const blockedMessage = (e: unknown) => (e instanceof PublishBlocked ? `Can't schedule: ${e.reasons.join(" ")}` : e instanceof Error ? e.message : String(e));

export async function schedulePostAction(variantId: string, _: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    const { when } = parse(scheduleInput, form);
    const r = await (await queue()).schedule(variantId, when);
    revalidatePath("/social", "layout");
    return { ok: true, message: `Scheduled.${r.warnings.length ? ` Note: ${r.warnings.join(" ")}` : ""}` };
  } catch (e) {
    return { ok: false, message: blockedMessage(e) };
  }
}

export async function pauseJobAction(jobId: string): Promise<ActionResult> {
  return run(async () => {
    await (await queue()).pause(jobId);
    return "Paused. It won't be published until you resume it.";
  });
}

export async function resumeJobAction(jobId: string): Promise<ActionResult> {
  return run(async () => {
    const { late } = await (await queue()).resume(jobId);
    return late ? "Resumed. Its time has passed, so it goes out at the next run." : "Resumed.";
  });
}

export async function rescheduleJobAction(jobId: string, _: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    const { when } = parse(scheduleInput, form);
    await (await queue()).reschedule(jobId, when);
    revalidatePath("/social", "layout");
    return { ok: true, message: "Rescheduled." };
  } catch (e) {
    return { ok: false, message: blockedMessage(e) };
  }
}

export async function skipJobAction(jobId: string): Promise<ActionResult> {
  return run(async () => {
    await (await queue()).skip(jobId);
    return "Skipped. The slot is free and the post stays approved.";
  });
}

export async function cancelJobAction(jobId: string): Promise<ActionResult> {
  return run(async () => {
    await (await queue()).cancel(jobId);
    return "Taken out of the queue.";
  });
}

export async function setPauseAllAction(paused: boolean): Promise<ActionResult> {
  return run(async () => {
    await (await queue()).setPaused(paused);
    return paused ? "Everything is paused. Nothing will be published or generated." : "Resumed. Queued posts go out at their times.";
  });
}

export async function saveAutomationLimitsAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    await (await queue()).saveLimits(parse(automationLimitsInput, form));
    return "Limits saved.";
  });
}

export async function saveBrandAutomationAction(brandId: string, _: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    await (await queue()).saveBrandAutomation(brandId, parse(brandAutomationInput, form, ["days_of_week", "categories"]));
    return "Automation saved.";
  });
}

export async function setBrandPausedAction(brandId: string, paused: boolean): Promise<ActionResult> {
  return run(async () => {
    await (await queue()).setBrandPaused(brandId, paused);
    return paused ? "Brand paused." : "Brand resumed.";
  });
}

export async function setAccountAutomationAction(accountId: string, paused: boolean): Promise<ActionResult> {
  return run(async () => {
    await (await queue()).setAccountPaused(accountId, paused);
    return paused ? "Automation is off for this account." : "Automation is on for this account.";
  });
}

export async function markNotificationsReadAction(id: string | "all"): Promise<ActionResult> {
  return run(async () => {
    await (await queue()).markRead(id);
    return id === "all" ? "All alerts marked as read." : "Marked as read.";
  });
}

// Runs the worker for this workspace now, instead of waiting for the next scheduled run.
export async function runWorkerNowAction(): Promise<ActionResult> {
  return run(async () => {
    const { repo } = await requireWorkspace();
    assertCan(repo.ctx.role, "automation.manage");
    const content = contentDeps();
    const s = await runWorker(db(), { workerId: `manual:${repo.ctx.email}`, publish: publishDeps(), content, workspaceIds: [repo.ctx.workspaceId], budgetMs: 25_000 });
    const parts = [`${s.published} published`, `${s.planned} queued`, `${s.generated} drafts written`];
    if (s.reconciled) parts.push(`${s.reconciled} confirmed after checking`);
    if (s.failed) parts.push(`${s.failed} failed`);
    return `Run finished: ${parts.join(", ")}.${s.errors.length ? " Some steps had problems; see alerts." : ""}`;
  });
}
