import { CalendarClock, Database, Search, Sparkles } from "lucide-react";
import { getConnectionStatus } from "@/lib/status";
import { env } from "@/lib/env";
import { Badge, ButtonLink, Card, PageHeader } from "@/components/ui";
import { timeAgo } from "@/components/format";

export const metadata = { title: "Integrations" };

export default async function IntegrationsPage() {
  const s = await getConnectionStatus();
  const items = [
    {
      icon: Search,
      name: "Google Search Console",
      body: "Read-only access to search performance and URL Inspection for your properties.",
      status: s.google === "connected" ? (s.failingSites ? <Badge tone="warning">Sync issue</Badge> : <Badge tone="success">Connected</Badge>) : <Badge tone="danger">Not connected</Badge>,
      meta: s.google === "connected" ? `Token refreshed ${timeAgo(s.googleUpdatedAt)} · last sync ${timeAgo(s.lastSyncAt)}` : "Sign in with Google to connect.",
      action: <ButtonLink href="/api/auth/google">{s.google === "connected" ? "Reconnect" : "Connect"}</ButtonLink>,
    },
    {
      icon: Sparkles,
      name: "Claude (Anthropic)",
      body: "Writes the plain-English SEO recommendations for each website.",
      status: s.claude ? <Badge tone="success">Configured</Badge> : <Badge tone="warning">Missing API key</Badge>,
      meta: s.claude ? `Model ${env.anthropicModel()}` : "Add ANTHROPIC_API_KEY in Vercel to enable.",
    },
    {
      icon: Database,
      name: "Supabase",
      body: "Stores your synced search data, inspections and reports.",
      status: <Badge tone="success">Connected</Badge>,
      meta: new URL(env.supabaseUrl()).host,
    },
    {
      icon: CalendarClock,
      name: "Daily sync (Vercel Cron)",
      body: "Pulls fresh Search Console data for every active website.",
      status: <Badge tone="brand">Daily · 06:00 UTC</Badge>,
      meta: `Last sync ${timeAgo(s.lastSyncAt)}`,
    },
  ];
  return (
    <div className="space-y-6">
      <PageHeader title="Integrations" description="Services RnR Os is connected to." />
      <div className="grid gap-4 md:grid-cols-2">
        {items.map((it) => (
          <Card key={it.name} className="flex flex-col p-5">
            <div className="flex items-start justify-between gap-3">
              <span className="flex size-10 items-center justify-center rounded-xl bg-brand-soft text-brand">
                <it.icon className="size-5" />
              </span>
              {it.status}
            </div>
            <h2 className="mt-4 font-semibold tracking-tight">{it.name}</h2>
            <p className="mt-1 text-[13px] text-ink-2">{it.body}</p>
            <div className="mt-auto flex items-center justify-between gap-3 pt-4">
              <p className="truncate text-xs text-ink-3">{it.meta}</p>
              {it.action}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
