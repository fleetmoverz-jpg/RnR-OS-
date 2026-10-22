// Website analysis and the brand profile review built from it, scoped to one workspace like repo.ts.
// A scan only adds evidence (brand_facts) and fills profile fields that are empty and unconfirmed;
// anything the user confirmed or typed is never changed by a rescan.
import type { SupabaseClient } from "@supabase/supabase-js";
import { crawlSite, type CrawlOptions } from "./crawler";
import {
  extractCandidates,
  factKey,
  fieldStatus,
  LIST_KINDS,
  parsePage,
  PROFILE_FIELDS,
  type Candidate,
  type FactKind,
  type FieldStatus,
  type Origin,
  type ProfileField,
} from "./extract";
import type { SuggestFn } from "./brandAi";
import { assertCan, NotFound } from "./policy";
import { socialRepo, type SocialContext } from "./repo";
import type { PageFetcher } from "./safeFetch";
import type { BrandProfileInput } from "./validation";

export type AnalysisDeps = {
  fetcher: PageFetcher;
  // Null when no AI provider is configured; the scan still runs and says so.
  suggest: SuggestFn | null;
  aiUnavailable?: string;
  now?: () => Date;
  crawl?: CrawlOptions;
};

export type BrandFact = {
  id: string;
  brand_id: string;
  website_id: string | null;
  scan_id: string | null;
  kind: FactKind;
  value: string;
  label: string | null;
  source_url: string | null;
  source_quote: string | null;
  origin: Origin;
  confidence: number | null;
  status: "extracted" | "verified" | "confirmed" | "rejected";
  last_seen_at: string | null;
  created_at: string;
};

export type FullProfile = {
  brand_id: string;
  business_name: string | null;
  website_url: string | null;
  canonical_domain: string | null;
  industry: string | null;
  niche: string | null;
  city: string | null;
  region: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  hours: string | null;
  description: string | null;
  value_proposition: string | null;
  tone: string | null;
  logo_url: string | null;
  services: string[];
  service_areas: string[];
  source_website_id: string | null;
  confirmed_fields: string[];
  status: "draft" | "approved";
  approved_at: string | null;
  approved_by: string | null;
  updated_at: string;
};

export type ScanReport = {
  robots?: string;
  pages?: { url: string; title?: string | null; reason?: string }[];
  fields?: Record<string, FieldStatus>;
  lists?: Record<string, number>;
  ai?: string;
  brand_created?: boolean;
};

export type WebsiteScan = {
  id: string;
  website_id: string;
  brand_id: string | null;
  status: "running" | "succeeded" | "partial" | "failed";
  requested_by: string;
  started_at: string;
  finished_at: string | null;
  pages_fetched: number;
  pages_skipped: number;
  error: string | null;
  report: ScanReport;
};

export type ReviewField = {
  field: ProfileField;
  kind: FactKind;
  label: string;
  single: boolean;
  value: string | string[] | null;
  confirmed: boolean;
  status: FieldStatus | "confirmed";
  needsConfirmation: boolean;
  candidates: BrandFact[];
};

const LIMITS: Partial<Record<ProfileField, number>> = {
  business_name: 120, phone: 40, address: 300, tone: 200, description: 2000, value_proposition: 500, hours: 500, industry: 120, niche: 120, city: 120, region: 120,
};

// A value only goes into a profile field if the database would accept it.
export function fitsField(field: ProfileField, value: string) {
  if (value.length > (LIMITS[field] ?? 500)) return false;
  if (field === "email") return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
  if (field === "logo_url") return /^https:\/\/\S+$/.test(value);
  if (field === "website_url") return /^https?:\/\/\S+$/.test(value);
  if (field === "canonical_domain") return value === value.toLowerCase();
  return true;
}

const STALE_SCAN_MS = 10 * 60_000;

function check<T>({ data, error }: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as T;
}

const isEmpty = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

export function analysisService(client: SupabaseClient, ctx: SocialContext, deps: AnalysisDeps) {
  const ws = ctx.workspaceId;
  const now = () => deps.now?.() ?? new Date();
  const repo = socialRepo(client, ctx);

  async function audit(action: string, entityType: string, entityId: string | null, details: Record<string, unknown> = {}) {
    check(await client.from("audit_events").insert({ workspace_id: ws, actor_email: ctx.email, action, entity_type: entityType, entity_id: entityId, details }));
  }

  async function brandFacts(brandId: string) {
    return check(await client.from("brand_facts").select("*").eq("workspace_id", ws).eq("brand_id", brandId).order("created_at")) as BrandFact[];
  }

  async function profileRow(brandId: string) {
    return check(await client.from("brand_profiles").select("*").eq("workspace_id", ws).eq("brand_id", brandId).maybeSingle()) as FullProfile | null;
  }

  async function fact(factId: string) {
    const f = check(await client.from("brand_facts").select("*").eq("workspace_id", ws).eq("id", factId).maybeSingle()) as BrandFact | null;
    if (!f) throw new NotFound("Fact");
    return f;
  }

  // Starts a scan row; one running scan per website. A scan stuck for 10 minutes is marked failed.
  async function startScan(websiteId: string, brandId: string | null): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data, error } = await client
        .from("website_scans")
        .insert({ workspace_id: ws, website_id: websiteId, brand_id: brandId, requested_by: ctx.email, started_at: now().toISOString() })
        .select("id")
        .single();
      if (!error) return (data as { id: string }).id;
      if (error.code !== "23505") throw new Error(error.message);
      const cutoff = new Date(now().getTime() - STALE_SCAN_MS).toISOString();
      const { data: stale } = await client
        .from("website_scans")
        .update({ status: "failed", finished_at: now().toISOString(), error: "Stopped: the scan did not finish within 10 minutes." })
        .eq("workspace_id", ws)
        .eq("website_id", websiteId)
        .eq("status", "running")
        .lt("started_at", cutoff)
        .select("id");
      if (!stale?.length) break;
    }
    throw new Error("A scan of this website is already running. Try again in a minute.");
  }

  async function saveFacts(brandId: string, websiteId: string, scanId: string, candidates: Candidate[]) {
    const stamp = now().toISOString();
    const existing = await brandFacts(brandId);
    const byKey = new Map(existing.map((f) => [`${f.kind}|${factKey(f.kind, f.value)}`, f]));
    // Old AI suggestions the user never acted on are replaced by the new ones.
    const staleAi = existing.filter((f) => f.origin === "ai_suggestion" && f.status === "extracted").map((f) => f.id);
    if (candidates.some((c) => c.origin === "ai_suggestion") && staleAi.length) {
      check(await client.from("brand_facts").delete().eq("workspace_id", ws).in("id", staleAi));
      for (const f of existing) if (staleAi.includes(f.id)) byKey.delete(`${f.kind}|${factKey(f.kind, f.value)}`);
    }
    const inserts: Record<string, unknown>[] = [];
    for (const c of candidates) {
      const prev = byKey.get(`${c.kind}|${factKey(c.kind, c.value)}`);
      if (prev) {
        // Seen again. A fact the user confirmed or rejected keeps its decision and wording.
        const update: Record<string, unknown> = { last_seen_at: stamp, scan_id: scanId, website_id: websiteId };
        if (prev.status === "extracted" && prev.origin !== "user") Object.assign(update, { source_url: c.source_url, source_quote: c.source_quote, confidence: c.confidence, label: c.label ?? prev.label, origin: c.origin });
        check(await client.from("brand_facts").update(update).eq("workspace_id", ws).eq("id", prev.id));
        continue;
      }
      inserts.push({
        workspace_id: ws, brand_id: brandId, website_id: websiteId, scan_id: scanId, kind: c.kind, value: c.value, label: c.label ?? null,
        source_url: c.source_url, source_quote: c.source_quote?.slice(0, 500) ?? null, origin: c.origin, confidence: c.confidence, status: "extracted", last_seen_at: stamp,
      });
    }
    if (inserts.length) check(await client.from("brand_facts").insert(inserts));
  }

  // Fills empty, unconfirmed profile fields from website facts. Never touches confirmed or non-empty fields,
  // and never fills a field whose website values conflict or that only has an AI suggestion.
  async function fillProfile(brandId: string, websiteId: string) {
    const [profile, facts] = await Promise.all([profileRow(brandId), brandFacts(brandId)]);
    const confirmed = new Set(profile?.confirmed_fields ?? []);
    const live = facts.filter((f) => f.status !== "rejected");
    const update: Record<string, unknown> = {};
    for (const f of PROFILE_FIELDS) {
      if (confirmed.has(f.field) || !isEmpty(profile?.[f.field as keyof FullProfile])) continue;
      const site = live.filter((x) => x.kind === f.kind && x.origin !== "ai_suggestion" && (x.confidence ?? 1) >= (f.single ? 0.6 : 0.55));
      if (!site.length) continue;
      if (f.single) {
        if (fieldStatus(f.kind, true, live) === "conflict") continue;
        const best = [...site].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
        const value = f.field === "canonical_domain" ? best.value.toLowerCase() : best.value;
        if (fitsField(f.field, value)) update[f.field] = value;
      } else {
        update[f.field] = [...new Set(site.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)).map((x) => x.value.slice(0, 120)))].slice(0, 15);
      }
    }
    if (!profile) {
      check(await client.from("brand_profiles").insert({ brand_id: brandId, workspace_id: ws, source_website_id: websiteId, ...update }));
    } else {
      update.source_website_id = profile.source_website_id ?? websiteId;
      check(await client.from("brand_profiles").update(update).eq("workspace_id", ws).eq("brand_id", brandId));
    }
    return Object.keys(update).filter((k) => k !== "source_website_id");
  }

  const service = {
    // Crawls the website, stores what it found with sources, and fills the brand's draft profile.
    // A website without a brand gets one, named from what the website says.
    async scanWebsite(websiteId: string): Promise<WebsiteScan> {
      assertCan(ctx.role, "website.manage");
      const site = await repo.getWebsite(websiteId);
      const scanId = await startScan(site.id, site.brand_id);
      const report: ScanReport = {};
      try {
        const crawl = await crawlSite(site.url, deps.fetcher, deps.crawl);
        report.robots = crawl.robots;
        report.pages = [...crawl.pages.map((p) => ({ url: p.url, title: p.title })), ...crawl.skipped.map((s) => ({ url: s.url, reason: s.reason }))];
        if (!crawl.homepage) {
          const reason = crawl.skipped[0]?.reason ?? "The homepage could not be fetched.";
          throw new Error(`Couldn't read ${site.url}: ${reason}`);
        }
        const parsed = crawl.pages.map((p) => parsePage(p.url, p.html));
        const candidates = extractCandidates(parsed, crawl.homepage.url, crawl.sitemapPages);

        let aiOk = true;
        if (deps.suggest) {
          try {
            candidates.push(...(await deps.suggest({ domain: crawl.host, pages: parsed.map((p) => ({ url: p.url, title: p.title, text: p.text })) })));
            report.ai = "used";
          } catch (e) {
            aiOk = false;
            report.ai = `skipped: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
          }
        } else {
          report.ai = `skipped: ${deps.aiUnavailable ?? "no AI provider configured"}`;
        }

        let brandId = site.brand_id;
        if (!brandId) {
          const name = candidates.filter((c) => c.kind === "name").sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]?.value ?? site.domain;
          const brand = await repo.createBrand({ name: name.slice(0, 80), niche: null, timezone: "UTC" });
          await repo.assignWebsite(site.id, brand.id);
          brandId = brand.id;
          report.brand_created = true;
          check(await client.from("website_scans").update({ brand_id: brandId }).eq("workspace_id", ws).eq("id", scanId));
        }

        await saveFacts(brandId, site.id, scanId, candidates);
        await fillProfile(brandId, site.id);

        report.fields = Object.fromEntries(PROFILE_FIELDS.map((f) => [f.field, fieldStatus(f.kind, f.single, candidates)]));
        report.lists = Object.fromEntries(LIST_KINDS.map((l) => [l.kind, candidates.filter((c) => c.kind === l.kind).length]));
        // Missing pages (4xx), non-HTML files and off-site redirects are normal; errors and timeouts are not.
        const problems = crawl.skipped.filter((s) => !/robots|time budget|^HTTP 4\d\d|not an HTML|another site/.test(s.reason)).length;
        const status = problems || !aiOk || crawl.stoppedEarly ? "partial" : "succeeded";
        const done = check(
          await client
            .from("website_scans")
            .update({ status, finished_at: now().toISOString(), pages_fetched: crawl.pages.length, pages_skipped: crawl.skipped.length, report })
            .eq("workspace_id", ws)
            .eq("id", scanId)
            .select("*")
            .single(),
        ) as WebsiteScan;
        await audit("website.scanned", "website", site.id, { scan_id: scanId, status, pages: crawl.pages.length, brand_id: brandId });
        return done;
      } catch (e) {
        const message = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
        await client.from("website_scans").update({ status: "failed", finished_at: now().toISOString(), error: message, report }).eq("workspace_id", ws).eq("id", scanId);
        throw new Error(message);
      }
    },

    async latestScans(): Promise<Map<string, WebsiteScan>> {
      assertCan(ctx.role, "workspace.view");
      const rows = check(await client.from("website_scans").select("*").eq("workspace_id", ws).order("started_at", { ascending: false }).limit(200)) as WebsiteScan[];
      const latest = new Map<string, WebsiteScan>();
      for (const r of rows) if (!latest.has(r.website_id)) latest.set(r.website_id, r);
      return latest;
    },

    // Everything the review screen needs: each field with its value, candidates and whether it needs the user.
    async review(brandId: string) {
      assertCan(ctx.role, "workspace.view");
      const brand = await repo.getBrand(brandId);
      const [profile, facts, scans] = await Promise.all([
        profileRow(brandId),
        brandFacts(brandId),
        client.from("website_scans").select("*").eq("workspace_id", ws).eq("brand_id", brandId).order("started_at", { ascending: false }).limit(1),
      ]);
      const latestScan = ((check(scans) as WebsiteScan[])[0] ?? null) as WebsiteScan | null;
      const confirmed = new Set(profile?.confirmed_fields ?? []);
      const rank = (f: BrandFact) => (f.status === "confirmed" ? 3 : 0) + (f.origin === "ai_suggestion" ? 0 : 1) + (f.confidence ?? 0);
      const fields: ReviewField[] = PROFILE_FIELDS.map((f) => {
        const candidates = facts.filter((x) => x.kind === f.kind && x.status !== "rejected").sort((a, b) => rank(b) - rank(a));
        const value = (profile?.[f.field as keyof FullProfile] ?? (f.single ? null : [])) as string | string[] | null;
        const isConfirmed = confirmed.has(f.field) && !isEmpty(value);
        const status: ReviewField["status"] = isConfirmed ? "confirmed" : fieldStatus(f.kind, f.single, candidates);
        return { field: f.field, kind: f.kind, label: f.label, single: f.single, value, confirmed: isConfirmed, status, needsConfirmation: !isConfirmed, candidates };
      });
      const lists = LIST_KINDS.map((l) => ({ ...l, facts: facts.filter((x) => x.kind === l.kind && x.status !== "rejected") }));
      const conflicts = fields.filter((f) => f.status === "conflict").map((f) => f.label);
      const missing = fields.filter((f) => !f.confirmed && isEmpty(f.value) && (f.status === "missing" || f.status === "suggested")).map((f) => f.label);
      return { brand, profile, fields, lists, latestScan, conflicts, missing };
    },

    // The user accepts one candidate. Single fields take its value; list fields gain it.
    async confirmFact(factId: string) {
      assertCan(ctx.role, "brand.edit");
      const f = await fact(factId);
      const spec = PROFILE_FIELDS.find((p) => p.kind === f.kind);
      if (spec?.single && !fitsField(spec.field, f.value)) throw new Error(`That value can't be used as ${spec.label.toLowerCase()}. Edit the field instead.`);
      check(await client.from("brand_facts").update({ status: "confirmed" }).eq("workspace_id", ws).eq("id", f.id));
      if (spec) {
        const profile = await profileRow(f.brand_id);
        const confirmedFields = [...new Set([...(profile?.confirmed_fields ?? []), spec.field])];
        const value = spec.single ? (spec.field === "canonical_domain" ? f.value.toLowerCase() : f.value) : [...new Set([...((profile?.[spec.field as keyof FullProfile] as string[] | undefined) ?? []), f.value.slice(0, 120)])];
        if (profile) check(await client.from("brand_profiles").update({ [spec.field]: value, confirmed_fields: confirmedFields }).eq("workspace_id", ws).eq("brand_id", f.brand_id));
        else check(await client.from("brand_profiles").insert({ brand_id: f.brand_id, workspace_id: ws, [spec.field]: value, confirmed_fields: confirmedFields }));
      }
      await audit("brand_fact.confirmed", "brand", f.brand_id, { fact_id: f.id, kind: f.kind, origin: f.origin });
    },

    // The user says a candidate is wrong. If it was only auto-filled, it's removed from the profile.
    async rejectFact(factId: string) {
      assertCan(ctx.role, "brand.edit");
      const f = await fact(factId);
      check(await client.from("brand_facts").update({ status: "rejected" }).eq("workspace_id", ws).eq("id", f.id));
      const spec = PROFILE_FIELDS.find((p) => p.kind === f.kind);
      const profile = spec ? await profileRow(f.brand_id) : null;
      if (spec && profile && !profile.confirmed_fields.includes(spec.field)) {
        const current = profile[spec.field as keyof FullProfile];
        const key = factKey(f.kind, f.value);
        const next = spec.single ? (typeof current === "string" && factKey(f.kind, current) === key ? null : current) : ((current as string[]) ?? []).filter((v) => factKey(f.kind, v) !== key);
        if (next !== current) check(await client.from("brand_profiles").update({ [spec.field]: next }).eq("workspace_id", ws).eq("brand_id", f.brand_id));
      }
      await audit("brand_fact.rejected", "brand", f.brand_id, { fact_id: f.id, kind: f.kind, origin: f.origin });
    },

    // Saving the review form confirms every filled field; cleared fields are no longer confirmed.
    async saveProfile(brandId: string, input: BrandProfileInput) {
      assertCan(ctx.role, "brand.edit");
      await repo.getBrand(brandId);
      const confirmedFields = PROFILE_FIELDS.map((f) => f.field).filter((f) => !isEmpty(input[f]));
      const row = { brand_id: brandId, workspace_id: ws, ...input, confirmed_fields: confirmedFields };
      check(await client.from("brand_profiles").upsert(row, { onConflict: "brand_id" }));
      await audit("brand_profile.updated", "brand", brandId, { confirmed_fields: confirmedFields });
    },

    // Approval needs a business name and no unresolved conflicts. Missing optional fields are allowed.
    async approveProfile(brandId: string) {
      assertCan(ctx.role, "profile.approve");
      const r = await service.review(brandId);
      if (!r.profile?.business_name) throw new Error("Add the business name before approving.");
      if (r.conflicts.length) throw new Error(`Resolve the conflicting values first: ${r.conflicts.join(", ")}.`);
      const confirmedFields = PROFILE_FIELDS.map((f) => f.field).filter((f) => !isEmpty(r.profile![f as keyof FullProfile]));
      check(
        await client
          .from("brand_profiles")
          .update({ status: "approved", approved_at: now().toISOString(), approved_by: ctx.email, confirmed_fields: confirmedFields })
          .eq("workspace_id", ws)
          .eq("brand_id", brandId),
      );
      if (!r.brand.niche && r.profile.niche) check(await client.from("brands").update({ niche: r.profile.niche }).eq("workspace_id", ws).eq("id", brandId));
      await audit("brand_profile.approved", "brand", brandId, { confirmed_fields: confirmedFields, missing: r.missing });
    },

    async reopenProfile(brandId: string) {
      assertCan(ctx.role, "profile.approve");
      await repo.getBrand(brandId);
      check(await client.from("brand_profiles").update({ status: "draft", approved_at: null, approved_by: null }).eq("workspace_id", ws).eq("brand_id", brandId));
      await audit("brand_profile.reopened", "brand", brandId);
    },
  };
  return service;
}

export type AnalysisService = ReturnType<typeof analysisService>;
