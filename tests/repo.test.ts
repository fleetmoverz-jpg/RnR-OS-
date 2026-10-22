// Authorization boundaries of the Social data layer, run against a real database.
// Needs a disposable Supabase (or PostgREST) instance with all migrations applied:
//   SOCIAL_TEST_SUPABASE_URL=http://localhost:54321 SOCIAL_TEST_SUPABASE_KEY=<service role key> npm test
// Without those variables the tests are skipped. Each run uses its own workspaces and deletes them afterwards.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveWorkspace, socialRepo, type SocialContext, type SocialRepo } from "../src/lib/social/repo";
import { AccessDenied, NotFound } from "../src/lib/social/policy";

const url = process.env.SOCIAL_TEST_SUPABASE_URL;
const key = process.env.SOCIAL_TEST_SUPABASE_KEY;

describe("social repo workspace boundaries", { skip: !url || !key ? "set SOCIAL_TEST_SUPABASE_URL and SOCIAL_TEST_SUPABASE_KEY" : false }, () => {
  let client: SupabaseClient;
  const run = randomUUID().slice(0, 8);
  const ownerA = `owner-a-${run}@test.example`;
  const ownerB = `owner-b-${run}@test.example`;
  const viewerA = `viewer-a-${run}@test.example`;
  const editorA = `editor-a-${run}@test.example`;
  let a: SocialRepo, b: SocialRepo, viewer: SocialRepo, editor: SocialRepo;
  let brandA: string, brandB: string, websiteA: string, postB: string;
  const workspaceIds: string[] = [];

  before(async () => {
    client = createClient(url!, key!, { auth: { persistSession: false } });
    const ra = await resolveWorkspace(client, ownerA, { bootstrapOwner: true });
    const rb = await resolveWorkspace(client, ownerB, { bootstrapOwner: true });
    assert.ok(ra && rb);
    workspaceIds.push(ra.ctx.workspaceId, rb.ctx.workspaceId);
    a = socialRepo(client, ra.ctx);
    b = socialRepo(client, rb.ctx);
    const { error } = await client.from("workspace_members").insert([
      { workspace_id: ra.ctx.workspaceId, email: viewerA, role: "viewer" },
      { workspace_id: ra.ctx.workspaceId, email: editorA, role: "editor" },
    ]);
    assert.ifError(error);
    viewer = socialRepo(client, (await resolveWorkspace(client, viewerA))!.ctx);
    editor = socialRepo(client, (await resolveWorkspace(client, editorA))!.ctx);

    brandA = (await a.createBrand({ name: `Brand A ${run}`, niche: "Plumbing", timezone: "UTC" })).id;
    brandB = (await b.createBrand({ name: `Brand B ${run}`, niche: null, timezone: "UTC" })).id;
    websiteA = (await a.addWebsiteManually({ url: `https://a-${run}.example.com`, domain: `a-${run}.example.com` }, brandA)).id;
    postB = (await b.createDraftPost({ brand_id: brandB, title: "B's draft", body: "" })).id;
  });

  after(async () => {
    if (workspaceIds.length) await client.from("workspaces").delete().in("id", workspaceIds);
  });

  test("a person with no membership gets no workspace unless they are the bootstrapped owner", async () => {
    assert.equal(await resolveWorkspace(client, `stranger-${run}@test.example`), null);
  });

  test("choosing a workspace you don't belong to falls back to your own", async () => {
    const r = await resolveWorkspace(client, ownerA, { preferredId: b.ctx.workspaceId });
    assert.equal(r?.ctx.workspaceId, a.ctx.workspaceId);
  });

  test("listing only returns your workspace's brands", async () => {
    const ids = (await a.listBrands()).map((x) => x.id);
    assert.ok(ids.includes(brandA));
    assert.ok(!ids.includes(brandB));
  });

  test("reading another workspace's brand is not found", async () => {
    await assert.rejects(a.getBrand(brandB), NotFound);
    await assert.rejects(a.getProfile(brandB), NotFound);
  });

  test("changing another workspace's brand is refused and leaves it unchanged", async () => {
    await assert.rejects(a.updateBrand(brandB, { name: "Hijacked", niche: null, timezone: "UTC" }), NotFound);
    await assert.rejects(a.setBrandArchived(brandB, true), NotFound);
    await assert.rejects(a.saveProfile(brandB, { business_name: "Hijacked", phone: null, email: null, address: null, services: [], service_areas: [], tone: null, description: null }), NotFound);
    const still = await b.getBrand(brandB);
    assert.equal(still.name, `Brand B ${run}`);
    assert.equal(still.status, "active");
    assert.equal((await b.getProfile(brandB))?.business_name, null);
  });

  test("a website can't be assigned to another workspace's brand", async () => {
    await assert.rejects(a.assignWebsite(websiteA, brandB), NotFound);
    await assert.rejects(b.assignWebsite(websiteA, brandB), NotFound);
    assert.equal((await a.getWebsite(websiteA)).brand_id, brandA);
  });

  test("posts can't be created for, or deleted from, another workspace", async () => {
    await assert.rejects(a.createDraftPost({ brand_id: brandB, title: "Leak", body: "" }), NotFound);
    await assert.rejects(a.deleteDraftPost(postB), NotFound);
    assert.ok((await b.listPosts()).some((p) => p.id === postB));
    assert.ok(!(await a.listPosts()).some((p) => p.id === postB));
  });

  test("overview counts only your workspace", async () => {
    const counts = await a.overview();
    assert.equal(counts.brands, 1);
    assert.equal(counts.websites, 1);
    assert.equal(counts.drafts, 0);
  });

  test("viewers can read but not change anything", async () => {
    assert.equal((await viewer.listBrands()).length, 1);
    await assert.rejects(viewer.createBrand({ name: "No", niche: null, timezone: "UTC" }), AccessDenied);
    await assert.rejects(viewer.createDraftPost({ brand_id: brandA, title: "No", body: "" }), AccessDenied);
    await assert.rejects(viewer.addWebsiteManually({ url: "https://no.example.com", domain: "no.example.com" }), AccessDenied);
    await assert.rejects(viewer.renameWorkspace("No"), AccessDenied);
  });

  test("editors write posts but can't manage websites or the workspace", async () => {
    const post = await editor.createDraftPost({ brand_id: brandA, title: "Editor draft", body: "Hello" });
    assert.equal(post.created_by, editorA);
    await assert.rejects(editor.addWebsiteManually({ url: "https://no.example.com", domain: "no.example.com" }), AccessDenied);
    await assert.rejects(editor.createBrand({ name: "No", niche: null, timezone: "UTC" }), AccessDenied);
    await assert.rejects(editor.renameWorkspace("No"), AccessDenied);
  });

  test("a duplicate website gives a clear message", async () => {
    await assert.rejects(a.addWebsiteManually({ url: `https://a-${run}.example.com`, domain: `a-${run}.example.com` }), /already in this workspace/);
  });

  test("changes are written to the audit log of the right workspace", async () => {
    const actions = (await a.listAudit(50)).map((e) => e.action);
    assert.ok(actions.includes("brand.created"));
    assert.ok(actions.includes("website.added"));
    assert.ok(!(await a.listAudit(50)).some((e) => e.entity_id === brandB));
  });

  test("a forged context can't reach rows the database ties to another workspace", async () => {
    // Even if application code passed a wrong brand id with a real workspace, the composite keys refuse it.
    const forged: SocialContext = { ...a.ctx };
    const { error } = await client.from("posts").insert({ workspace_id: forged.workspaceId, brand_id: brandB, title: "Forged", created_by: ownerA });
    assert.equal(error?.code, "23503");
  });
});
