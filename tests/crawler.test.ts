import { test } from "node:test";
import assert from "node:assert/strict";
import { crawlSite, normalizeLink, parseRobots, parseSitemap, robotsAllows } from "../src/lib/social/crawler";
import { mockSite, roofingSite } from "./support/mock-site";

const ORIGIN = "https://www.copperasroofing.test";

test("robots.txt: our own group beats *, longest match wins, Allow wins ties, wildcards work", () => {
  const robots = parseRobots(`
User-agent: *
Disallow: /

User-agent: RnROsBot
User-agent: OtherBot
Disallow: /private/
Allow: /private/press
Disallow: /*.pdf$
Disallow: /tmp
Allow: /tmp
Sitemap: https://x.test/sitemap.xml`);
  assert.deepEqual(robots.sitemaps, ["https://x.test/sitemap.xml"]);
  assert.equal(robotsAllows(robots, "https://x.test/"), true, "the * Disallow: / doesn't apply to us");
  assert.equal(robotsAllows(robots, "https://x.test/private/a"), false);
  assert.equal(robotsAllows(robots, "https://x.test/private/press-kit"), true);
  assert.equal(robotsAllows(robots, "https://x.test/file.pdf"), false);
  assert.equal(robotsAllows(robots, "https://x.test/file.pdf?x=1"), true);
  assert.equal(robotsAllows(robots, "https://x.test/tmp"), true);

  const star = parseRobots("User-agent: *\nDisallow: /\n");
  assert.equal(robotsAllows(star, "https://x.test/anything"), false);
  assert.equal(robotsAllows(parseRobots("User-agent: *\nDisallow:\n"), "https://x.test/a"), true);
});

test("links are normalised to same-site pages only", () => {
  const base = `${ORIGIN}/`;
  assert.equal(normalizeLink("/about#team", base, "www.copperasroofing.test"), `${ORIGIN}/about`);
  assert.equal(normalizeLink("https://copperasroofing.test/x?utm_source=fb", base, "www.copperasroofing.test"), "https://copperasroofing.test/x");
  for (const bad of ["https://othersite.test/", "mailto:a@b.c", "tel:123", "javascript:alert(1)", "/brochure.pdf", "/img/a.jpg", "/search?q=a&page=2"]) {
    assert.equal(normalizeLink(bad, base, "www.copperasroofing.test"), null, bad);
  }
});

test("sitemaps and sitemap indexes are parsed", () => {
  assert.deepEqual(parseSitemap("<urlset><url><loc> https://a.test/x?a=1&amp;b=2 </loc></url></urlset>").pages, ["https://a.test/x?a=1&b=2"]);
  assert.deepEqual(parseSitemap("<sitemapindex><sitemap><loc>https://a.test/s1.xml</loc></sitemap></sitemapindex>").sitemaps, ["https://a.test/s1.xml"]);
});

test("crawl follows the homepage redirect, reads the sitemap, respects robots and stays on the site", async () => {
  const site = mockSite(roofingSite());
  const r = await crawlSite("https://copperasroofing.test", site.fetcher);
  assert.equal(r.origin, ORIGIN, "uses the host the homepage redirected to");
  assert.equal(r.robots, "allowed", "robots.txt is read again for the host the homepage redirected to");
  assert.ok(site.calls.includes(`${ORIGIN}/robots.txt`));
  assert.ok(!site.calls.includes(`${ORIGIN}/private/services-pricing`), "the www host's Disallow applies");
  const fetched = r.pages.map((p) => p.url);
  assert.ok(fetched.includes(`${ORIGIN}/contact`));
  assert.ok(fetched.includes(`${ORIGIN}/services/roof-leak-repair`));
  assert.ok(fetched.includes(`${ORIGIN}/service-areas/killeen`), "found through the sitemap");
  assert.ok(!site.calls.some((u) => u.startsWith("https://othersite.test")), "never leaves the site");
  assert.ok(r.sitemapPages.includes(`${ORIGIN}/blog/what-to-check-after-a-storm`));
});

test("robots.txt Disallow is obeyed and reported", async () => {
  const pages = roofingSite();
  const site = mockSite(pages);
  const r = await crawlSite(`${ORIGIN}/`, site.fetcher);
  assert.equal(r.robots, "allowed");
  assert.ok(!site.calls.includes(`${ORIGIN}/private/services-pricing`), "disallowed page is never requested");
  assert.ok(r.skipped.some((s) => s.url === `${ORIGIN}/private/services-pricing` && /robots/.test(s.reason)));
});

test("an unreachable robots.txt stops the crawl instead of guessing", async () => {
  const site = mockSite({ [`${ORIGIN}/robots.txt`]: { status: 503 }, [`${ORIGIN}/`]: "<html><title>x</title></html>" });
  const r = await crawlSite(`${ORIGIN}/`, site.fetcher);
  assert.equal(r.robots, "unavailable");
  assert.equal(r.homepage, null);
  assert.deepEqual(site.calls, [`${ORIGIN}/robots.txt`]);
});

test("page count, concurrency, article count and time budget are bounded", async () => {
  const links = Array.from({ length: 40 }, (_, i) => `<a href="/services/s${i}">S${i}</a><a href="/blog/post-${i}">P${i}</a>`).join("");
  const pages: Record<string, { body?: string; status?: number; delayMs?: number; type?: string }> = {
    [`${ORIGIN}/robots.txt`]: { status: 404 },
    [`${ORIGIN}/`]: { body: `<html><title>Home</title><body>${links}</body></html>` },
  };
  for (let i = 0; i < 40; i++) {
    pages[`${ORIGIN}/services/s${i}`] = { body: `<html><title>S${i}</title><h1>S${i}</h1></html>`, delayMs: 5 };
    pages[`${ORIGIN}/blog/post-${i}`] = { body: `<html><title>P${i}</title></html>`, delayMs: 5 };
  }
  const site = mockSite(pages);
  const r = await crawlSite(`${ORIGIN}/`, site.fetcher, { maxPages: 8, concurrency: 3, maxArticles: 2 });
  assert.equal(r.pages.length, 8);
  assert.ok(site.maxInFlight() <= 3, `at most 3 requests at once, saw ${site.maxInFlight()}`);
  assert.ok(r.pages.filter((p) => p.url.includes("/blog/")).length <= 2);

  let t = 0;
  const slow = mockSite(pages);
  const clocked = await crawlSite(`${ORIGIN}/`, slow.fetcher, { maxPages: 8, budgetMs: 1000, clock: () => (t += 400) });
  assert.ok(clocked.stoppedEarly);
  assert.ok(clocked.pages.length < 8);
});

test("non-HTML responses, errors and off-site redirects are skipped with a reason", async () => {
  const site = mockSite({
    [`${ORIGIN}/robots.txt`]: { status: 404 },
    [`${ORIGIN}/`]: `<html><a href="/contact">Contact</a><a href="/about">About</a><a href="/services/x">X</a></html>`,
    [`${ORIGIN}/contact`]: { type: "application/pdf", body: "%PDF" },
    [`${ORIGIN}/about`]: { error: "Timed out after 8s" },
    [`${ORIGIN}/services/x`]: { redirect: "https://evil.test/x" },
    "https://evil.test/x": "<html>elsewhere</html>",
  });
  const r = await crawlSite(`${ORIGIN}/`, site.fetcher);
  const reasons = Object.fromEntries(r.skipped.map((s) => [s.url, s.reason]));
  assert.equal(reasons[`${ORIGIN}/contact`], "not an HTML page");
  assert.equal(reasons[`${ORIGIN}/about`], "Timed out after 8s");
  assert.match(reasons[`${ORIGIN}/services/x`], /another site/);
  assert.equal(r.pages.length, 1);
});

test("a private start URL is refused before any request", async () => {
  const site = mockSite({});
  await assert.rejects(crawlSite("http://169.254.169.254/", site.fetcher), /private or reserved/);
  assert.equal(site.calls.length, 0);
});
