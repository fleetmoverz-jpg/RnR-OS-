import { test } from "node:test";
import assert from "node:assert/strict";
import { crawlSite } from "../src/lib/social/crawler";
import { decodeEntities, extractCandidates, fieldStatus, parsePage, socialProfile, type Candidate } from "../src/lib/social/extract";
import { suggestionsToCandidates } from "../src/lib/social/brandAi";
import { mockSite, roofingSite } from "./support/mock-site";

const ORIGIN = "https://www.copperasroofing.test";

async function candidates() {
  const r = await crawlSite("https://copperasroofing.test", mockSite(roofingSite()).fetcher);
  return extractCandidates(r.pages.map((p) => parsePage(p.url, p.html)), r.homepage!.url, r.sitemapPages);
}
const values = (cs: Candidate[], kind: Candidate["kind"]) => cs.filter((c) => c.kind === kind).map((c) => c.value);

test("structured data supplies name, contact details, address, hours, areas and social profiles, with sources", async () => {
  const cs = await candidates();
  const top = (kind: Candidate["kind"]) => cs.filter((c) => c.kind === kind).sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
  assert.equal(top("name").value, "Copperas Cove Roofing Co.");
  assert.equal(top("name").origin, "structured_data");
  assert.equal(top("phone").value, "(254) 555-0142");
  assert.equal(top("email").value, "hello@copperasroofing.test");
  assert.equal(top("address").value, "120 Main St, Copperas Cove, TX 76522, US");
  assert.equal(top("city").value, "Copperas Cove");
  assert.equal(top("region").value, "TX");
  assert.match(top("hours").value, /^Mon, Tue, Wed, Thu, Fri 08:00–17:00$/);
  assert.equal(top("canonical_domain").value, "copperasroofing.test");
  assert.equal(top("website_url").value, ORIGIN);
  assert.equal(top("logo").value, `${ORIGIN}/img/logo.png`);
  assert.deepEqual(new Set(values(cs, "service_area")), new Set(["Copperas Cove", "Killeen", "Harker Heights"]));
  assert.deepEqual(new Set(values(cs, "social_link")), new Set(["https://facebook.com/copperasroofing", "https://instagram.com/copperasroofing", "https://x.com/copperasroof"]));
  for (const c of cs) assert.ok(c.source_url?.startsWith("https://"), `${c.kind} "${c.value}" has a source page`);
  assert.equal(cs.filter((c) => c.kind === "phone").length, 1, "the same number in three formats is one fact");
});

test("service pages, services, articles and the sitemap-only article are found", async () => {
  const cs = await candidates();
  assert.ok(values(cs, "service").includes("Roof Leak Repair"));
  assert.ok(values(cs, "service").includes("Roof Replacement"));
  assert.ok(values(cs, "service_page").includes(`${ORIGIN}/services/roof-leak-repair`));
  const articles = cs.filter((c) => c.kind === "article");
  assert.ok(articles.some((a) => a.value === `${ORIGIN}/blog/signs-of-a-roof-leak` && a.label === "Early signs of a roof leak"));
  assert.ok(articles.some((a) => a.value === `${ORIGIN}/blog/what-to-check-after-a-storm` && a.confidence === 0.5));
});

test("claims, certifications and offers are quoted word for word from the page", async () => {
  const cs = await candidates();
  const cert = cs.find((c) => c.kind === "certification");
  assert.equal(cert?.value, "Our crew is licensed and insured in the state of Texas.");
  assert.equal(cert?.source_quote, cert?.value);
  assert.equal(cert?.source_url, `${ORIGIN}/`);
  assert.ok(values(cs, "offer").includes("We offer free roof inspections after every storm."));
  assert.ok(values(cs, "claim").includes("Family-owned and serving Copperas Cove since 2009."));
});

test("nothing is invented: no reviews, and no address from free text", async () => {
  const cs = await candidates();
  assert.ok(!cs.some((c) => /4\.9|212|review/i.test(c.value)), "aggregateRating is never turned into a fact");
  assert.ok(!values(cs, "address").some((a) => /Fake Road/.test(a)), "a street mentioned in a sentence is not an address");

  const bare = parsePage("https://plain.test/", "<html><title>Plain</title><body><p>We are at 5 Elm Street, Austin TX.</p></body></html>");
  const plain = extractCandidates([bare], "https://plain.test/");
  for (const kind of ["address", "phone", "email", "hours", "certification", "name"] as const) assert.deepEqual(values(plain, kind), [], kind);
});

test("an address in structured data needs a street before it counts", () => {
  const page = parsePage(
    "https://x.test/",
    `<script type="application/ld+json">{"@type":"LocalBusiness","name":"X","address":{"@type":"PostalAddress","addressLocality":"Austin","addressRegion":"TX"}}</script>`,
  );
  const cs = extractCandidates([page], "https://x.test/");
  assert.deepEqual(values(cs, "address"), []);
  assert.deepEqual(values(cs, "city"), ["Austin"]);
});

test("share buttons and post links are not social profiles", () => {
  assert.equal(socialProfile("https://www.facebook.com/sharer/sharer.php?u=x"), null);
  assert.equal(socialProfile("https://twitter.com/intent/tweet?text=x"), null);
  assert.equal(socialProfile("https://www.instagram.com/p/abc123/"), null);
  assert.equal(socialProfile("https://facebook.com/"), null);
  assert.equal(socialProfile("https://www.linkedin.com/company/acme/"), "https://linkedin.com/company/acme");
  assert.equal(socialProfile("https://www.yelp.com/biz/acme-roofing"), "https://yelp.com/biz/acme-roofing");
  assert.equal(socialProfile("https://www.yelp.com/search?x"), null);
});

test("conflicts: different phone numbers conflict, variants of one name don't", () => {
  const c = (kind: Candidate["kind"], value: string, confidence = 0.9): Candidate => ({ kind, value, source_url: "https://x.test/", source_quote: value, origin: "website", confidence });
  assert.equal(fieldStatus("phone", true, [c("phone", "(254) 555-0142"), c("phone", "+1 254 555 0142")]), "found");
  assert.equal(fieldStatus("phone", true, [c("phone", "(254) 555-0142"), c("phone", "(254) 555-9999")]), "conflict");
  assert.equal(fieldStatus("name", true, [c("name", "Copperas Roofing LLC"), c("name", "Copperas Roofing")]), "found");
  assert.equal(fieldStatus("name", true, [c("name", "Copperas Roofing"), c("name", "Lone Star Gutters")]), "conflict");
  assert.equal(fieldStatus("phone", true, [c("phone", "(254) 555-9999", 0.3)]), "missing", "low confidence alone doesn't count");
  assert.equal(fieldStatus("industry", true, [{ ...c("industry", "Roofing"), origin: "ai_suggestion" as const, confidence: null }]), "suggested");
  assert.equal(fieldStatus("service", false, [c("service", "A"), c("service", "B")]), "found", "lists never conflict");
});

test("AI output only becomes descriptive suggestions with no source", () => {
  const cs = suggestionsToCandidates({ industry: "Home services", niche: "Roof leak repair", tone: "", value_proposition: "Fast local repairs", description: "A roofer.", phone: "555-1234", address: "1 Fake St" }, "model-x");
  assert.deepEqual(cs.map((c) => c.kind).sort(), ["description", "industry", "niche", "usp"]);
  for (const c of cs) {
    assert.equal(c.origin, "ai_suggestion");
    assert.equal(c.source_url, null);
    assert.equal(c.confidence, null);
  }
});

test("HTML entities are decoded and scripts are not read as text", () => {
  assert.equal(decodeEntities("Tom &amp; Sons &#8211; &#x27;Roofing&#x27; &nbsp;"), "Tom & Sons – 'Roofing'  ");
  const p = parsePage("https://x.test/", "<html><body><script>var phone='(512) 555-0100'</script><p>Hi</p></body></html>");
  assert.ok(!p.text.includes("555"));
});
