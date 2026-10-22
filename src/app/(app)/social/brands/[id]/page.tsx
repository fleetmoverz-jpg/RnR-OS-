import Link from "next/link";
import { notFound } from "next/navigation";
import { Archive, ArchiveRestore, Building2, Globe, Link2, Store, Tag } from "lucide-react";
import { db } from "@/lib/db";
import { analyticsService } from "@/lib/social/analytics/service";
import { DEFAULT_TRACKING, withUtm } from "@/lib/social/analytics/utm";
import { requireWorkspace } from "@/lib/social/workspace";
import { can, NotFound } from "@/lib/social/policy";
import { platformLabel } from "@/lib/social/platforms";
import { Badge, ButtonLink, Card, CardHeader, EmptyState, PageHeader, Field, inputClass } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { ActionButton } from "@/components/ActionButton";
import { StatusBadge, VerificationBadge } from "@/components/social";
import { saveLinkTrackingAction, setBrandArchivedAction, updateBrandAction } from "../../actions";

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
  const [profile, websites, accounts, savedTracking] = await Promise.all([repo.getProfile(id), repo.listWebsites(), repo.listAccounts(id), analyticsService(db(), repo.ctx).linkTracking(id)]);
  const tracking = savedTracking ?? DEFAULT_TRACKING;
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
            <CardHeader
              icon={Store}
              title="Brand profile"
              description="Built from the website, confirmed by you. Only confirmed details are used in content."
              action={<ButtonLink href={`/social/brands/${brand.id}/profile`} variant={profile?.status === "approved" ? "secondary" : "primary"}>Review profile</ButtonLink>}
            />
            <div className="space-y-3 p-5 text-[13px]">
              <p className="flex flex-wrap items-center gap-2">
                {profile?.status === "approved" ? <Badge tone="success">Approved</Badge> : <Badge>Draft</Badge>}
                <span className="text-ink-3">{profile?.confirmed_fields?.length ?? 0} confirmed fields</span>
              </p>
              {profile ? (
                <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                  {[
                    ["Business name", profile.business_name],
                    ["Phone", profile.phone],
                    ["Email", profile.email],
                    ["Address", profile.address],
                    ["Services", profile.services.join(", ")],
                    ["Service areas", profile.service_areas.join(", ")],
                  ].map(([label, value]) => (
                    <div key={label} className="min-w-0">
                      <dt className="text-xs text-ink-3">{label}</dt>
                      <dd className="truncate">{value || <span className="text-ink-3">Not set</span>}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-ink-3">No profile yet. Analyse the brand&apos;s website or fill it in by hand.</p>
              )}
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
            <CardHeader icon={Tag} title="Link tracking" description="Adds UTM tags to the link of each post published from now on, so visits show up by platform in your website analytics." />
            <div className="p-5">
              <ActionForm action={saveLinkTrackingAction.bind(null, brand.id)} submitLabel="Save tracking" variant="secondary">
                <fieldset disabled={!editable} className="space-y-4">
                  <label className="flex items-center gap-2 text-[13px] font-medium">
                    <input type="checkbox" name="enabled" defaultChecked={tracking.enabled} className="size-4 accent-brand" /> Add UTM tags to post links
                  </label>
                  <Field label="utm_source" hint="{platform} becomes facebook_page, instagram, …"><input name="utm_source" required defaultValue={tracking.utm_source} className={inputClass} /></Field>
                  <Field label="utm_medium"><input name="utm_medium" required defaultValue={tracking.utm_medium} className={inputClass} /></Field>
                  <Field label="utm_campaign"><input name="utm_campaign" required defaultValue={tracking.utm_campaign} className={inputClass} /></Field>
                </fieldset>
              </ActionForm>
              <p className="mt-3 break-all text-xs text-ink-3">Example: {withUtm("https://example.com/page", { ...tracking, enabled: true }, "facebook_page")}</p>
            </div>
          </Card>

          <Card>
            <CardHeader icon={Globe} title="Websites" action={<ButtonLink href="/social/websites" variant="ghost">Manage</ButtonLink>} />
            {sites.length === 0 ? (
              <EmptyState icon={Globe} title="No websites">Import or assign one on the Websites page.</EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {sites.map((w) => (
                  <li key={w.id} className="flex items-center justify-between gap-3 px-5 py-3 text-[13px]">
                    <span className="truncate font-medium">{w.gsc_property_url ?? w.domain}</span>
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
