import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { withUtm } from "../src/lib/social/analytics/utm";
import { parseRange } from "../src/lib/social/analytics/service";
import { logError, scrub } from "../src/lib/social/log";

const on = { enabled: true, utm_source: "{platform}", utm_medium: "social", utm_campaign: "rnr-os" };

describe("UTM tagging", () => {
  test("adds the brand's tags, with the platform filled in", () => {
    assert.equal(withUtm("https://roofco.test/inspections", on, "facebook_page"), "https://roofco.test/inspections?utm_source=facebook_page&utm_medium=social&utm_campaign=rnr-os");
  });
  test("keeps tags and parameters already on the link", () => {
    assert.equal(withUtm("https://roofco.test/a?ref=x&utm_campaign=spring#top", on, "instagram"), "https://roofco.test/a?ref=x&utm_campaign=spring&utm_source=instagram&utm_medium=social#top");
  });
  test("does nothing when off, with no link, or for odd links", () => {
    assert.equal(withUtm("https://roofco.test/", { ...on, enabled: false }, "x"), "https://roofco.test/");
    assert.equal(withUtm("https://roofco.test/", null, "x"), "https://roofco.test/");
    assert.equal(withUtm(null, on, "x"), null);
    assert.equal(withUtm("mailto:a@b.test", on, "x"), "mailto:a@b.test");
    assert.equal(withUtm("not a url", on, "x"), "not a url");
  });
});

describe("date ranges", () => {
  const now = new Date("2026-10-22T15:00:00Z");
  test("presets cover whole UTC days up to today", () => {
    const r = parseRange({ range: "7" }, now);
    assert.deepEqual([r.from.toISOString(), r.to.toISOString(), r.label], ["2026-10-16T00:00:00.000Z", "2026-10-23T00:00:00.000Z", "Last 7 days"]);
    assert.equal(parseRange({}, now).label, "Last 30 days");
    assert.equal(parseRange({ range: "365000" }, now).label, "Last 30 days");
  });
  test("custom ranges are inclusive and capped at a year", () => {
    const r = parseRange({ from: "2026-09-01", to: "2026-09-30" }, now);
    assert.deepEqual([r.from.toISOString(), r.to.toISOString()], ["2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
    assert.equal(parseRange({ from: "2024-01-01", to: "2026-01-01" }, now).label, "Last 30 days");
    assert.equal(parseRange({ from: "2026-10-05", to: "2026-10-01" }, now).label, "Last 30 days");
    assert.equal(parseRange({ from: "2026-13-45", to: "2026-10-01" }, now).label, "Last 30 days");
  });
});

describe("error logging", () => {
  test("log lines are JSON and carry no tokens", () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (s: string) => lines.push(s);
    try {
      logError("publish", new Error("POST /feed?access_token=EAABsecretsecretsecretsecret failed"), { job: "j1" });
    } finally {
      console.error = original;
    }
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.scope, "publish");
    assert.equal(entry.job, "j1");
    assert.ok(!lines[0].includes("EAABsecret"));
    assert.equal(scrub("Bearer abc.def"), "Bearer [redacted]");
  });
});
