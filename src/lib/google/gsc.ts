import "server-only";
import { getAccessToken } from "./oauth";

const WEBMASTERS = "https://www.googleapis.com/webmasters/v3";
const INSPECTION = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
const ROW_LIMIT = 25_000; // API maximum per request

export type GscRow = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };

async function google<T>(url: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Google API ${res.status} on ${url}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function listSites() {
  const data = await google<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(`${WEBMASTERS}/sites`);
  return (data.siteEntry ?? []).filter((s) => s.permissionLevel !== "siteUnverifiedUser");
}

// Search Analytics query, following startRow pagination until the API runs out of rows.
export async function searchAnalytics(
  siteUrl: string,
  body: { startDate: string; endDate: string; dimensions: string[] },
  maxRows = 200_000,
): Promise<GscRow[]> {
  const url = `${WEBMASTERS}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const rows: GscRow[] = [];
  for (let startRow = 0; startRow < maxRows; startRow += ROW_LIMIT) {
    const data = await google<{ rows?: GscRow[] }>(url, {
      method: "POST",
      body: JSON.stringify({ ...body, type: "web", rowLimit: ROW_LIMIT, startRow }),
    });
    rows.push(...(data.rows ?? []));
    if (!data.rows || data.rows.length < ROW_LIMIT) break;
  }
  return rows;
}

export type IndexStatus = {
  verdict?: string;
  coverageState?: string;
  robotsTxtState?: string;
  indexingState?: string;
  lastCrawlTime?: string;
  pageFetchState?: string;
  googleCanonical?: string;
  userCanonical?: string;
};

export async function inspectUrl(siteUrl: string, inspectionUrl: string) {
  const data = await google<{ inspectionResult?: { indexStatusResult?: IndexStatus } }>(INSPECTION, {
    method: "POST",
    body: JSON.stringify({ inspectionUrl, siteUrl }),
  });
  return data.inspectionResult?.indexStatusResult ?? {};
}
