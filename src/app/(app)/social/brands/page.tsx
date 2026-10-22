import Link from "next/link";
import { Building2, ChevronRight, Globe, Plus } from "lucide-react";
import { requireWorkspace } from "@/lib/social/workspace";
import { can } from "@/lib/social/policy";
import { Badge, ButtonLink, Card, CardHeader, EmptyState, PageHeader, Field, inputClass } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { createBrandAction } from "../actions";

export const metadata = { title: "Brands" };

export default async function BrandsPage() {
  const { repo } = await requireWorkspace();
  const [brands, websites, accounts] = await Promise.all([repo.listBrands({ includeArchived: true }), repo.listWebsites(), repo.listAccounts()]);
  const role = repo.ctx.role;
  const active = brands.filter((b) => b.status === "active");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Brands"
        description="Each brand groups its websites, business details and social accounts."
        actions={<ButtonLink href="/social/websites"><Globe className="size-4" /> Websites</ButtonLink>}
      />

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

    </div>
  );
}
