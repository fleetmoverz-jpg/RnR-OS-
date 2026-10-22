// Data access for the Social module. Every read and write is scoped to ctx.workspaceId and checked
// against the member's role; workspace_id always comes from the context, never from user input.
// The database repeats the guarantee with composite (id, workspace_id) foreign keys.
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertCan, isRole, NotFound, type Role } from "./policy";
import type { BrandInput, PostDraftInput, ProfileInput } from "./validation";
import { normalizeWebsite, slugify } from "./validation";

export type SocialContext = { email: string; workspaceId: string; role: Role };
export type WorkspaceSummary = { id: string; name: string; role: Role };

export type Brand = {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  niche: string | null;
  timezone: string;
  primary_website_id: string | null;
  autopilot: boolean;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
};

export type Website = {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  gsc_site_id: string | null;
  url: string;
  domain: string;
  verification_status: "unverified" | "pending" | "verified" | "failed";
  verification_method: "search_console" | "manual" | null;
  verified_at: string | null;
  created_at: string;
};

export type BrandProfile = {
  brand_id: string;
  business_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  services: string[];
  service_areas: string[];
  tone: string | null;
  description: string | null;
  updated_at: string;
};

export type SocialAccount = {
  id: string;
  brand_id: string;
  platform: string;
  display_name: string;
  avatar_url: string | null;
  status: "connected" | "needs_reconnect" | "revoked" | "error";
  token_expires_at: string | null;
  last_error: string | null;
  connected_at: string;
};

export type Post = {
  id: string;
  brand_id: string;
  title: string;
  body: string;
  status: string;
  origin: "manual" | "ai";
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type ScheduledJob = {
  id: string;
  run_at: string;
  status: string;
  attempts: number;
  last_error: string | null;
  post_variants: { platform: string; body: string; posts: { title: string; brand_id: string } | null } | null;
};

export type PublishAttempt = {
  id: string;
  attempt_no: number;
  started_at: string;
  finished_at: string | null;
  outcome: "success" | "error" | null;
  http_status: number | null;
  error_code: string | null;
  error_message: string | null;
  scheduled_jobs: { post_variants: { platform: string; posts: { title: string } | null } | null } | null;
};

export type AuditEvent = { id: number; actor_email: string; action: string; entity_type: string; entity_id: string | null; details: Record<string, unknown>; created_at: string };

type Result<T> = { data: T | null; error: { message: string; code?: string } | null };

// Raised when the Social tables don't exist yet (migration 0003 not run).
export class SocialTablesMissing extends Error {}

function must<T>({ data, error }: Result<T>): T {
  if (error && ["42P01", "PGRST200", "PGRST205"].includes(error.code ?? "")) throw new SocialTablesMissing(error.message);
  if (error) throw new Error(error.message);
  return data as T;
}

// Friendly message for unique-key clashes; the rest pass through unchanged.
function explain(error: { message: string; code?: string } | null, duplicate: string): never | void {
  if (!error) return;
  if (error.code === "23505") throw new Error(duplicate);
  throw new Error(error.message);
}

// Finds the workspaces this email belongs to and picks the active one. When bootstrapOwner is set and the
// person has none yet (first visit by the app owner), a workspace is created with them as owner.
export async function resolveWorkspace(
  client: SupabaseClient,
  email: string,
  opts: { preferredId?: string | null; bootstrapOwner?: boolean } = {},
): Promise<{ ctx: SocialContext; workspaces: WorkspaceSummary[] } | null> {
  const load = async () =>
    must(
      await client
        .from("workspace_members")
        .select("role, created_at, workspaces(id, name)")
        .eq("email", email.toLowerCase())
        .order("created_at"),
    ) as unknown as { role: string; workspaces: { id: string; name: string } | null }[];

  let rows = await load();
  if (rows.length === 0 && opts.bootstrapOwner) {
    const ws = must(await client.from("workspaces").insert({ name: "My workspace" }).select("id").single()) as { id: string };
    must(await client.from("workspace_members").insert({ workspace_id: ws.id, email: email.toLowerCase(), role: "owner" }));
    must(await client.from("audit_events").insert({ workspace_id: ws.id, actor_email: email.toLowerCase(), action: "workspace.created", entity_type: "workspace", entity_id: ws.id }));
    rows = await load();
  }

  const workspaces: WorkspaceSummary[] = rows
    .filter((r) => r.workspaces && isRole(r.role))
    .map((r) => ({ id: r.workspaces!.id, name: r.workspaces!.name, role: r.role as Role }));
  if (workspaces.length === 0) return null;
  const active = workspaces.find((w) => w.id === opts.preferredId) ?? workspaces[0];
  return { ctx: { email: email.toLowerCase(), workspaceId: active.id, role: active.role }, workspaces };
}

export function socialRepo(client: SupabaseClient, ctx: SocialContext) {
  const ws = ctx.workspaceId;

  async function audit(action: string, entityType: string, entityId: string | null, details: Record<string, unknown> = {}) {
    must(await client.from("audit_events").insert({ workspace_id: ws, actor_email: ctx.email, action, entity_type: entityType, entity_id: entityId, details }));
  }

  async function count(table: string, filter?: (q: ReturnType<ReturnType<SupabaseClient["from"]>["select"]>) => unknown) {
    let q = client.from(table).select("*", { count: "exact", head: true }).eq("workspace_id", ws);
    if (filter) q = filter(q) as typeof q;
    const { count: n, error } = await q;
    if (error) throw new Error(error.message);
    return n ?? 0;
  }

  const repo = {
    ctx,

    async getWorkspace() {
      assertCan(ctx.role, "workspace.view");
      return must(await client.from("workspaces").select("id, name, created_at").eq("id", ws).single()) as { id: string; name: string; created_at: string };
    },

    async renameWorkspace(name: string) {
      assertCan(ctx.role, "workspace.manage");
      must(await client.from("workspaces").update({ name }).eq("id", ws));
      await audit("workspace.renamed", "workspace", ws, { name });
    },

    async listMembers() {
      assertCan(ctx.role, "workspace.view");
      return must(await client.from("workspace_members").select("email, role, created_at").eq("workspace_id", ws).order("created_at")) as { email: string; role: Role; created_at: string }[];
    },

    // ---- Brands
    async listBrands(opts: { includeArchived?: boolean } = {}) {
      assertCan(ctx.role, "workspace.view");
      let q = client.from("brands").select("*").eq("workspace_id", ws).order("name");
      if (!opts.includeArchived) q = q.eq("status", "active");
      return must(await q) as Brand[];
    },

    async getBrand(id: string) {
      assertCan(ctx.role, "workspace.view");
      const brand = must(await client.from("brands").select("*").eq("workspace_id", ws).eq("id", id).maybeSingle()) as Brand | null;
      if (!brand) throw new NotFound("Brand");
      return brand;
    },

    async createBrand(input: BrandInput) {
      assertCan(ctx.role, "brand.create");
      const base = slugify(input.name) || "brand";
      const taken = new Set(((must(await client.from("brands").select("slug").eq("workspace_id", ws).like("slug", `${base}%`)) as { slug: string }[]) ?? []).map((b) => b.slug));
      let slug = base;
      for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
      const { data, error } = await client
        .from("brands")
        .insert({ workspace_id: ws, name: input.name, slug, niche: input.niche, timezone: input.timezone })
        .select("*")
        .single();
      explain(error, "A brand with that name already exists.");
      const brand = data as Brand;
      must(await client.from("brand_profiles").insert({ brand_id: brand.id, workspace_id: ws }));
      await audit("brand.created", "brand", brand.id, { name: brand.name });
      return brand;
    },

    async updateBrand(id: string, input: BrandInput) {
      assertCan(ctx.role, "brand.edit");
      await repo.getBrand(id);
      must(await client.from("brands").update({ name: input.name, niche: input.niche, timezone: input.timezone }).eq("workspace_id", ws).eq("id", id));
      await audit("brand.updated", "brand", id, { name: input.name });
    },

    async setBrandArchived(id: string, archived: boolean) {
      assertCan(ctx.role, "brand.archive");
      await repo.getBrand(id);
      must(await client.from("brands").update({ status: archived ? "archived" : "active" }).eq("workspace_id", ws).eq("id", id));
      await audit(archived ? "brand.archived" : "brand.restored", "brand", id);
    },

    async getProfile(brandId: string) {
      await repo.getBrand(brandId);
      return must(await client.from("brand_profiles").select("*").eq("workspace_id", ws).eq("brand_id", brandId).maybeSingle()) as BrandProfile | null;
    },

    async saveProfile(brandId: string, input: ProfileInput) {
      assertCan(ctx.role, "brand.edit");
      await repo.getBrand(brandId);
      must(await client.from("brand_profiles").upsert({ brand_id: brandId, workspace_id: ws, ...input }, { onConflict: "brand_id" }));
      await audit("brand_profile.updated", "brand", brandId, { fields: Object.keys(input) });
    },

    // ---- Websites
    async listWebsites() {
      assertCan(ctx.role, "workspace.view");
      return must(await client.from("workspace_websites").select("*").eq("workspace_id", ws).order("domain")) as Website[];
    },

    async getWebsite(id: string) {
      assertCan(ctx.role, "workspace.view");
      const site = must(await client.from("workspace_websites").select("*").eq("workspace_id", ws).eq("id", id).maybeSingle()) as Website | null;
      if (!site) throw new NotFound("Website");
      return site;
    },

    // Imports a Search Console property. Ownership counts as verified only when Google reports siteOwner.
    async addWebsiteFromSearchConsole(gscSiteId: string, brandId: string | null = null) {
      assertCan(ctx.role, "website.manage");
      if (brandId) await repo.getBrand(brandId);
      const gsc = must(await client.from("sites").select("id, site_url, permission_level").eq("id", gscSiteId).maybeSingle()) as
        | { id: string; site_url: string; permission_level: string | null }
        | null;
      if (!gsc) throw new NotFound("Search Console property");
      const site = normalizeWebsite(gsc.site_url);
      if (!site) throw new Error("That Search Console property isn't a website address.");
      const owner = gsc.permission_level === "siteOwner";
      const now = new Date().toISOString();
      const { data, error } = await client
        .from("workspace_websites")
        .insert({
          workspace_id: ws,
          brand_id: brandId,
          gsc_site_id: gsc.id,
          url: site.url,
          domain: site.domain,
          verification_status: owner ? "verified" : "unverified",
          verification_method: owner ? "search_console" : null,
          verified_at: owner ? now : null,
          last_checked_at: now,
        })
        .select("*")
        .single();
      explain(error, `${site.domain} is already in this workspace.`);
      const website = data as Website;
      await audit("website.added", "website", website.id, { domain: site.domain, source: "search_console", verified: owner });
      return website;
    },

    async addWebsiteManually(url: { url: string; domain: string }, brandId: string | null = null) {
      assertCan(ctx.role, "website.manage");
      if (brandId) await repo.getBrand(brandId);
      const { data, error } = await client
        .from("workspace_websites")
        .insert({ workspace_id: ws, brand_id: brandId, url: url.url, domain: url.domain })
        .select("*")
        .single();
      explain(error, `${url.domain} is already in this workspace.`);
      const website = data as Website;
      await audit("website.added", "website", website.id, { domain: url.domain, source: "manual", verified: false });
      return website;
    },

    async assignWebsite(websiteId: string, brandId: string | null) {
      assertCan(ctx.role, "website.manage");
      await repo.getWebsite(websiteId);
      if (brandId) await repo.getBrand(brandId);
      must(await client.from("workspace_websites").update({ brand_id: brandId }).eq("workspace_id", ws).eq("id", websiteId));
      await audit("website.assigned", "website", websiteId, { brand_id: brandId });
    },

    async removeWebsite(websiteId: string) {
      assertCan(ctx.role, "website.manage");
      const site = await repo.getWebsite(websiteId);
      must(await client.from("workspace_websites").delete().eq("workspace_id", ws).eq("id", websiteId));
      await audit("website.removed", "website", websiteId, { domain: site.domain });
    },

    // ---- Social accounts (created by OAuth in a later phase; read-only here)
    async listAccounts(brandId?: string) {
      assertCan(ctx.role, "workspace.view");
      let q = client
        .from("social_accounts")
        .select("id, brand_id, platform, display_name, avatar_url, status, token_expires_at, last_error, connected_at")
        .eq("workspace_id", ws)
        .order("platform");
      if (brandId) q = q.eq("brand_id", brandId);
      return must(await q) as SocialAccount[];
    },

    // ---- Posts
    async listPosts(opts: { brandId?: string; status?: string } = {}) {
      assertCan(ctx.role, "workspace.view");
      let q = client.from("posts").select("id, brand_id, title, body, status, origin, created_by, created_at, updated_at").eq("workspace_id", ws).order("updated_at", { ascending: false }).limit(200);
      if (opts.brandId) q = q.eq("brand_id", opts.brandId);
      if (opts.status) q = q.eq("status", opts.status);
      return must(await q) as Post[];
    },

    async createDraftPost(input: PostDraftInput) {
      assertCan(ctx.role, "post.edit");
      await repo.getBrand(input.brand_id);
      const post = must(
        await client
          .from("posts")
          .insert({ workspace_id: ws, brand_id: input.brand_id, title: input.title, body: input.body, status: "draft", origin: "manual", created_by: ctx.email })
          .select("id, brand_id, title, body, status, origin, created_by, created_at, updated_at")
          .single(),
      ) as Post;
      await audit("post.created", "post", post.id, { title: post.title });
      return post;
    },

    async deleteDraftPost(id: string) {
      assertCan(ctx.role, "post.edit");
      const post = must(await client.from("posts").select("id, status, title").eq("workspace_id", ws).eq("id", id).maybeSingle()) as { id: string; status: string; title: string } | null;
      if (!post) throw new NotFound("Post");
      if (post.status !== "draft") throw new Error("Only drafts can be deleted.");
      must(await client.from("posts").delete().eq("workspace_id", ws).eq("id", id));
      await audit("post.deleted", "post", id, { title: post.title });
    },

    // ---- Publishing (read-only until publishing is built)
    async listScheduledJobs(from: Date, to: Date) {
      assertCan(ctx.role, "workspace.view");
      return must(
        await client
          .from("scheduled_jobs")
          .select("id, run_at, status, attempts, last_error, post_variants(platform, body, posts(title, brand_id))")
          .eq("workspace_id", ws)
          .gte("run_at", from.toISOString())
          .lt("run_at", to.toISOString())
          .order("run_at"),
      ) as unknown as ScheduledJob[];
    },

    async listAttempts(limit = 100) {
      assertCan(ctx.role, "workspace.view");
      return must(
        await client
          .from("publish_attempts")
          .select("id, attempt_no, started_at, finished_at, outcome, http_status, error_code, error_message, scheduled_jobs(post_variants(platform, posts(title)))")
          .eq("workspace_id", ws)
          .order("started_at", { ascending: false })
          .limit(limit),
      ) as unknown as PublishAttempt[];
    },

    async listAudit(limit = 20) {
      assertCan(ctx.role, "workspace.view");
      return must(await client.from("audit_events").select("*").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(limit)) as AuditEvent[];
    },

    async overview() {
      assertCan(ctx.role, "workspace.view");
      const [brands, websites, verified, accounts, drafts, scheduled, failed] = await Promise.all([
        count("brands", (q) => q.eq("status", "active")),
        count("workspace_websites"),
        count("workspace_websites", (q) => q.eq("verification_status", "verified")),
        count("social_accounts", (q) => q.eq("status", "connected")),
        count("posts", (q) => q.in("status", ["draft", "in_review"])),
        count("scheduled_jobs", (q) => q.eq("status", "pending")),
        count("publish_attempts", (q) => q.eq("outcome", "error")),
      ]);
      return { brands, websites, verified, accounts, drafts, scheduled, failed };
    },
  };
  return repo;
}

export type SocialRepo = ReturnType<typeof socialRepo>;
