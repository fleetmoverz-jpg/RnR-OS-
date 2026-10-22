// Platform limits, safety checks, near-duplicate detection, slot planning and prompt contents.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { charCount, nearestDuplicate, normalizeHashtags, similarity, titleSimilarity, validateVariant, type Facts } from "../src/lib/social/content/rules";
import { draftsPrompt, topicsPrompt, type BrandBrief } from "../src/lib/social/content/prompts";
import { nextSlots } from "../src/lib/social/content/service";

const facts: Facts = { phones: ["(512) 555-0100"], domains: ["roofco.test"], sourceUrls: [], credentials: ["Licensed and insured in Texas"] };
const ok = (platform: string, body: string, extra: Partial<{ hashtags: string[]; link_url: string | null }> = {}, f: Facts = facts) =>
  validateVariant(platform, { body, hashtags: [], link_url: null, ...extra }, f);
const BODY = "Check your gutters after a storm. Loose granules in the downspout can mean your shingles are wearing out, so book an inspection before small problems turn into leaks.";

describe("platform constraints", () => {
  test("X counts each link as 23 characters and enforces 280", () => {
    const link = "https://roofco.test/a/very/long/path/that/would/otherwise/count/as/many/characters";
    assert.equal(charCount("x", "Hi", [], link), 2 + 1 + 23);
    assert.equal(charCount("facebook_page", "Hi", [], link), 3 + link.length);
    const long = "a ".repeat(150).trim();
    assert.ok(ok("x", long).errors.some((e) => e.includes("allows 280")));
    assert.deepEqual(ok("x", BODY).errors, []);
  });

  test("hashtags count toward the limit, inline ones included", () => {
    assert.equal(charCount("instagram", "Hi", ["roof", "storm"]), "Hi #roof #storm".length);
    const r = ok("x", "Storm tips #roof #gutters", { hashtags: ["storm"] });
    assert.ok(r.errors.some((e) => e.includes("3 hashtags")));
    assert.deepEqual(normalizeHashtags(["#Roof", "roof", "#a", "storm-damage", "##Gutters"]), ["Roof", "roof", "stormdamage", "Gutters"]);
  });

  test("Google Business Profile rejects hashtags, links and phone numbers", () => {
    const r = ok("google_business", `${BODY} Call (512) 555-0100.`, { hashtags: ["roof"], link_url: "https://roofco.test" });
    assert.ok(r.errors.some((e) => e.includes("shouldn't use hashtags")));
    assert.ok(r.errors.some((e) => e.includes("can't include links")));
    assert.ok(r.errors.some((e) => e.includes("phone numbers")));
  });

  test("Instagram warns that links aren't clickable and that an image is needed", () => {
    const r = ok("instagram", BODY, { link_url: "https://roofco.test/storm" });
    assert.deepEqual(r.errors, []);
    assert.ok(r.warnings.some((w) => w.includes("link in bio")));
    assert.ok(r.warnings.some((w) => w.includes("needs an image")));
  });

  test("unknown platforms and empty posts are errors", () => {
    assert.ok(ok("myspace", BODY).errors[0].includes("Unknown platform"));
    assert.ok(ok("facebook_page", "   ").errors.includes("The post is empty."));
  });
});

describe("no invented facts", () => {
  test("links must point at the brand's site or a cited source", () => {
    assert.deepEqual(ok("facebook_page", `${BODY} https://www.roofco.test/storm`).errors, []);
    assert.ok(ok("facebook_page", `${BODY} https://elsewhere.test/x`).errors.some((e) => e.includes("elsewhere.test")));
    const withSource = { ...facts, sourceUrls: ["https://news.test/story"] };
    assert.deepEqual(ok("facebook_page", `${BODY} https://news.test/other`, {}, withSource).errors, []);
  });

  test("only the confirmed phone number is allowed", () => {
    assert.deepEqual(ok("facebook_page", `${BODY} Call 512-555-0100.`).errors, []);
    assert.ok(ok("facebook_page", `${BODY} Call 512-555-0199.`).errors.some((e) => e.includes("isn't a confirmed number")));
  });

  test("credentials need a confirmed claim", () => {
    assert.deepEqual(ok("facebook_page", `We're licensed. ${BODY}`).errors, []);
    assert.ok(ok("facebook_page", `Award-winning crews. ${BODY}`).errors.some((e) => e.includes("Award-winning")));
    assert.ok(ok("facebook_page", `We're certified. ${BODY}`).errors.some((e) => e.includes("certified")));
  });

  test("statistics need a research source", () => {
    const stat = `About 40% of roofs fail early. ${BODY}`;
    assert.ok(ok("facebook_page", stat).errors.some((e) => e.includes("statistic")));
    assert.deepEqual(ok("facebook_page", stat, {}, { ...facts, sourceUrls: ["https://news.test/a"] }).errors, []);
  });

  test("testimonials and engagement bait are blocked", () => {
    assert.ok(ok("facebook_page", `One of our customers said the crew was great. ${BODY}`).errors.some((e) => e.includes("testimonial")));
    assert.ok(ok("facebook_page", `"They fixed everything in a day" - Maria. ${BODY}`).errors.some((e) => e.includes("testimonial")));
    assert.ok(ok("facebook_page", `${BODY} Tag a friend who needs this!`).errors.some((e) => e.includes("Engagement bait")));
    assert.ok(ok("facebook_page", `${BODY} Like if you agree.`).errors.some((e) => e.includes("Engagement bait")));
  });

  test("keyword stuffing and shouting are warned about", () => {
    const stuffed = Array.from({ length: 8 }, () => "Roofing repair Austin roofing experts roofing").join(". ");
    assert.ok(ok("facebook_page", stuffed).warnings.some((w) => w.includes("keyword stuffing")));
    assert.ok(ok("facebook_page", "CALL NOW FOR THE BEST ROOF DEALS IN TOWN TODAY. Storm checks are free.").warnings.includes("A lot of capital letters."));
  });
});

describe("near duplicates", () => {
  test("rewording a few words is still a duplicate; a different post isn't", () => {
    const a = BODY;
    const b = BODY.replace("Check your gutters", "Take a look at your gutters").replace("book an inspection", "schedule an inspection");
    const c = "Spring is a good time to trim branches that hang over your roof, since they scrape shingles and drop leaves into gutters.";
    assert.ok(similarity(a, a) === 1);
    assert.ok(similarity(a, b) >= 0.5, `expected near duplicate, got ${similarity(a, b)}`);
    assert.ok(similarity(a, c) < 0.2);
    const hit = nearestDuplicate(b, [{ id: "1", body: c }, { id: "2", body: a }]);
    assert.equal(hit?.item.id, "2");
    assert.equal(nearestDuplicate(c, [{ id: "2", body: a }]), null);
  });

  test("hashtags and links don't make posts look different", () => {
    assert.equal(similarity(BODY, `${BODY} #roof #storm https://roofco.test/x`), 1);
  });

  test("title similarity ignores filler words", () => {
    assert.ok(titleSimilarity("How to check your roof after a storm", "Checking the roof after storms") < 0.6);
    assert.ok(titleSimilarity("How to check your roof after a storm", "Check your roof after a storm") >= 0.6);
  });
});

describe("planning slots", () => {
  test("uses preferred weekdays, caps per week and starts after the given day", () => {
    const from = new Date("2026-10-19T15:00:00Z"); // Monday
    assert.deepEqual(nextSlots(from, 4, [1, 3, 5], 3), ["2026-10-21", "2026-10-23", "2026-10-26", "2026-10-28"]);
    assert.deepEqual(nextSlots(from, 3, [1, 3, 5], 1), ["2026-10-21", "2026-10-26", "2026-11-02"]);
    assert.deepEqual(nextSlots(from, 2, [], 2), ["2026-10-21", "2026-10-23"]);
  });
});

describe("prompts", () => {
  const brief: BrandBrief = {
    name: "RoofCo", website: "https://roofco.test", industry: "Roofing", niche: null, city: "Austin", region: "TX", serviceAreas: ["Round Rock"], services: ["Roof repair"],
    description: null, valueProposition: null, tone: "plain", audience: null, phone: "(512) 555-0100", confirmedClaims: ["Licensed and insured in Texas"], articles: [],
  };

  test("only the brief's facts and numbered sources reach the model", () => {
    const { system, prompt } = draftsPrompt(brief, {
      topic: { title: "Storm checks", angle: null, category: "seasonal" }, platforms: ["x", "facebook_page"], tone: null, avoidOpenings: [],
      sources: [{ id: "S1", url: "https://news.test/a", title: "Storm season", excerpt: "Forecasters expect...", retrieved_at: "2026-10-20T00:00:00Z", published_at: null }],
    });
    assert.match(system, /Never invent weather, local events, statistics/);
    assert.match(prompt, /Licensed and insured in Texas/);
    assert.match(prompt, /\[S1\] Storm season \(https:\/\/news.test\/a; retrieved 2026-10-20\)/);
    assert.match(prompt, /- x \(X\): .*max 280/);
    const none = draftsPrompt(brief, { topic: { title: "t", angle: null, category: null }, platforms: ["x"], tone: null, sources: [], avoidOpenings: [] });
    assert.match(none.prompt, /Research sources: none\. Do not include statistics/);
  });

  test("topic prompts list recent titles and avoided subjects", () => {
    const { prompt } = topicsPrompt(brief, { count: 3, categories: ["faq", "seasonal"], recentTitles: ["Gutter cleaning basics"], avoid: ["pricing"] });
    assert.match(prompt, /Suggest 3 new topics in these categories: Customer questions, Seasonal advice/);
    assert.match(prompt, /- Gutter cleaning basics/);
    assert.match(prompt, /Avoid these subjects entirely: pricing/);
  });
});
