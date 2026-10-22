import "server-only";
import { cookies } from "next/headers";
import { db } from "./db";
import type { Site } from "./gsc/sync";

export const RANGES = [
  { days: 7, label: "Last 7 days" },
  { days: 28, label: "Last 28 days" },
  { days: 90, label: "Last 3 months" },
] as const;

export const SITE_COOKIE = "rnr_site";
export const RANGE_COOKIE = "rnr_range";

export type Selection = { sites: Site[]; site: Site | null; days: number };

// The website and date range chosen in the top bar. Every analytics page reads this.
export async function getSelection(): Promise<Selection> {
  const jar = await cookies();
  const { data } = await db().from("sites").select("*").order("site_url");
  const sites = (data ?? []) as Site[];
  // Default to the most recently synced active site, which is the one most likely to have data.
  const enabled = sites
    .filter((s) => s.enabled)
    .sort((a, b) => (b.last_synced_at ?? "").localeCompare(a.last_synced_at ?? ""));
  const wanted = jar.get(SITE_COOKIE)?.value;
  const site = sites.find((s) => s.id === wanted) ?? enabled[0] ?? sites[0] ?? null;
  const days = Number(jar.get(RANGE_COOKIE)?.value);
  return { sites, site, days: RANGES.some((r) => r.days === days) ? days : 28 };
}

export const displaySite = (url: string) => url.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/\/$/, "");
