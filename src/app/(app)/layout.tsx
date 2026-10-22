import Link from "next/link";
import { HelpCircle } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { displaySite, getSelection, RANGES } from "@/lib/selection";
import { getConnectionStatus } from "@/lib/status";
import { Sidebar } from "@/components/shell/Sidebar";
import { RangeSelector, SiteSelector, UserMenu } from "@/components/shell/TopBarControls";
import { timeAgo } from "@/components/format";
import { cn } from "@/components/ui";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const email = await requireUser();
  const [{ sites, site, days }, status] = await Promise.all([getSelection(), getConnectionStatus()]);

  const gscOk = status.google === "connected" && status.failingSites === 0;
  const gscLabel =
    status.google === "missing"
      ? "Search Console not connected"
      : status.failingSites > 0
        ? `Sync issue on ${status.failingSites} site${status.failingSites > 1 ? "s" : ""}`
        : `Search Console · synced ${timeAgo(status.lastSyncAt)}`;

  return (
    <div className="flex min-h-screen">
      <Sidebar siteLabel={site ? displaySite(site.site_url) : null} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
          <div className="flex h-16 items-center gap-2 pl-14 pr-4 lg:px-8">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <SiteSelector
                sites={sites.map((s) => ({ id: s.id, label: displaySite(s.site_url), enabled: s.enabled }))}
                currentId={site?.id ?? null}
              />
              <div className="hidden sm:block">
                <RangeSelector ranges={RANGES.map((r) => ({ ...r }))} current={days} />
              </div>
            </div>
            <Link
              href="/integrations"
              title={gscLabel}
              className="hidden items-center gap-2 rounded-full border border-line bg-card px-3 py-1.5 text-xs text-ink-2 shadow-card hover:text-ink md:flex"
            >
              <span className={cn("size-2 rounded-full", gscOk ? "bg-success" : status.google === "missing" ? "bg-danger" : "bg-warning")} />
              {gscLabel}
            </Link>
            <Link href="/help" className="flex size-9 items-center justify-center rounded-lg text-ink-2 hover:bg-subtle hover:text-ink" aria-label="Help">
              <HelpCircle className="size-[18px]" />
            </Link>
            <UserMenu email={email} />
          </div>
          <div className="flex px-4 pb-3 sm:hidden">
            <RangeSelector ranges={RANGES.map((r) => ({ ...r }))} current={days} />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
