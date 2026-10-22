import Link from "next/link";
import { Activity, Building2, CheckCircle2, Circle, Link2, ListChecks } from "lucide-react";
import { requireWorkspace } from "@/lib/social/workspace";
import { isEncryptionKeyValid } from "@/lib/social/crypto";
import { env } from "@/lib/env";
import { Badge, ButtonLink, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { Stat } from "@/components/social";
import { timeAgo } from "@/components/format";

export const metadata = { title: "Social Overview" };

export default async function SocialOverviewPage() {
  const { repo } = await requireWorkspace();
  const [workspace, counts, events] = await Promise.all([repo.getWorkspace(), repo.overview(), repo.listAudit(12)]);

  const steps = [
    { done: counts.brands > 0, label: "Create a brand", href: "/social/brands" },
    { done: counts.websites > 0, label: "Import a website from Search Console", href: "/social/websites" },
    { done: counts.verified > 0, label: "Have at least one verified website", href: "/social/websites" },
    { done: isEncryptionKeyValid(env.tokenEncryptionKey()), label: "Set TOKEN_ENCRYPTION_KEY in Vercel", href: "/social/settings" },
    { done: counts.accounts > 0, label: "Connect a social account", href: "/social/accounts", later: true },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={workspace.name}
        title="Social Automation"
        description="Brands, websites and social accounts for this workspace. Publishing arrives in a later phase; nothing is posted yet."
        actions={<ButtonLink href="/social/brands" variant="primary"><Building2 className="size-4" /> Manage brands</ButtonLink>}
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Brands" value={counts.brands} />
        <Stat label="Websites" value={counts.websites} hint={`${counts.verified} verified`} />
        <Stat label="Connected accounts" value={counts.accounts} />
        <Stat label="Drafts" value={counts.drafts} />
        <Stat label="Scheduled" value={counts.scheduled} />
        <Stat label="Failed attempts" value={counts.failed} />
      </div>

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader icon={ListChecks} title="Setup" description="What this workspace needs before posts can go out." />
          <ul className="divide-y divide-line">
            {steps.map((s) => (
              <li key={s.label} className="flex items-center gap-3 px-5 py-3 text-[13px]">
                {s.done ? <CheckCircle2 className="size-4 shrink-0 text-success" /> : <Circle className="size-4 shrink-0 text-ink-3" />}
                <Link href={s.href} className={s.done ? "text-ink-2 line-through decoration-ink-3/40" : "font-medium hover:text-brand"}>
                  {s.label}
                </Link>
                {s.later && !s.done && <Badge className="ml-auto">Next phase</Badge>}
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader icon={Activity} title="Recent activity" description="Changes made in this workspace." />
          {events.length === 0 ? (
            <EmptyState icon={Link2} title="No activity yet">Creating a brand or adding a website shows up here.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {events.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-4 px-5 py-3 text-[13px]">
                  <div className="min-w-0">
                    <p className="font-medium">{describe(e.action, e.details)}</p>
                    <p className="truncate text-xs text-ink-3">{e.actor_email}</p>
                  </div>
                  <span className="shrink-0 text-xs text-ink-3">{timeAgo(e.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function describe(action: string, details: Record<string, unknown>) {
  const name = (details.name ?? details.domain ?? details.title) as string | undefined;
  const [entity, verb] = action.split(".");
  const label = entity.replace(/_/g, " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} ${verb.replace(/_/g, " ")}${name ? `: ${name}` : ""}`;
}
