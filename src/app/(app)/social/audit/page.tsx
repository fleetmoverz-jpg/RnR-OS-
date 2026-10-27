import Link from "next/link";
import { ScrollText } from "lucide-react";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/social/workspace";
import { analyticsService } from "@/lib/social/analytics/service";
import { buttonClass, Card, CardHeader, cn, EmptyState, inputClass, PageHeader } from "@/components/ui";
import { fmtDateTime } from "@/components/social";

export const metadata = { title: "Audit Log" };

const AREAS: [string, string][] = [
  ["", "Everything"],
  ["post.", "Posts and publishing"],
  ["queue.", "Queue"],
  ["automation.", "Automation"],
  ["brand", "Brands"],
  ["social_account.", "Accounts"],
  ["meta_connection.", "Facebook logins"],
  ["ai_limits.", "AI limits"],
  ["workspace.", "Workspace"],
];
const PAGE = 100;

// Details are what the action recorded: ids, settings and outcomes. Tokens are never written to the log.
const detail = (d: Record<string, unknown>) =>
  Object.entries(d)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");

export default async function AuditPage({ searchParams }: PageProps<"/social/audit">) {
  const sp = await searchParams;
  const area = typeof sp.area === "string" && AREAS.some(([v]) => v === sp.area) ? sp.area : "";
  const actor = typeof sp.actor === "string" && sp.actor.length <= 200 ? sp.actor.trim().toLowerCase() : "";
  const before = typeof sp.before === "string" && /^\d+$/.test(sp.before) ? Number(sp.before) : null;
  const { repo } = await requireWorkspace();
  const events = await analyticsService(db(), repo.ctx).audit({ action: area || null, actor: actor || null, before, limit: PAGE });
  const next = events.length === PAGE ? events[events.length - 1].id : null;
  const qs = (extra: Record<string, string>) => new URLSearchParams({ ...(area ? { area } : {}), ...(actor ? { actor } : {}), ...extra }).toString();

  return (
    <div className="space-y-6">
      <PageHeader title="Audit Log" description="Who did what in this workspace, newest first. Automation acts as automation@rnr-os." />
      <Card>
        <form method="get" className="flex flex-wrap items-end gap-3 p-4 text-[13px]">
          <label className="space-y-1">
            <span className="block text-xs text-ink-3">Area</span>
            <select name="area" defaultValue={area} className={cn(inputClass, "h-9 w-52 py-0")}>
              {AREAS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-ink-3">Person</span>
            <input name="actor" type="email" defaultValue={actor} placeholder="name@example.com" className={cn(inputClass, "h-9 w-60 py-0")} />
          </label>
          <button type="submit" className={buttonClass("secondary")}>Apply</button>
          {(area || actor) && <Link href="/social/audit" className="self-center text-xs font-medium text-brand hover:underline">Reset</Link>}
        </form>
      </Card>
      <Card>
        <CardHeader icon={ScrollText} title="Events" description={before ? "Older events" : `Latest ${PAGE}`} />
        {events.length === 0 ? (
          <EmptyState icon={ScrollText} title="No events">Nothing matches these filters.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {events.map((e) => (
              <li key={e.id} className="grid gap-1 px-5 py-3 text-[13px] sm:grid-cols-[11rem_1fr]">
                <span className="tabular-nums text-ink-3">{fmtDateTime(e.created_at, "UTC")}</span>
                <div className="min-w-0">
                  <p><span className="font-medium">{e.action}</span> <span className="text-ink-3">by {e.actor_email}</span></p>
                  {Object.keys(e.details ?? {}).length > 0 && <p className="break-words text-xs text-ink-2">{detail(e.details)}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {(next || before) && (
          <div className="flex gap-3 border-t border-line px-5 py-3 text-xs">
            {before && <Link href={`/social/audit?${qs({})}`} className="font-medium text-brand hover:underline">Newest</Link>}
            {next && <Link href={`/social/audit?${qs({ before: String(next) })}`} className="font-medium text-brand hover:underline">Older</Link>}
          </div>
        )}
      </Card>
    </div>
  );
}
