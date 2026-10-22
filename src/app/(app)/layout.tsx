import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { logoutAction } from "./actions";

// Each phase of RnR Os is a module in this nav. Phase 1 is live; the others are placeholders.
const MODULES = [
  { href: "/search-console", label: "Search Console", live: true },
  { href: "/social", label: "Social posting", live: false },
  { href: "/citations", label: "Citation builder", live: false },
];

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const email = await requireUser();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b border-line bg-surface md:w-56 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-4 py-4 md:block">
          <Link href="/search-console" className="text-lg font-semibold">RnR Os</Link>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:pb-0">
          {MODULES.map((m) => (
            <Link
              key={m.href}
              href={m.href}
              className="flex items-center justify-between gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm text-ink-2 hover:bg-bg hover:text-ink"
            >
              {m.label}
              {!m.live && <span className="rounded bg-bg px-1.5 py-0.5 text-[10px] text-muted">soon</span>}
            </Link>
          ))}
        </nav>
        <div className="hidden px-4 py-4 text-xs text-muted md:block">
          <p className="truncate">{email}</p>
          <form action={logoutAction}>
            <button className="mt-1 underline hover:text-ink">Sign out</button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}
