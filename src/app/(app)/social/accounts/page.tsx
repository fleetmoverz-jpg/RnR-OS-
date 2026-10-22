import { KeyRound, Link2 } from "lucide-react";
import { requireWorkspace } from "@/lib/social/workspace";
import { missingEnv, PLATFORM_INFO, PLATFORMS, platformLabel } from "@/lib/social/platforms";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { StatusBadge } from "@/components/social";
import { timeAgo } from "@/components/format";

export const metadata = { title: "Connected Accounts" };

export default async function AccountsPage() {
  const { repo } = await requireWorkspace();
  const [accounts, brands] = await Promise.all([repo.listAccounts(), repo.listBrands({ includeArchived: true })]);
  const brandName = new Map(brands.map((b) => [b.id, b.name]));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connected Accounts"
        description="Social accounts linked to your brands through each platform's official sign-in. Connecting accounts arrives in the next phase."
      />

      <Card>
        <CardHeader icon={Link2} title="Accounts" description={`${accounts.length} connected`} />
        {accounts.length === 0 ? (
          <EmptyState icon={Link2} title="No accounts connected">
            Accounts appear here only after you sign in to a platform and approve access. None are connected yet.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {accounts.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="font-medium">{a.display_name}</p>
                  <p className="text-xs text-ink-3">{platformLabel(a.platform)} · {brandName.get(a.brand_id) ?? "Unknown brand"} · connected {timeAgo(a.connected_at)}</p>
                  {a.last_error && <p className="mt-1 text-xs text-danger-ink">{a.last_error}</p>}
                </div>
                <StatusBadge status={a.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader icon={KeyRound} title="Platforms" description="Each platform needs its own developer app credentials in Vercel before it can be connected." />
        <ul className="grid grid-cols-1 divide-y divide-line md:grid-cols-2 md:divide-y-0">
          {PLATFORMS.map((p) => {
            const missing = missingEnv(p);
            return (
              <li key={p} className="flex items-start justify-between gap-3 border-line px-5 py-4 md:border-b md:odd:border-r">
                <div className="min-w-0">
                  <p className="font-medium">{PLATFORM_INFO[p].label}</p>
                  <p className="text-xs text-ink-3">{PLATFORM_INFO[p].note}</p>
                  {missing.length > 0 && <p className="mt-1 text-xs text-ink-3">Needs {missing.join(", ")}</p>}
                </div>
                {missing.length > 0 ? <Badge>Not configured</Badge> : <Badge tone="brand">Keys set · connecting comes next phase</Badge>}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
