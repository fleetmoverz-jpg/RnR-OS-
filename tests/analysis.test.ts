// Website analysis and brand profile review against a real database, with a mocked website and AI.
//   SOCIAL_TEST_SUPABASE_URL=http://localhost:54321 SOCIAL_TEST_SUPABASE_KEY=<service role key> npm test
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveWorkspace, socialRepo, type SocialContext } from "../src/lib/social/repo";
import { AccessDenied, NotFound } from "../src/lib/social/policy";
import { analysisService, type AnalysisDeps, type BrandFact } from "../src/lib/social/analysis";
import type { SuggestFn } from "../src/lib/social/brandAi";
import { mockSite, roofingSite } from "./support/mock-site";

const url = process.env.SOCIAL_TEST_SUPABASE_URL;
const key = process.env.SOCIAL_TEST_SUPABASE_KEY;

describe("website analysis and brand profiles", { skip: !url || !key ? "set SOCIAL_TEST_SUPABASE_URL and SOCIAL_TEST_SUPABASE_KEY" : false }, () => {
  let client: SupabaseClient;
  const run = randomUUID().slice(0, 8);
  const host = `roof-${run}.test`;
  const ORIGIN = `https://www.${host}`;
  let ctxA: SocialContext, ctxB: SocialContext, viewer: SocialContext, editor: SocialContext;
  let websiteId: string, brandId: string;
  const workspaceIds: string[] = [];

  const suggest: SuggestFn = async () => [
    { kind: "industry", value: "Home services", source_url: null, source_quote: null, origin: "ai_suggestion", confidence: null, label: "Suggested by test-model" },
    { kind: "tone", value: "friendly, local, practical", source_url: null, source_quote: null, origin: "ai_suggestion", confidence: null, label: "Suggested by test-model" },
  ];

  function service(ctx: SocialContext, pages = roofingSite(ORIGIN), extra: Partial<AnalysisDeps> = {}) {
    const site = mockSite(pages);
    return { svc: analysisService(client, ctx, { fetcher: site.fetcher, suggest, ...extra }), site };
  }

  async function facts(kind?: string) {
    let q = client.from("brand_facts").select("*").eq("brand_id", brandId);
    if (kind) q = q.eq("kind", kind);
    const { data, error } = await q;
    assert.ifError(error);
    return data as BrandFact[];
  }
  async function profile() {
    const { data, error } = await client.from("brand_profiles").select("*").eq("brand_id", brandId).maybeSingle();
    assert.ifError(error);
    return data;
  }

  before(async () => {
    client = createClient(url!, key!, { auth: { persistSession: false } });
    const ra = await resolveWorkspace(client, `owner-a-${run}@test.example`, { bootstrapOwner: true });
    const rb = await resolveWorkspace(client, `owner-b-${run}@test.example`, { bootstrapOwner: true });
    assert.ok(ra && rb);
    ctxA = ra.ctx;
    ctxB = rb.ctx;
    workspaceIds.push(ctxA.workspaceId, ctxB.workspaceId);
    const { error } = await client.from("workspace_members").insert([
      { workspace_id: ctxA.workspaceId, email: `viewer-${run}@test.example`, role: "viewer" },
      { workspace_id: ctxA.workspaceId, email: `editor-${run}@test.example`, role: "editor" },
    ]);
    assert.ifError(error);
    viewer = (await resolveWorkspace(client, `viewer-${run}@test.example`))!.ctx;
    editor = (await resolveWorkspace(client, `editor-${run}@test.example`))!.ctx;
    websiteId = (await socialRepo(client, ctxA).addWebsiteManually({ url: `https://${host}`, domain: host })).id;
  });

  after(async () => {
    if (workspaceIds.length) await client.from("workspaces").delete().in("id", workspaceIds);
  });

  test("viewers and editors can't start a scan; another workspace can't see the website", async () => {
    await assert.rejects(service(viewer).svc.scanWebsite(websiteId), AccessDenied);
    await assert.rejects(service(editor).svc.scanWebsite(websiteId), AccessDenied);
    const other = service(ctxB);
    await assert.rejects(other.svc.scanWebsite(websiteId), NotFound);
    assert.equal(other.site.calls.length, 0);
  });

  test("first scan creates the brand, stores sourced facts and fills only website-backed fields", async () => {
    const { svc } = service(ctxA);
    const scan = await svc.scanWebsite(websiteId);
    brandId = scan.brand_id!;
    assert.equal(scan.status, "succeeded");
    assert.ok(scan.report.brand_created);
    assert.equal(scan.report.ai, "used");
    assert.equal(scan.report.fields?.phone, "found");
    assert.equal(scan.report.fields?.industry, "suggested");
    assert.ok(scan.pages_fetched >= 6);
    const brand = await socialRepo(client, ctxA).getBrand(brandId);
    assert.equal(brand.name, "Copperas Cove Roofing Co.");
    assert.equal((await socialRepo(client, ctxA).getWebsite(websiteId)).brand_id, brandId);

    const p = await profile();
    assert.equal(p.status, "draft");
    assert.deepEqual(p.confirmed_fields, []);
    assert.equal(p.business_name, null, "the site uses two different names, so the user must choose");
    assert.equal(scan.report.fields?.business_name, "conflict");
    assert.equal(p.phone, "(254) 555-0142");
    assert.equal(p.address, "120 Main St, Copperas Cove, TX 76522, US");
    assert.equal(p.canonical_domain, host);
    assert.equal(p.industry, null, "AI suggestions are never auto-filled");
    assert.equal(p.tone, null);
    assert.ok(p.services.includes("Roof Leak Repair"));

    const all = await facts();
    for (const f of all.filter((x) => x.origin !== "ai_suggestion")) assert.ok(f.source_url, `${f.kind} has a source`);
    const ai = all.filter((x) => x.origin === "ai_suggestion");
    assert.deepEqual(ai.map((x) => x.kind).sort(), ["industry", "tone"]);
    assert.ok(all.every((x) => x.status === "extracted"));
    assert.ok(all.some((x) => x.kind === "certification" && x.source_quote === "Our crew is licensed and insured in the state of Texas."));
  });

  test("the database refuses AI-sourced contact details and unsourced website facts", async () => {
    const base = { workspace_id: ctxA.workspaceId, brand_id: brandId, status: "extracted" };
    const ai = await client.from("brand_facts").insert({ ...base, kind: "phone", value: "555-0000", origin: "ai_suggestion" });
    assert.equal(ai.error?.code, "23514");
    const cert = await client.from("brand_facts").insert({ ...base, kind: "certification", value: "Certified by AI", origin: "ai_suggestion" });
    assert.equal(cert.error?.code, "23514");
    const unsourced = await client.from("brand_facts").insert({ ...base, kind: "phone", value: "555-0001", origin: "website" });
    assert.equal(unsourced.error?.code, "23514");
  });

  test("review lists what was found and what needs confirmation", async () => {
    const r = await service(ctxA).svc.review(brandId);
    const field = (name: string) => r.fields.find((f) => f.field === name)!;
    assert.equal(field("phone").status, "found");
    assert.equal(field("phone").needsConfirmation, true);
    assert.equal(field("industry").status, "suggested");
    assert.ok(r.missing.includes("Niche"));
    assert.deepEqual(r.conflicts.sort(), ["Business hours", "Business name"]);
    assert.ok(r.lists.find((l) => l.kind === "social_link")!.facts.length >= 2);
    assert.equal(r.latestScan?.status, "succeeded");
  });

  test("confirming and rejecting facts updates the profile; editors can, viewers can't", async () => {
    const phone = (await facts("phone"))[0];
    await assert.rejects(service(viewer).svc.confirmFact(phone.id), AccessDenied);
    await service(editor).svc.confirmFact(phone.id);
    let p = await profile();
    assert.ok(p.confirmed_fields.includes("phone"));

    const industry = (await facts("industry"))[0];
    await service(editor).svc.confirmFact(industry.id);
    p = await profile();
    assert.equal(p.industry, "Home services", "accepting an AI suggestion is the user's choice");
    assert.equal((await facts("industry"))[0].origin, "ai_suggestion", "it stays labelled as an AI suggestion");

    // Rejecting the text version of the hours leaves one value, so the conflict is resolved.
    const textHours = (await facts("hours")).find((h) => h.origin === "website")!;
    await service(editor).svc.rejectFact(textHours.id);
    assert.equal((await service(ctxA).svc.review(brandId)).fields.find((f) => f.field === "hours")!.status, "found");

    // Rejecting an auto-filled value removes it from the profile.
    const address = (await facts("address")).find((a) => a.value === p.address)!;
    await service(editor).svc.rejectFact(address.id);
    assert.equal((await profile()).address, null);
  });

  test("another workspace can't review, confirm or approve this brand", async () => {
    const svc = service(ctxB).svc;
    const f = (await facts("email"))[0];
    await assert.rejects(svc.review(brandId), NotFound);
    await assert.rejects(svc.confirmFact(f.id), NotFound);
    await assert.rejects(svc.rejectFact(f.id), NotFound);
    await assert.rejects(svc.approveProfile(brandId), NotFound);
    assert.equal((await facts("email"))[0].status, "extracted");
  });

  test("a rescan adds new evidence but never overwrites confirmed or user-edited fields", async () => {
    const svcA = service(ctxA).svc;
    const before = await profile();
    await svcA.saveProfile(brandId, {
      ...before, business_name: "Copperas Roofing", services: ["Roof Leak Repair"], service_areas: before.service_areas, hours: null,
    });
    const changed = roofingSite(ORIGIN);
    const home = changed[`${ORIGIN}/`] as string;
    changed[`${ORIGIN}/`] = home.replaceAll("(254) 555-0142", "(254) 555-7777").replaceAll("+12545550142", "+12545557777").replace("Copperas Cove Roofing Co.", "Totally New Name LLC");
    const scan = await service(ctxA, changed).svc.scanWebsite(websiteId);
    assert.equal(scan.status, "succeeded");

    const p = await profile();
    assert.equal(p.business_name, "Copperas Roofing", "user-edited name kept");
    assert.equal(p.phone, "(254) 555-0142", "confirmed phone kept");
    assert.deepEqual(p.services, ["Roof Leak Repair"]);
    const phones = (await facts("phone")).map((f) => f.value);
    assert.ok(phones.includes("(254) 555-7777"), "the new number is offered for review");
    const r = await svcA.review(brandId);
    assert.equal(r.fields.find((f) => f.field === "phone")!.status, "confirmed");
    assert.equal((await facts("phone")).find((f) => f.value === "(254) 555-0142")!.status, "confirmed", "decision kept on the old fact");
  });

  test("approval needs a name and no conflicts, and only admins can approve", async () => {
    await assert.rejects(service(editor).svc.approveProfile(brandId), AccessDenied);
    // Two different, unconfirmed emails on the site create a conflict.
    await client.from("brand_facts").insert({
      workspace_id: ctxA.workspaceId, brand_id: brandId, kind: "email", value: `other-${run}@elsewhere.test`, origin: "website", source_url: `${ORIGIN}/contact`, source_quote: "x", confidence: 0.9,
    });
    await client.from("brand_profiles").update({ confirmed_fields: ["business_name", "phone"] }).eq("brand_id", brandId);
    await assert.rejects(service(ctxA).svc.approveProfile(brandId), /Resolve the conflicting values first: Email/);
    const email = (await facts("email")).find((f) => f.value === "hello@copperasroofing.test")!;
    await service(ctxA).svc.confirmFact(email.id);
    await service(ctxA).svc.approveProfile(brandId);
    const p = await profile();
    assert.equal(p.status, "approved");
    assert.equal(p.approved_by, ctxA.email);
    assert.ok(p.confirmed_fields.includes("email"));
    const { data: audit } = await client.from("audit_events").select("action").eq("workspace_id", ctxA.workspaceId).eq("action", "brand_profile.approved");
    assert.equal(audit?.length, 1);
  });

  test("only one scan runs at a time; a stuck scan is cleared after 10 minutes", async () => {
    const running = await client.from("website_scans").insert({ workspace_id: ctxA.workspaceId, website_id: websiteId, requested_by: "x", started_at: new Date().toISOString() }).select("id").single();
    assert.ifError(running.error);
    await assert.rejects(service(ctxA).svc.scanWebsite(websiteId), /already running/);
    await client.from("website_scans").update({ started_at: new Date(Date.now() - 11 * 60_000).toISOString() }).eq("id", running.data!.id);
    const scan = await service(ctxA).svc.scanWebsite(websiteId);
    assert.equal(scan.status, "succeeded");
    const { data: old } = await client.from("website_scans").select("status, error").eq("id", running.data!.id).single();
    assert.equal(old?.status, "failed");
  });

  test("an unreachable site or failing AI is reported, not hidden", async () => {
    const down = { [`https://${host}/robots.txt`]: { status: 404 }, [`https://${host}/`]: { status: 500 } };
    await assert.rejects(service(ctxA, down).svc.scanWebsite(websiteId), /HTTP 500/);
    const { data } = await client.from("website_scans").select("status, error").eq("website_id", websiteId).order("started_at", { ascending: false }).limit(1).single();
    assert.equal(data?.status, "failed");
    assert.match(data?.error ?? "", /HTTP 500/);

    const failingAi: SuggestFn = async () => {
      throw new Error("provider overloaded");
    };
    const partial = await service(ctxA, roofingSite(ORIGIN), { suggest: failingAi }).svc.scanWebsite(websiteId);
    assert.equal(partial.status, "partial");
    assert.match(partial.report.ai ?? "", /provider overloaded/);

    const noAi = await service(ctxA, roofingSite(ORIGIN), { suggest: null, aiUnavailable: "ANTHROPIC_API_KEY is not set" }).svc.scanWebsite(websiteId);
    assert.equal(noAi.report.ai, "skipped: ANTHROPIC_API_KEY is not set");
  });
});
