import Link from "next/link";
import { KeyRound, Link2, PlugZap, RefreshCw, ShieldOff, Stethoscope, Unplug } from "lucide-react";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/social/workspace";
import { can } from "@/lib/social/policy";
import { missingEnv, PLATFORM_INFO, PLATFORMS, platformLabel } from "@/lib/social/platforms";
import { connectionService } from "@/lib/social/publish/connections";
import { connectionDeps, metaSetupProblems } from "@/lib/social/publish/server";
import { Badge, ButtonLink, Card, CardHeader, EmptyState, Field, inputClass, PageHeader } from "@/components/ui";
import { ActionButton } from "@/components/ActionButton";
import { ActionForm } from "@/components/ActionForm";
import { StatusBadge } from "@/components/social";
import { timeAgo } from "@/components/format";
import { addMetaAccountAction, checkAccountAction, disconnectAccountAction, discoverMetaAction, revokeMetaAction } from "../actions";

export const metadata = { title: "Connected Accounts" };

const ACTION_LABEL: Record<string, string> = { publish_text: "Text posts", publish_link: "Link posts", publish_image: "Image posts", read_metrics: "Read metrics" };
const META_ERRORS: Record<string, string> = {
  forbidden: "Only admins can connect accounts.",
  not_configured: "Facebook and Instagram aren't set up yet. Add META_APP_ID and META_APP_SECRET in Vercel.",
  state: "The sign-in expired or didn't match. Please try again.",
  session: "You were signed out during the sign-in. Please try again.",
  denied: "Facebook sign-in was cancelled.",
  meta: "Facebook returned an error. Please try again.",
  exchange: "Facebook didn't accept the sign-in.",
};
const PLANNED = new Set(["x", "linkedin_page", "linkedin_profile", "google_business", "pinterest", "threads"]);

export default async function AccountsPage({ searchParams }: PageProps<"/social/accounts">) {
  const sp = await searchParams;
  const { repo } = await requireWorkspace();
  const role = repo.ctx.role;
  const manage = can(role, "account.connect");
  const metaProblems = metaSetupProblems();
  const service = connectionService(db(), repo.ctx, metaProblems.length ? { provider: null as never, adapters: {}, encryptionKey: "" } : connectionDeps());
  const [accounts, brands, connections, assets] = await Promise.all([service.listAccounts(), repo.listBrands({ includeArchived: true }), service.listConnections(), service.listAssets()]);
  const brandName = new Map(brands.map((b) => [b.id, b.name]));
  const activeBrands = brands.filter((b) => b.status === "active");
  const metaError = typeof sp.meta_error === "string" ? META_ERRORS[sp.meta_error] ?? "Connecting failed." : null;
  const detail = typeof sp.detail === "string" ? sp.detail : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connected Accounts"
        description="Social accounts linked to your brands through each platform's official sign-in. Tokens are encrypted and never shown."
        actions={manage && !metaProblems.length && <ButtonLink href="/api/social/meta/connect" variant="primary">Connect Facebook</ButtonLink>}
      />

      {metaError && <div className="rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-[13px] text-danger-ink">{metaError}{detail ? ` ${detail}` : ""}</div>}
      {sp.meta === "connected" && (
        <div className="rounded-xl border border-success/30 bg-success-soft px-4 py-3 text-[13px] text-success-ink">
          Facebook connected{typeof sp.found === "string" ? `: found ${sp.found} Pages and Instagram accounts. Add the ones you want to a brand below.` : "."}
          {detail ? ` Listing them failed: ${detail}` : ""}
        </div>
      )}

      <Card>
        <CardHeader icon={Link2} title="Accounts" description={`${accounts.filter((a) => a.status === "connected").length} connected`} />
        {accounts.length === 0 ? (
          <EmptyState icon={Link2} title="No accounts connected">
            Accounts appear here after you sign in with the platform and add a Page or profile to a brand.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {accounts.map((a) => (
              <li key={a.id} className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{a.display_name}</span>
                    {a.username && <span className="text-xs text-ink-3">@{a.username}</span>}
                    <StatusBadge status={a.status} />
                  </p>
                  <p className="text-xs text-ink-3">
                    {platformLabel(a.platform)} · {brandName.get(a.brand_id) ?? "Unknown brand"} · connected {timeAgo(a.connected_at)}
                    {a.last_checked_at && ` · checked ${timeAgo(a.last_checked_at)}`}
                  </p>
                  <p className="mt-1 flex flex-wrap gap-1">
                    {a.permitted_actions.length ? a.permitted_actions.map((p) => <Badge key={p}>{ACTION_LABEL[p] ?? p}</Badge>) : a.status !== "revoked" && <span className="text-xs text-warning-ink">No publishing permission granted</span>}
                  </p>
                  {a.rate_limited_until && new Date(a.rate_limited_until) > new Date() && <p className="mt-1 text-xs text-warning-ink">Rate limited until {a.rate_limited_until.slice(0, 16).replace("T", " ")} UTC</p>}
                  {a.last_error && a.status !== "connected" && <p className="mt-1 text-xs text-danger-ink">{a.last_error}</p>}
                </div>
                {a.status !== "revoked" && (
                  <div className="flex flex-wrap gap-1">
                    {!metaProblems.length && <ActionButton action={checkAccountAction.bind(null, a.id)} label="Check" pendingLabel="Checking…" variant="ghost" icon={<Stethoscope className="size-4" />} />}
                    {manage && <ActionButton action={disconnectAccountAction.bind(null, a.id)} label="Disconnect" pendingLabel="Disconnecting…" variant="ghost" icon={<Unplug className="size-4" />} />}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader icon={PlugZap} title="Facebook & Instagram" description="One Facebook sign-in lists the Pages you manage and the Instagram professional accounts linked to them." />
        {metaProblems.length > 0 ? (
          <div className="space-y-1 p-5 text-[13px] text-ink-2">
            {metaProblems.map((p) => <p key={p}>{p}</p>)}
            <p className="text-xs text-ink-3">Setup steps are in docs/meta-setup.md in the repository.</p>
          </div>
        ) : connections.length === 0 ? (
          <EmptyState icon={PlugZap} title="Not connected" action={manage ? <ButtonLink href="/api/social/meta/connect" variant="primary">Connect Facebook &amp; Instagram</ButtonLink> : undefined}>
            You&apos;ll be asked to choose Pages and approve posting permissions. RnR Os never sees your password.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {connections.map((c) => {
              const mine = assets.filter((x) => x.connection_id === c.id);
              return (
                <li key={c.id} className="space-y-3 px-5 py-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2"><span className="font-medium">{c.meta_user_name ?? "Facebook user"}</span><StatusBadge status={c.status === "active" ? "connected" : c.status} /></p>
                      <p className="text-xs text-ink-3">
                        Connected by {c.connected_by} {timeAgo(c.connected_at)}
                        {c.token_expires_at && ` · login expires ${c.token_expires_at.slice(0, 10)}`}
                      </p>
                      {c.declined_scopes.length > 0 && <p className="mt-1 text-xs text-warning-ink">Not granted: {c.declined_scopes.join(", ")}. Reconnect to grant them.</p>}
                      {c.last_error && <p className="mt-1 text-xs text-danger-ink">{c.last_error}</p>}
                    </div>
                    {manage && (
                      <div className="flex flex-wrap gap-1">
                        <ActionButton action={discoverMetaAction.bind(null, c.id)} label="Refresh list" pendingLabel="Refreshing…" variant="ghost" icon={<RefreshCw className="size-4" />} />
                        <ButtonLink href="/api/social/meta/connect" variant="ghost">Reconnect</ButtonLink>
                        <ActionButton action={revokeMetaAction.bind(null, c.id)} label="Disconnect & revoke" pendingLabel="Revoking…" variant="ghost" icon={<ShieldOff className="size-4" />} />
                      </div>
                    )}
                  </div>
                  {mine.length === 0 ? (
                    <p className="text-xs text-ink-3">No Pages found. Make sure you chose them in the Facebook dialog and have a role on them.</p>
                  ) : (
                    <ul className="divide-y divide-line rounded-lg border border-line">
                      {mine.map((x) => (
                        <li key={x.id} className="flex flex-col gap-2 px-3 py-2.5 text-[13px] md:flex-row md:items-center md:justify-between">
                          <div className="min-w-0">
                            <p className="font-medium">{x.name}{x.username && <span className="ml-1 text-xs font-normal text-ink-3">@{x.username}</span>}</p>
                            <p className="text-xs text-ink-3">{platformLabel(x.platform)}{x.platform === "instagram" ? " · via its linked Page" : ""}</p>
                          </div>
                          {x.account_id && x.account_status !== "revoked" ? (
                            <span className="text-xs text-ink-2">Added to {brandName.get(x.account_brand_id!) ?? "a brand"}</span>
                          ) : manage && activeBrands.length ? (
                            <ActionForm action={addMetaAccountAction.bind(null, x.id)} submitLabel="Add" variant="secondary" className="flex items-end gap-2 space-y-0">
                              <Field label="Brand">
                                <select name="brand_id" required className={`${inputClass} h-9 w-48 py-0`} defaultValue="">
                                  <option value="" disabled>Choose a brand</option>
                                  {activeBrands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                                </select>
                              </Field>
                            </ActionForm>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader icon={KeyRound} title="Platforms" description="What each platform needs before it can be connected." />
        <ul className="grid grid-cols-1 divide-y divide-line md:grid-cols-2 md:divide-y-0">
          {PLATFORMS.map((p) => {
            const missing = missingEnv(p);
            const planned = PLANNED.has(p);
            return (
              <li key={p} className="flex items-start justify-between gap-3 border-line px-5 py-4 md:border-b md:odd:border-r">
                <div className="min-w-0">
                  <p className="font-medium">{PLATFORM_INFO[p].label}</p>
                  <p className="text-xs text-ink-3">{PLATFORM_INFO[p].note}</p>
                  {!planned && missing.length > 0 && <p className="mt-1 text-xs text-ink-3">Needs {missing.join(", ")}</p>}
                </div>
                {planned ? <Badge>Later</Badge> : missing.length > 0 ? <Badge tone="warning">Not configured</Badge> : <Badge tone="success">Ready</Badge>}
              </li>
            );
          })}
        </ul>
        <p className="border-t border-line px-5 py-3 text-xs text-ink-3">
          Medium is not supported: it no longer issues API access for new integrations. <Link href="/social/history" className="text-brand hover:underline">Publishing history</Link>
        </p>
      </Card>
    </div>
  );
}
