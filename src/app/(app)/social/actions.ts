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
import { brandInput, brandProfileInput, firstIssue, formObject, postDraftInput, websiteInput, workspaceInput } from "@/lib/social/validation";

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
function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: import("zod").ZodError } }, form: FormData): T {
  const parsed = schema.safeParse(formObject(form));
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
