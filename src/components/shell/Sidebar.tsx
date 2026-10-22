"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BarChart3,
  Bot,
  Building2,
  CalendarDays,
  ChevronsLeft,
  ChevronsRight,
  FileText,
  Globe,
  History,
  LayoutDashboard,
  Link2,
  LifeBuoy,
  ListOrdered,
  PieChart,
  ScrollText,
  MapPin,
  Menu,
  PenSquare,
  Plug,
  Search,
  Settings,
  Settings2,
  Share2,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "../ui";

type Item = { href: string; label: string; icon: typeof Search; soon?: boolean; exact?: boolean };

// Only features that exist are linked as live; planned phases carry a "Soon" tag.
const GROUPS: { title: string; items: Item[] }[] = [
  {
    title: "Workspace",
    items: [
      { href: "/overview", label: "Overview", icon: LayoutDashboard },
      { href: "/analytics", label: "SEO Analytics", icon: BarChart3 },
      { href: "/queries", label: "Search Queries", icon: Search },
      { href: "/pages", label: "Page Performance", icon: FileText },
      { href: "/opportunities", label: "Opportunities", icon: Sparkles },
    ],
  },
  {
    title: "Social Automation",
    items: [
      { href: "/social", label: "Social Overview", icon: Share2, exact: true },
      { href: "/social/brands", label: "Brands", icon: Building2 },
      { href: "/social/websites", label: "Websites & Search Console", icon: Globe },
      { href: "/social/accounts", label: "Connected Accounts", icon: Link2 },
      { href: "/social/content", label: "Content Studio", icon: PenSquare },
      { href: "/social/queue", label: "Publishing Queue", icon: ListOrdered },
      { href: "/social/calendar", label: "Publishing Calendar", icon: CalendarDays },
      { href: "/social/automation", label: "Automation", icon: Bot },
      { href: "/social/history", label: "Publishing History", icon: History },
      { href: "/social/analytics", label: "Social Analytics", icon: PieChart },
      { href: "/social/audit", label: "Audit Log", icon: ScrollText },
      { href: "/social/settings", label: "Social Settings", icon: Settings2 },
    ],
  },
  {
    title: "Growth Tools",
    items: [{ href: "/citations", label: "Citation Builder", icon: MapPin, soon: true }],
  },
  {
    title: "Management",
    items: [
      { href: "/websites", label: "Websites", icon: Globe },
      { href: "/integrations", label: "Integrations", icon: Plug },
    ],
  },
  {
    title: "Account",
    items: [
      { href: "/settings", label: "Settings", icon: Settings },
      { href: "/help", label: "Help & Support", icon: LifeBuoy },
    ],
  },
];

const COLLAPSE_KEY = "rnr.sidebar.collapsed";

function Logo({ collapsed }: { collapsed: boolean }) {
  return (
    <Link href="/overview" className="flex items-center gap-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand to-ai text-[13px] font-bold text-white shadow-sm">
        R
      </span>
      {!collapsed && (
        <span className="leading-tight">
          <span className="block text-[15px] font-semibold tracking-tight">RnR Os</span>
          <span className="block text-[11px] text-ink-3">SEO Growth Platform</span>
        </span>
      )}
    </Link>
  );
}

function Nav({ collapsed, siteLabel, onNavigate }: { collapsed: boolean; siteLabel: string | null; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex-1 overflow-y-auto px-3 pb-4">
      {siteLabel && !collapsed && (
        <div className="mb-4 rounded-lg border border-line bg-subtle/60 px-3 py-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Current website</p>
          <p className="mt-0.5 truncate text-[13px] font-medium">{siteLabel}</p>
        </div>
      )}
      {GROUPS.map((g) => (
        <div key={g.title} className="mb-4">
          {!collapsed ? (
            <p className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">{g.title}</p>
          ) : (
            <div className="mx-2 mb-2 border-t border-line" />
          )}
          <ul className="space-y-0.5">
            {g.items.map((item) => {
              const active = pathname === item.href || (!item.exact && pathname.startsWith(`${item.href}/`));
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    title={collapsed ? item.label : undefined}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group relative flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors",
                      active ? "bg-brand-soft text-brand" : "text-ink-2 hover:bg-subtle hover:text-ink",
                      collapsed && "justify-center px-0",
                    )}
                  >
                    {active && <span className="absolute -left-3 h-5 w-[3px] rounded-r bg-brand" />}
                    <Icon className={cn("size-[18px] shrink-0", active ? "text-brand" : "text-ink-3 group-hover:text-ink-2")} />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                    {!collapsed && item.soon && (
                      <span className="ml-auto rounded bg-subtle px-1.5 py-0.5 text-[10px] font-medium text-ink-3 ring-1 ring-line">Soon</span>
                    )}
                    {collapsed && (
                      <span className="pointer-events-none absolute left-full z-50 ml-3 hidden whitespace-nowrap rounded-md bg-ink px-2 py-1 text-xs text-white shadow-pop group-hover:block">
                        {item.label}
                        {item.soon && " · Soon"}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function Sidebar({ siteLabel }: { siteLabel: string | null }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring a saved preference after hydration
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {}
  }, []);

  function toggle() {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {}
      return !c;
    });
  }

  return (
    <>
      {/* Mobile: a menu button in the top bar opens a drawer. */}
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed left-3 top-3.5 z-40 flex size-9 items-center justify-center rounded-lg border border-line bg-card text-ink-2 shadow-card lg:hidden"
        aria-label="Open navigation"
      >
        <Menu className="size-4" />
      </button>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-ink/30" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-card shadow-pop">
            <div className="flex h-16 items-center justify-between px-5">
              <Logo collapsed={false} />
              <button onClick={() => setMobileOpen(false)} className="text-ink-2" aria-label="Close navigation">
                <X className="size-5" />
              </button>
            </div>
            <Nav collapsed={false} siteLabel={siteLabel} onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <aside
        className={cn(
          "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-line bg-card transition-[width] duration-200 lg:flex",
          collapsed ? "w-[68px]" : "w-64",
        )}
      >
        <div className={cn("flex h-16 items-center", collapsed ? "justify-center" : "px-5")}>
          <Logo collapsed={collapsed} />
        </div>
        <Nav collapsed={collapsed} siteLabel={siteLabel} />
        <button
          onClick={toggle}
          className={cn(
            "m-3 flex h-9 items-center gap-2 rounded-lg px-2.5 text-[13px] text-ink-3 hover:bg-subtle hover:text-ink-2",
            collapsed && "justify-center",
          )}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
          {!collapsed && "Collapse"}
        </button>
      </aside>
    </>
  );
}

