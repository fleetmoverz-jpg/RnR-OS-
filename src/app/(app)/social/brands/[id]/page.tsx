import Link from "next/link";
import { notFound } from "next/navigation";
import { Archive, ArchiveRestore, Building2, Globe, Link2, Store } from "lucide-react";
import { requireWorkspace } from "@/lib/social/workspace";
import { can, NotFound } from "@/lib/social/policy";
import { platformLabel } from "@/lib/social/platforms";
import { Badge, ButtonLink, Card, CardHeader, EmptyState, PageHeader, Field, inputClass } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { ActionButton } from "@/components/ActionButton";
import { StatusBadge, VerificationBadge } from "@/components/social";
import { saveProfileAction, setBrandArchivedAction, updateBrandAction } from "../../actions";

export const metadata = { title: "Brand" };

export default async function BrandPage({ params }: PageProps<"/social/brands/[id]">) {
  const { id } = await params;
  const { repo } = await requireWorkspace();
  // An unknown id and another workspace's brand look the same: not found.
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const brand = await repo.getBrand(id).catch((e) => {
    if (e instanceof NotFound) notFound();
    throw e;
  });
  const [profile, websites, accounts] = await Promise.all([repo.getProfile(id), repo.listWebsites(), repo.listAccounts(id)]);
  const sites = websites.filter((w) => w.brand_id === id);
  const editable = can(repo.ctx.role, "brand.edit");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<Link href="/social/brands" className="hover:text-ink">Brands</Link>}
        title={brand.name}
        description={<span className="flex flex-wrap items-center gap-2">{brand.niche ?? "No niche set"} {brand.status === "archived" && <Badge>Archived</Badge>}</span>}
        actions={
          can(repo.ctx.role, "brand.archive") && (
            <ActionButton
              action={setBrandArchivedAction.bind(null, brand.id, brand.status !== "archived")}
              label={brand.status === "archived" ? "Restore brand" : "Archive brand"}
              pendingLabel="Saving…"
              icon={brand.status === "archived" ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
            />
          )
        }
      />

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card>
            <CardHeader icon={Store} title="Business details" description="Only details you enter or confirm here will be used in posts." />
            <div className="p-5">
              <ActionForm action={saveProfileAction.bind(null, brand.id)} submitLabel="Save details">
                <fieldset disabled={!editable} className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field label="Business name"><input name="business_name" defaultValue={profile?.business_name ?? ""} maxLength={120} className={inputClass} /></Field>
                  <Field label="Phone"><input name="phone" defaultValue={profile?.phone ?? ""} maxLength={40} className={inputClass} /></Field>
                  <Field label="Email"><input name="email" type="email" defaultValue={profile?.email ?? ""} className={inputClass} /></Field>
                  <Field label="Address"><input name="address" defaultValue={profile?.address ?? ""} maxLength={300} className={inputClass} /></Field>
                  <Field label="Services" hint="One per line or comma-separated.">
                    <textarea name="services" rows={4} defaultValue={profile?.services.join("\n") ?? ""} className={inputClass} />
                  </Field>
                  <Field label="Service areas" hint="Towns or regions, one per line.">
                    <textarea name="service_areas" rows={4} defaultValue={profile?.service_areas.join("\n") ?? ""} className={inputClass} />
                  </Field>
                  <Field label="Tone of voice" hint="For example: friendly, local, no jargon.">
                    <input name="tone" defaultValue={profile?.tone ?? ""} maxLength={200} className={inputClass} />
                  </Field>
                  <Field label="Short description">
                    <textarea name="description" rows={3} defaultValue={profile?.description ?? ""} maxLength={2000} className={inputClass} />
                  </Field>
                </fieldset>
              </ActionForm>
              <p className="mt-4 text-xs text-ink-3">
                Automatic extraction from the website comes in a later phase. Extracted facts will be shown with their source page for you to confirm.
              </p>
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader icon={Building2} title="Brand settings" />
            <div className="p-5">
              <ActionForm action={updateBrandAction.bind(null, brand.id)} submitLabel="Save brand" variant="secondary">
                <fieldset disabled={!editable} className="space-y-4">
                  <Field label="Name"><input name="name" required defaultValue={brand.name} maxLength={80} className={inputClass} /></Field>
                  <Field label="Niche"><input name="niche" defaultValue={brand.niche ?? ""} maxLength={120} className={inputClass} /></Field>
                  <Field label="Time zone"><input name="timezone" defaultValue={brand.timezone} className={inputClass} /></Field>
                </fieldset>
              </ActionForm>
            </div>
          </Card>

          <Card>
            <CardHeader icon={Globe} title="Websites" action={<ButtonLink href="/social/brands" variant="ghost">Manage</ButtonLink>} />
            {sites.length === 0 ? (
              <EmptyState icon={Globe} title="No websites">Assign one on the Brands page.</EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {sites.map((w) => (
                  <li key={w.id} className="flex items-center justify-between gap-3 px-5 py-3 text-[13px]">
                    <span className="truncate font-medium">{w.domain}</span>
                    <VerificationBadge status={w.verification_status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader icon={Link2} title="Social accounts" />
            {accounts.length === 0 ? (
              <EmptyState icon={Link2} title="No accounts connected">Connecting accounts arrives in the next phase.</EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {accounts.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 px-5 py-3 text-[13px]">
                    <span className="min-w-0 truncate"><span className="font-medium">{a.display_name}</span> <span className="text-ink-3">· {platformLabel(a.platform)}</span></span>
                    <StatusBadge status={a.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
