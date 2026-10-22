import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { backoffSeconds, isTimeZone, localLabel, upcomingSlots, weekOfInstant, zonedToUtc } from "../src/lib/social/automation/time";
import { scrub } from "../src/lib/social/automation/worker";

const iso = (d: Date) => d.toISOString().replace(".000", "");

describe("time zones", () => {
  test("wall-clock times convert to UTC with the right offset", () => {
    assert.equal(iso(zonedToUtc("2026-10-23", "10:00", "Asia/Karachi")), "2026-10-23T05:00:00Z");
    assert.equal(iso(zonedToUtc("2026-07-01", "09:00", "America/New_York")), "2026-07-01T13:00:00Z");
    assert.equal(iso(zonedToUtc("2026-12-01", "09:00", "America/New_York")), "2026-12-01T14:00:00Z");
    assert.equal(iso(zonedToUtc("2026-06-01", "00:00", "UTC")), "2026-06-01T00:00:00Z");
  });

  test("a time skipped by spring-forward moves past the gap; a repeated autumn time takes the first one", () => {
    // New York jumps from 02:00 to 03:00 on 8 March 2026.
    assert.equal(iso(zonedToUtc("2026-03-08", "02:30", "America/New_York")), "2026-03-08T07:30:00Z");
    assert.equal(localLabel(new Date("2026-03-08T07:30:00Z"), "America/New_York"), "2026-03-08 03:30");
    // 01:30 happens twice on 1 November 2026; the first is still daylight time (UTC-4).
    assert.equal(iso(zonedToUtc("2026-11-01", "01:30", "America/New_York")), "2026-11-01T05:30:00Z");
    assert.equal(iso(zonedToUtc("2026-03-29", "01:30", "Europe/London")), "2026-03-29T01:30:00Z");
    assert.equal(iso(zonedToUtc("2026-10-25", "01:30", "Europe/London")), "2026-10-25T00:30:00Z");
  });

  test("weekly slots keep their local time across a daylight-saving change", () => {
    const slots = upcomingSlots({ daysOfWeek: [1, 5], times: ["09:00"], postsPerWeek: 3, timezone: "America/New_York" }, new Date("2026-10-28T00:00:00Z"), 7);
    assert.deepEqual(slots.map((s) => [s.local, iso(s.runAt), s.week]), [
      ["2026-10-30 09:00", "2026-10-30T13:00:00Z", "2026-10-26"],
      ["2026-11-02 09:00", "2026-11-02T14:00:00Z", "2026-11-02"],
    ]);
  });

  test("slots start after `from`, stay inside the window and come out in time order", () => {
    const from = new Date("2026-10-26T13:30:00Z"); // Monday 18:30 in Karachi
    const slots = upcomingSlots({ daysOfWeek: [1, 3], times: ["18:00", "09:00"], postsPerWeek: 5, timezone: "Asia/Karachi" }, from, 3);
    assert.deepEqual(slots.map((s) => s.local), ["2026-10-28 09:00", "2026-10-28 18:00"]);
    assert.ok(slots.every((s) => s.runAt > from));
  });

  test("weeks are counted Monday to Sunday in the brand's zone", () => {
    // Sunday 23:30 in Karachi is still Sunday there, though it's Sunday 18:30 UTC.
    assert.equal(weekOfInstant(new Date("2026-11-01T18:30:00Z"), "Asia/Karachi"), "2026-10-26");
    // Monday 00:30 in Karachi is Sunday 19:30 UTC but already next week locally.
    assert.equal(weekOfInstant(new Date("2026-11-01T19:30:00Z"), "Asia/Karachi"), "2026-11-02");
  });

  test("only real IANA zones are accepted", () => {
    assert.equal(isTimeZone("Asia/Karachi"), true);
    assert.equal(isTimeZone("Mars/Base"), false);
  });
});

describe("retries and logs", () => {
  test("backoff doubles from 2 minutes, caps at 6 hours and respects the platform's wait", () => {
    assert.deepEqual([1, 2, 3, 4].map((n) => backoffSeconds(n)), [120, 240, 480, 960]);
    assert.equal(backoffSeconds(30), 6 * 3600);
    assert.equal(backoffSeconds(1, 900), 900);
  });

  test("error text is scrubbed of tokens before it is logged", () => {
    const raw = "GET https://graph.facebook.com/me?access_token=EAABsecret123&appsecret_proof=abc failed; Bearer ya29.a0AfH6SMBxyzxyzxyzxyz; token EAAGm0PX4ZCpsBAKZCZCabcdefghijklmnop";
    const clean = scrub(raw);
    for (const secret of ["EAABsecret123", "appsecret_proof=abc", "ya29.", "EAAGm0PX4"]) assert.ok(!clean.includes(secret), clean);
    assert.match(clean, /access_token=\[redacted\]/);
  });
});
