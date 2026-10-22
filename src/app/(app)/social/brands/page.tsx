import Link from "next/link";
import { Building2, ChevronRight, Globe, Plus } from "lucide-react";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/social/workspace";
import { can } from "@/lib/social/policy";
import { displaySite } from "@/lib/selection";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Field, inputClass } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { ActionButton } from "@/components/ActionButton";
import { VerificationBadge } from "@/components/social";
import { addWebsiteAction, assignWebsiteAction, createBrandAction, removeWebsiteAction } from "../actions";

export const metadata = { title: "Brands" };

export default async function BrandsPage() {
  const { repo } = await requireWorkspace();
  const [brands, websites, accounts, gscData] = await Promise.all([
    repo.listBrands({ includeArchived: true }),
    repo.listWebsites(),
    repo.listAccounts(),
    db().from("sites").select("id, site_url, permission_level").order("site_url"),
  ]);
  const role = repo.ctx.role;
  const brandName = new Map(brands.map((b) => [b.id, b.name]));
  const imported = new Set(websites.map((w) => w.gsc_site_id));
  const gscSites = ((gscData.data ?? []) as { id: string; site_url: string; permission_level: string | null }[]).filter((s) => !imported.has(s.id));
  const active = brands.filter((b) => b.status === "active");

  return (
    <div className="space-y-6">
      <PageHeader title="Brands" description="Each brand groups its websites, business details and social accounts." />

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader icon={Building2} title="Your brands" description={`${active.length} active`} />
          {brands.length === 0 ? (
            <EmptyState icon={Building2} title="No brands yet">Create your first brand to start adding websites and business details.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {brands.map((b) => {
                const sites = websites.filter((w) => w.brand_id === b.id);
                const accts = accounts.filter((a) => a.brand_id === b.id);
                return (
                  <li key={b.id}>
                    <Link href={`/social/brands/${b.id}`} className="flex items-center gap-4 px-5 py-4 hover:bg-subtle/60">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-sm font-semibold text-brand">
                        {b.name.charAt(0).toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-medium">{b.name}</span>
                          {b.status === "archived" && <Badge>Archived</Badge>}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-ink-3">
                          {[b.niche, `${sites.length} website${sites.length === 1 ? "" : "s"}`, `${accts.length} account${accts.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                      <ChevronRight className="size-4 text-ink-3" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader icon={Plus} title="New brand" />
          <div className="p-5">
            {can(role, "brand.create") ? (
              <ActionForm action={createBrandAction} submitLabel="Create brand" pendingLabel="Creating…">
                <Field label="Name">
                  <input name="name" required maxLength={80} className={inputClass} placeholder="Acme Plumbing" />
                </Field>
                <Field label="Niche" hint="Optional, for example emergency plumbing.">
                  <input name="niche" maxLength={120} className={inputClass} />
                </Field>
                <Field label="Time zone" hint="Used for scheduling posts later.">
                  <input name="timezone" defaultValue="UTC" className={inputClass} placeholder="Europe/London" />
                </Field>
              </ActionForm>
            ) : (
              <p className="text-[13px] text-ink-2">Only workspace admins can create brands.</p>
            )}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          icon={Globe}
          title="Websites"
          description="A website counts as verified when Google Search Console lists you as its owner."
        />
        {websites.length === 0 ? (
          <EmptyState icon={Globe} title="No websites in this workspace">Import one from Search Console or add it by address below.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {websites.map((w) => (
              <li key={w.id} className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{w.domain}</span>
                    <VerificationBadge status={w.verification_status} />
                    {w.verification_method === "search_console" && <Badge>Search Console</Badge>}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-3">{w.brand_id ? `Brand: ${brandName.get(w.brand_id) ?? "unknown"}` : "Not assigned to a brand"}</p>
                </div>
                {can(role, "website.manage") && (
                  <div className="flex flex-wrap items-start gap-2">
                    <ActionForm action={assignWebsiteAction.bind(null, w.id)} submitLabel="Assign" variant="secondary" className="flex items-start gap-2 space-y-0 [&>fieldset]:space-y-0">
                      <select name="brand_id" defaultValue={w.brand_id ?? ""} className={`${inputClass} h-9 w-48 py-0`} aria-label="Brand">
                        <option value="">No brand</option>
                        {active.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    </ActionForm>
                    <ActionButton action={removeWebsiteAction.bind(null, w.id)} label="Remove" pendingLabel="Removing…" variant="ghost" />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {can(role, "website.manage") && (
          <div className="grid grid-cols-1 gap-6 border-t border-line p-5 lg:grid-cols-2">
            <ActionForm action={addWebsiteAction} submitLabel="Import from Search Console" variant="secondary" resetOnSuccess>
              <Field label="Search Console property" hint={gscSites.length ? "Ownership is checked against Google's permission level." : "Every Search Console property is already imported, or none are synced yet."}>
                <select name="gsc_site_id" required className={inputClass} disabled={!gscSites.length}>
                  {gscSites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {displaySite(s.site_url)} {s.permission_level === "siteOwner" ? "(owner)" : `(${(s.permission_level ?? "unknown").replace("site", "").toLowerCase()})`}
                    </option>
                  ))}
                </select>
              </Field>
              <BrandSelect brands={active} />
            </ActionForm>
            <ActionForm action={addWebsiteAction} submitLabel="Add by address" variant="secondary" resetOnSuccess>
              <Field label="Website address" hint="Added as unverified.">
                <input name="url" required className={inputClass} placeholder="example.com" />
              </Field>
              <BrandSelect brands={active} />
            </ActionForm>
          </div>
        )}
      </Card>
    </div>
  );
}

function BrandSelect({ brands }: { brands: { id: string; name: string }[] }) {
  return (
    <Field label="Brand">
      <select name="brand_id" className={inputClass} defaultValue="">
        <option value="">No brand yet</option>
        {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
    </Field>
  );
}
