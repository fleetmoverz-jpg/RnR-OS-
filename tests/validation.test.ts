import { test } from "node:test";
import assert from "node:assert/strict";
import { brandInput, normalizeWebsite, postDraftInput, profileInput, slugify, websiteInput } from "../src/lib/social/validation";

test("slugify matches the database slug rule", () => {
  const rule = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  for (const name of ["Acme Plumbing", "  Café  Déjà Vu!! ", "A--B", "x".repeat(100) + " y"]) {
    const s = slugify(name);
    assert.match(s, rule, name);
    assert.ok(s.length <= 60);
  }
  assert.equal(slugify("Acme Plumbing & Heating"), "acme-plumbing-heating");
});

test("normalizeWebsite accepts common forms and lowercases the domain", () => {
  assert.deepEqual(normalizeWebsite("Example.com"), { url: "https://example.com", domain: "example.com" });
  assert.deepEqual(normalizeWebsite("https://www.Example.co.uk/path?q=1"), { url: "https://www.example.co.uk", domain: "example.co.uk" });
  assert.deepEqual(normalizeWebsite("sc-domain:example.com"), { url: "https://example.com", domain: "example.com" });
  assert.equal(normalizeWebsite("not a site"), null);
  assert.equal(normalizeWebsite("localhost"), null);
  assert.equal(normalizeWebsite(""), null);
});

test("brand input requires a name and a real time zone", () => {
  assert.equal(brandInput.safeParse({ name: "" }).success, false);
  assert.equal(brandInput.safeParse({ name: "Acme", timezone: "Mars/Olympus" }).success, false);
  const ok = brandInput.parse({ name: "  Acme ", niche: "", timezone: "Europe/London" });
  assert.deepEqual(ok, { name: "Acme", niche: null, timezone: "Europe/London" });
});

test("profile input splits lists and rejects a bad email", () => {
  const p = profileInput.parse({ services: "Boilers, Leaks\nDrains\n", service_areas: "", email: "" });
  assert.deepEqual(p.services, ["Boilers", "Leaks", "Drains"]);
  assert.deepEqual(p.service_areas, []);
  assert.equal(p.email, null);
  assert.equal(profileInput.safeParse({ email: "nope" }).success, false);
});

test("website input gives a friendly error", () => {
  const bad = websiteInput.safeParse({ url: "???" });
  assert.equal(bad.success, false);
  assert.equal(websiteInput.parse({ url: "acme.com" }).url.domain, "acme.com");
});

test("post draft needs a valid brand id and title", () => {
  assert.equal(postDraftInput.safeParse({ brand_id: "x", title: "Hi" }).success, false);
  assert.equal(postDraftInput.safeParse({ brand_id: "8b6c2a0e-1d2f-4c3b-9a1e-2f3d4c5b6a70", title: "" }).success, false);
  assert.equal(postDraftInput.parse({ brand_id: "8b6c2a0e-1d2f-4c3b-9a1e-2f3d4c5b6a70", title: "Hi" }).body, "");
});
