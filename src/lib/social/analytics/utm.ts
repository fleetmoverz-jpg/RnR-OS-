// Optional UTM tagging of a post's link. Pure, so it is unit-tested. Parameters already on the
// link are kept, and only http(s) links are touched.
export type LinkTracking = { enabled: boolean; utm_source: string; utm_medium: string; utm_campaign: string };

export const DEFAULT_TRACKING: LinkTracking = { enabled: false, utm_source: "{platform}", utm_medium: "social", utm_campaign: "rnr-os" };

export function withUtm(link: string | null, tracking: LinkTracking | null, platform: string): string | null {
  if (!link || !tracking?.enabled) return link;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return link;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return link;
  const fill = (v: string) => v.replaceAll("{platform}", platform);
  for (const [k, v] of [["utm_source", tracking.utm_source], ["utm_medium", tracking.utm_medium], ["utm_campaign", tracking.utm_campaign]] as const) {
    if (!url.searchParams.has(k)) url.searchParams.set(k, fill(v));
  }
  return url.toString();
}
