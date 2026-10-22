import { CheckCircle2, Globe, KeyRound, RefreshCw, ScanSearch, Search, TriangleAlert, Unplug } from "lucide-react";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/social/workspace";
import { can } from "@/lib/social/policy";
import { googleService } from "@/lib/social/googleConnections";
import { analysisService, type WebsiteScan } from "@/lib/social/analysis";
import { analysisDeps } from "@/lib/social/analysisServer";
import { googleDeps, googleSetupProblems } from "@/lib/social/googleServer";
import { PERMISSION_INFO } from "@/lib/social/google";
import { Badge, buttonClass, Card, CardHeader, cn, EmptyState, Field, inputClass, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { ActionButton } from "@/components/ActionButton";
import { StatusBadge, VerificationBadge } from "@/components/social";
import { timeAgo } from "@/components/format";
import { addWebsiteAction, assignWebsiteAction, disconnectGoogleAction, discoverPropertiesAction, importPropertiesAction, removeWebsiteAction, scanWebsiteAction } from "../actions";

export const metadata = { title: "Websites" };
// Website analysis runs inside the request (and after it, for new imports).
export const maxDuration = 60;

const ERRORS: Record<string, string> = {
  denied: "You cancelled on Google's consent screen, so nothing was connected.",
  scope: "Search Console access wasn't granted. Connect again and leave \"View Search Console data\" ticked.",
  state: "The sign-in link expired or didn't match. Start the connection again.",
  session: "Your RnR Os session changed during sign-in. Start the connection again.",
  forbidden: "Only workspace admins and owners can connect Google accounts.",
  not_configured: "Google connections aren't set up on the server yet. See the notice below.",
  exchange: "Google didn't complete the sign-in.",
  google: "Google returned an error during sign-in.",
};

const TypeBadge = ({ type }: { type: string | null }) =>
  type === "domain" ? <Badge tone="accent">Domain property</Badge> : type === "url_prefix" ? <Badge>URL prefix</Badge> : null;

export default async function WebsitesPage({ searchParams }: PageProps<"/social/websites">) {
  const sp = await searchParams;
  const { repo } = await requireWorkspace();
  const problems = googleSetupProblems();
  const google = problems.length ? null : googleService(db(), repo.ctx, googleDeps());
  const [scans, brands, websites, connections, properties] = await Promise.all([
    analysisService(db(), repo.ctx, analysisDeps()).latestScans(),
    repo.listBrands(),
    repo.listWebsites(),
    google ? google.listConnections() : Promise.resolve([]),
    google ? google.listProperties() : Promise.resolve([]),
  ]);
  const role = repo.ctx.role;
  const brandName = new Map(brands.map((b) => [b.id, b.name]));
  const accountEmail = new Map(connections.map((c) => [c.id, c.google_email]));
  const detail = typeof sp.detail === "string" ? sp.detail : null;
  const error = typeof sp.google_error === "string" ? sp.google_error : null;

  return (
    <div className="space-y-6">
      <PageHeader title="Websites" description="Connect Google to find your Search Console properties, then import the ones this workspace manages." />

      {sp.google === "connected" && (
        <Notice tone={detail ? "warning" : "success"}>
          Google account connected.{" "}
          {detail ? `Finding properties didn't finish: ${detail}` : `Found ${Number(sp.found ?? 0)} Search Console ${Number(sp.found) === 1 ? "property" : "properties"}.`}
        </Notice>
      )}
      {error && (
        <Notice tone="danger">
          {ERRORS[error] ?? ERRORS.google} {detail}
        </Notice>
      )}

      <Card>
        <CardHeader
          icon={KeyRound}
          title="Google accounts"
          description="Read-only Search Console access. Tokens are encrypted and never sent to your browser."
          action={
            can(role, "account.connect") && !problems.length ? (
              // A plain link: the browser must go to Google's own sign-in page.
              <a href="/api/social/google/connect" className={buttonClass("primary")}>
                Connect Google account
              </a>
            ) : undefined
          }
        />
        {problems.length > 0 ? (
          <div className="flex gap-3 px-5 py-4 text-[13px]">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <div>
              <p className="font-medium">Google connections need server setup</p>
              <ul className="mt-1 list-disc pl-4 text-ink-2">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          </div>
        ) : connections.length === 0 ? (
          <EmptyState icon={KeyRound} title="No Google account connected">
            Connect the Google account that has access to your sites in Search Console. You&apos;ll be asked to allow read-only access.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {connections.map((c) => (
              <li key={c.id} className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-start">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{c.google_email}</span>
                    <StatusBadge status={c.status === "active" ? "connected" : "needs_reconnect"} />
                  </p>
                  <p className="mt-0.5 text-xs text-ink-3">
                    Connected {timeAgo(c.connected_at)} by {c.connected_by} · properties checked {timeAgo(c.last_discovered_at)}
                  </p>
                  {c.last_error && <p className="mt-1 text-xs text-danger-ink">{c.last_error}</p>}
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  {c.status === "needs_reconnect" && can(role, "account.connect") && (
                    <a href="/api/social/google/connect" className={buttonClass("primary")}>Reconnect</a>
                  )}
                  {c.status === "active" && can(role, "website.manage") && (
                    <ActionButton action={discoverPropertiesAction.bind(null, c.id)} label="Refresh properties" pendingLabel="Checking…" icon={<RefreshCw className="size-4" />} />
                  )}
                  {can(role, "account.connect") && (
                    <ActionButton action={disconnectGoogleAction.bind(null, c.id)} label="Disconnect" pendingLabel="Disconnecting…" variant="ghost" icon={<Unplug className="size-4" />} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {connections.length > 0 && (
        <Card>
          <CardHeader icon={Search} title="Search Console properties" description="Exactly as Google lists them. Only properties where Google reports you as an owner are marked verified." />
          {properties.length === 0 ? (
            <EmptyState icon={Search} title="No properties found">
              The connected Google account has no Search Console properties. Add your site in Search Console, then refresh.
            </EmptyState>
          ) : (
            <ActionForm action={importPropertiesAction} submitLabel="Import selected" pendingLabel="Importing…" resetOnSuccess className="p-5">
              <div className="-mx-5 -mt-5 overflow-x-auto">
                <table className="w-full text-left text-[13px] sm:min-w-[640px]">
                  <thead className="border-b border-line text-xs text-ink-3">
                    <tr>
                      <th className="w-10 px-5 py-2.5"><span className="sr-only">Select</span></th>
                      <th className="px-2 py-2.5 font-medium">Property</th>
                      <th className="hidden px-5 py-2.5 font-medium sm:table-cell">Type</th>
                      <th className="hidden px-5 py-2.5 font-medium sm:table-cell">Your permission</th>
                      <th className="hidden px-5 py-2.5 font-medium sm:table-cell">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {properties.map((p) => {
                      const info = PERMISSION_INFO[p.permission_level];
                      const permission = info.verifiedOwner ? <Badge tone="success"><CheckCircle2 className="size-3" /> {info.label}</Badge> : <Badge>{info.label}</Badge>;
                      return (
                        <tr key={p.id} className={cn(p.imported_website_id && "text-ink-3")}>
                          <td className="px-5 py-3">
                            <input
                              type="checkbox"
                              name="property_id"
                              value={p.id}
                              disabled={Boolean(p.imported_website_id) || !can(role, "website.manage")}
                              aria-label={`Select ${p.site_url}`}
                              className="size-4 accent-brand"
                            />
                          </td>
                          <td className="px-2 py-3">
                            <p className="break-all font-medium">{p.site_url}</p>
                            {connections.length > 1 && <p className="text-xs text-ink-3">via {accountEmail.get(p.connection_id)}</p>}
                            <div className="mt-1.5 flex flex-wrap gap-1.5 sm:hidden">
                              <TypeBadge type={p.property_type} />
                              {permission}
                              {p.imported_website_id && <Badge tone="brand">Imported</Badge>}
                            </div>
                          </td>
                          <td className="hidden px-5 py-3 sm:table-cell"><TypeBadge type={p.property_type} /></td>
                          <td className="hidden px-5 py-3 sm:table-cell" title={info.description}>{permission}</td>
                          <td className="hidden px-5 py-3 sm:table-cell">{p.imported_website_id ? <Badge tone="brand">Imported</Badge> : <span className="text-xs text-ink-3">Not imported</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {can(role, "website.manage") && (
                <Field label="Add to brand" hint="Optional. You can assign brands later.">
                  <select name="brand_id" className={`${inputClass} max-w-xs`} defaultValue="">
                    <option value="">No brand yet</option>
                    {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </Field>
              )}
            </ActionForm>
          )}
        </Card>
      )}

      <Card>
        <CardHeader icon={Globe} title="Workspace websites" description={`${websites.length} in this workspace`} />
        {websites.length === 0 ? (
          <EmptyState icon={Globe} title="No websites yet">Import properties above, or add a website by address below.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {websites.map((w) => (
              <li key={w.id} className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="break-all font-medium">{w.gsc_property_url ?? w.domain}</span>
                    <TypeBadge type={w.property_type} />
                    <VerificationBadge status={w.verification_status} />
                  </p>
                  <p className="mt-0.5 text-xs text-ink-3">
                    {[
                      w.brand_id ? `Brand: ${brandName.get(w.brand_id) ?? "archived"}` : "No brand",
                      w.permission_level ? `Search Console: ${PERMISSION_INFO[w.permission_level].label}` : w.gsc_property_url ? "No longer listed in Search Console" : "Added by address",
                      w.last_checked_at && `checked ${timeAgo(w.last_checked_at)}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <ScanLine scan={scans.get(w.id)} brandId={w.brand_id} />
                </div>
                {can(role, "website.manage") && (
                  <div className="flex flex-wrap items-start gap-2">
                    <ActionButton
                      action={scanWebsiteAction.bind(null, w.id)}
                      label={scans.has(w.id) ? "Rescan" : "Analyse website"}
                      pendingLabel="Analysing…"
                      icon={<ScanSearch className="size-4" />}
                    />
                    <ActionForm action={assignWebsiteAction.bind(null, w.id)} submitLabel="Assign" variant="secondary" className="flex items-start gap-2 space-y-0 [&>fieldset]:space-y-0">
                      <select name="brand_id" defaultValue={w.brand_id ?? ""} className={`${inputClass} h-9 w-48 py-0`} aria-label="Brand">
                        <option value="">No brand</option>
                        {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
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
          <div className="border-t border-line p-5">
            <ActionForm action={addWebsiteAction} submitLabel="Add by address" variant="secondary" resetOnSuccess className="max-w-xl">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Website address" hint="Added as unverified.">
                  <input name="url" required className={inputClass} placeholder="example.com" />
                </Field>
                <Field label="Brand">
                  <select name="brand_id" className={inputClass} defaultValue="">
                    <option value="">No brand yet</option>
                    {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </Field>
              </div>
            </ActionForm>
          </div>
        )}
      </Card>
    </div>
  );
}

function ScanLine({ scan, brandId }: { scan: WebsiteScan | undefined; brandId: string | null }) {
  if (!scan) return <p className="mt-1 text-xs text-ink-3">Not analysed yet.</p>;
  const review = brandId && scan.status !== "running" && scan.status !== "failed" && (
    <Link href={`/social/brands/${brandId}/profile`} className="font-medium text-brand hover:underline">Review brand profile</Link>
  );
  if (scan.status === "running") return <p className="mt-1 text-xs text-ink-3">Analysing the website… started {timeAgo(scan.started_at)}. Refresh to see the result.</p>;
  if (scan.status === "failed") return <p className="mt-1 text-xs text-danger-ink">Last analysis failed {timeAgo(scan.started_at)}: {scan.error}</p>;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-ink-3">
      <span>
        Analysed {timeAgo(scan.finished_at ?? scan.started_at)}: {scan.pages_fetched} {scan.pages_fetched === 1 ? "page" : "pages"} read
        {scan.status === "partial" ? ", some pages skipped" : ""}.
      </span>
      {review}
    </p>
  );
}

function Notice({ tone, children }: { tone: "success" | "warning" | "danger"; children: React.ReactNode }) {
  const styles = { success: "border-success/30 bg-success-soft text-success-ink", warning: "border-warning/30 bg-warning-soft text-warning-ink", danger: "border-danger/30 bg-danger-soft text-danger-ink" };
  return (
    <div role="status" className={cn("flex items-start gap-2 rounded-xl border px-4 py-3 text-[13px]", styles[tone])}>
      {tone === "success" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
      <p>{children}</p>
    </div>
  );
}
