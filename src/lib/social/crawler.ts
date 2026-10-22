// A small, polite crawler for one website: robots.txt first, then the homepage, the sitemap and a
// handful of the most useful internal pages. Fetching goes through an injected PageFetcher
// (safeFetch in production, a mock in tests), so all network safety lives in one place.
import { assertPublicUrl, type PageFetcher } from "./safeFetch";

export const CRAWLER_AGENT = "RnROsBot";

// ---- robots.txt

type Rule = { allow: boolean; path: string };
export type Robots = { rules: Rule[]; sitemaps: string[] };

export function parseRobots(text: string, agent = CRAWLER_AGENT): Robots {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      // An empty Disallow means "allow everything" and adds no rule.
      if (value) current.rules.push({ allow: key === "allow", path: value });
    }
  }
  const name = agent.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && name.startsWith(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  return { rules: chosen.flatMap((g) => g.rules), sitemaps };
}

function ruleMatches(pattern: string, path: string) {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

// Longest matching rule wins; on a tie, Allow wins (as Google documents).
export function robotsAllows(robots: Robots, url: string) {
  const u = new URL(url);
  const path = u.pathname + u.search;
  let best: Rule | null = null;
  for (const r of robots.rules) {
    if (!ruleMatches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

// ---- links

const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|gz|mp4|mov|mp3|wav|docx?|xlsx?|pptx?|css|js|json|xml|txt)$/i;

export const sameSite = (a: string, b: string) => a.replace(/^www\./, "") === b.replace(/^www\./, "");

// Absolute, same-site, page-like URL without the fragment, or null.
export function normalizeLink(href: string, base: string, host: string): string | null {
  if (!href || /^(mailto|tel|javascript|data|sms|whatsapp):/i.test(href.trim())) return null;
  let u: URL;
  try {
    u = new URL(href.trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!sameSite(u.hostname.toLowerCase(), host)) return null;
  if (SKIP_EXT.test(u.pathname)) return null;
  u.hash = "";
  // Drop tracking parameters; keep other queries but treat heavy ones (search, filters) as noise.
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/i.test(k)) u.searchParams.delete(k);
  if ([...u.searchParams.keys()].length > 1) return null;
  return u.toString();
}

// How useful a page is likely to be for a business profile.
export function pageScore(url: string, text = "") {
  const path = new URL(url).pathname.toLowerCase();
  const t = `${path} ${text.toLowerCase()}`;
  if (path === "/" || path === "") return 1000;
  let score = 0;
  if (/contact/.test(t)) score += 100;
  if (/about|who-we-are|our-story|company/.test(t)) score += 90;
  if (/service|what-we-do|repair|install|replacement|cleaning|inspection|maintenance|solutions|products?/.test(t)) score += 70;
  if (/area|location|cities|city|near|serving|service-area/.test(t)) score += 60;
  if (/blog|article|news|guide|tips|resources|faq/.test(t)) score += 25;
  if (/privacy|terms|cookie|login|cart|checkout|account|wp-admin|feed|tag\/|author\//.test(t)) score -= 200;
  score -= path.split("/").filter(Boolean).length * 5;
  return score;
}

export function isArticleUrl(url: string) {
  return /\/(blog|news|articles?|guides?|tips|resources|insights|posts?)\//i.test(new URL(url).pathname);
}

// ---- sitemap

export function parseSitemap(xml: string): { pages: string[]; sitemaps: string[] } {
  const locs = (tag: string) => [...xml.matchAll(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<loc>\\s*([^<\\s]+)\\s*</loc>`, "gi"))].map((m) => m[1].replace(/&amp;/g, "&"));
  return { pages: locs("url"), sitemaps: locs("sitemap") };
}

// ---- crawl

export type CrawledPage = { url: string; status: number; html: string; title: string | null; depth: number };
export type SkippedPage = { url: string; reason: string };
export type CrawlResult = {
  origin: string;
  host: string;
  homepage: CrawledPage | null;
  pages: CrawledPage[];
  skipped: SkippedPage[];
  sitemapPages: string[];
  robots: "allowed" | "missing" | "unavailable";
  stoppedEarly: boolean;
};

export type CrawlOptions = { maxPages?: number; concurrency?: number; budgetMs?: number; maxArticles?: number; clock?: () => number };

const titleOf = (html: string) => html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1].replace(/\s+/g, " ").trim() || null;

const isHtml = (type: string, body: string) => /html/i.test(type) || (!type && /<html|<!doctype html/i.test(body.slice(0, 500)));

export async function crawlSite(startUrl: string, fetcher: PageFetcher, options: CrawlOptions = {}): Promise<CrawlResult> {
  const { maxPages = 12, concurrency = 3, budgetMs = 40_000, maxArticles = 4, clock = Date.now } = options;
  const start = assertPublicUrl(startUrl);
  const deadline = clock() + budgetMs;
  const skipped: SkippedPage[] = [];
  let origin = start.origin;
  let host = start.hostname.toLowerCase();
  const result: CrawlResult = { origin, host, homepage: null, pages: [], skipped, sitemapPages: [], robots: "missing", stoppedEarly: false };

  // robots.txt. A missing file (4xx) allows everything; an unreachable one (5xx, timeout) stops the crawl.
  let robots: Robots = { rules: [], sitemaps: [] };
  try {
    const r = await fetcher(`${origin}/robots.txt`);
    if (r.status >= 200 && r.status < 300) {
      robots = parseRobots(r.body);
      result.robots = "allowed";
    } else if (r.status >= 500) {
      result.robots = "unavailable";
    }
  } catch {
    result.robots = "unavailable";
  }
  if (result.robots === "unavailable") {
    skipped.push({ url: `${origin}/robots.txt`, reason: "robots.txt could not be read, so no pages were fetched" });
    return result;
  }

  const fetchPage = async (url: string, depth: number): Promise<CrawledPage | null> => {
    if (!robotsAllows(robots, url)) {
      skipped.push({ url, reason: "blocked by robots.txt" });
      return null;
    }
    if (clock() > deadline) {
      result.stoppedEarly = true;
      skipped.push({ url, reason: "time budget reached" });
      return null;
    }
    try {
      const r = await fetcher(url);
      if (r.status < 200 || r.status >= 300) {
        skipped.push({ url, reason: `HTTP ${r.status}` });
        return null;
      }
      if (!isHtml(r.contentType, r.body)) {
        skipped.push({ url, reason: "not an HTML page" });
        return null;
      }
      const finalHost = new URL(r.url).hostname.toLowerCase();
      if (!sameSite(finalHost, host)) {
        skipped.push({ url, reason: `redirected to another site (${finalHost})` });
        return null;
      }
      return { url: r.url, status: r.status, html: r.body, title: titleOf(r.body), depth };
    } catch (e) {
      skipped.push({ url, reason: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };

  const home = await fetchPage(start.toString(), 0);
  if (!home) return result;
  // Follow the site's own canonical host (http -> https, bare -> www). robots.txt is per host, so read it again.
  const homeUrl = new URL(home.url);
  if (homeUrl.origin !== origin) {
    origin = homeUrl.origin;
    try {
      const r = await fetcher(`${origin}/robots.txt`);
      if (r.status >= 200 && r.status < 300) {
        robots = parseRobots(r.body);
        result.robots = "allowed";
      } else if (r.status >= 500) {
        result.robots = "unavailable";
      } else {
        robots = { rules: [], sitemaps: [] };
        result.robots = "missing";
      }
    } catch {
      result.robots = "unavailable";
    }
    if (result.robots === "unavailable") {
      skipped.push({ url: `${origin}/robots.txt`, reason: "robots.txt could not be read, so no other pages were fetched" });
    }
  }
  host = homeUrl.hostname.toLowerCase();
  Object.assign(result, { origin, host, homepage: home });
  result.pages.push(home);
  if (result.robots === "unavailable") return result;

  // Candidate pages: homepage links first, then the sitemap.
  const candidates = new Map<string, number>();
  for (const m of home.html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const link = normalizeLink(m[1], home.url, host);
    if (!link || link.replace(/\/$/, "") === home.url.replace(/\/$/, "")) continue;
    const text = m[2].replace(/<[^>]+>/g, " ");
    candidates.set(link, Math.max(candidates.get(link) ?? -Infinity, pageScore(link, text) + 10));
  }

  const sitemapQueue = robots.sitemaps.length ? robots.sitemaps.slice(0, 3) : [`${origin}/sitemap.xml`];
  const seenSitemaps = new Set<string>();
  while (sitemapQueue.length && seenSitemaps.size < 4 && result.sitemapPages.length < 500 && clock() <= deadline) {
    const sm = sitemapQueue.shift()!;
    if (seenSitemaps.has(sm)) continue;
    seenSitemaps.add(sm);
    try {
      assertPublicUrl(sm);
      if (!sameSite(new URL(sm).hostname.toLowerCase(), host)) continue;
      const r = await fetcher(sm);
      if (r.status !== 200) continue;
      const parsed = parseSitemap(r.body);
      sitemapQueue.push(...parsed.sitemaps.slice(0, 3));
      for (const p of parsed.pages.slice(0, 500 - result.sitemapPages.length)) {
        const link = normalizeLink(p, origin, host);
        if (!link) continue;
        result.sitemapPages.push(link);
        if (!candidates.has(link)) candidates.set(link, pageScore(link));
      }
    } catch {
      // A broken sitemap is not fatal; homepage links are still used.
    }
  }

  // Best pages first, with a cap on blog articles so service and contact pages aren't crowded out.
  const ranked = [...candidates.entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([u]) => u);
  const chosen: string[] = [];
  let articles = 0;
  for (const u of ranked) {
    if (chosen.length >= maxPages - 1) break;
    if (isArticleUrl(u)) {
      if (articles >= maxArticles) continue;
      articles++;
    }
    chosen.push(u);
  }

  // Fetch with a small worker pool.
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, chosen.length) }, async () => {
    while (next < chosen.length) {
      const url = chosen[next++];
      const page = await fetchPage(url, 1);
      if (page && !result.pages.some((p) => p.url === page.url)) result.pages.push(page);
    }
  });
  await Promise.all(workers);
  return result;
}
