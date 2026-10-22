"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { destroySession, requireUser } from "@/lib/auth/session";
import { discoverSites, syncSite, type Site } from "@/lib/gsc/sync";
import { generateReport } from "@/lib/ai/recommendations";

export type ActionResult = { ok: boolean; message: string } | null;

async function loadSite(siteId: string): Promise<Site> {
  const { data, error } = await db().from("sites").select("*").eq("id", siteId).single();
  if (error || !data) throw new Error("Site not found");
  return data as Site;
}

export async function discoverSitesAction(): Promise<ActionResult> {
  await requireUser();
  try {
    const n = await discoverSites();
    revalidatePath("/search-console");
    return { ok: true, message: `Found ${n} properties in Search Console.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function syncSiteAction(siteId: string): Promise<ActionResult> {
  await requireUser();
  const result = await syncSite(await loadSite(siteId), "manual");
  revalidatePath("/search-console", "layout");
  return { ok: result.ok, message: result.ok ? `Synced: ${result.detail}` : `Sync failed: ${result.detail}` };
}

export async function generateReportAction(siteId: string): Promise<ActionResult> {
  await requireUser();
  try {
    await generateReport(await loadSite(siteId));
    revalidatePath(`/search-console/${siteId}`);
    return { ok: true, message: "New recommendations are ready." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function setSiteEnabledAction(siteId: string, enabled: boolean) {
  await requireUser();
  await db().from("sites").update({ enabled }).eq("id", siteId);
  revalidatePath("/search-console");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}
