"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { CalendarRange, Check, ChevronDown, Globe, HelpCircle, LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { setRangeAction, setSiteAction, logoutAction } from "@/app/(app)/actions";
import { cn } from "../ui";

function useOutside(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);
  return ref;
}

function Dropdown({
  trigger,
  children,
  align = "left",
  width = "w-72",
}: {
  trigger: (open: boolean) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "left" | "right";
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(() => setOpen(false));
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="block max-w-full">
        {trigger(open)}
      </button>
      {open && (
        <div className={cn("absolute top-full z-40 mt-1.5 rounded-xl border border-line bg-card p-1.5 shadow-pop", width, align === "right" ? "right-0" : "left-0")}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

const pill = "flex h-9 items-center gap-2 rounded-lg border border-line bg-card px-3 text-[13px] font-medium shadow-card hover:bg-subtle";

export function SiteSelector({ sites, currentId }: { sites: { id: string; label: string; enabled: boolean }[]; currentId: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const current = sites.find((s) => s.id === currentId);
  return (
    <Dropdown
      trigger={(open) => (
        <span className={cn(pill, "max-w-[16rem]", pending && "opacity-60")}>
          <Globe className="size-4 shrink-0 text-ink-3" />
          <span className="truncate">{current?.label ?? "No website"}</span>
          <ChevronDown className={cn("size-4 shrink-0 text-ink-3 transition-transform", open && "rotate-180")} />
        </span>
      )}
    >
      {(close) => (
        <div>
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">Websites</p>
          <div className="max-h-72 overflow-y-auto">
            {sites.map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  close();
                  start(async () => {
                    await setSiteAction(s.id);
                    router.refresh();
                  });
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-subtle"
              >
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                {!s.enabled && <span className="text-[11px] text-ink-3">paused</span>}
                {s.id === currentId && <Check className="size-4 text-brand" />}
              </button>
            ))}
          </div>
          <Link href="/websites" onClick={close} className="mt-1 block border-t border-line px-2.5 pb-1 pt-2 text-[13px] text-brand hover:underline">
            Manage websites
          </Link>
        </div>
      )}
    </Dropdown>
  );
}

export function RangeSelector({ ranges, current }: { ranges: { days: number; label: string }[]; current: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Dropdown
      width="w-52"
      trigger={(open) => (
        <span className={cn(pill, pending && "opacity-60")}>
          <CalendarRange className="size-4 text-ink-3" />
          {ranges.find((r) => r.days === current)?.label}
          <ChevronDown className={cn("size-4 text-ink-3 transition-transform", open && "rotate-180")} />
        </span>
      )}
    >
      {(close) =>
        ranges.map((r) => (
          <button
            key={r.days}
            onClick={() => {
              close();
              start(async () => {
                await setRangeAction(r.days);
                router.refresh();
              });
            }}
            className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-[13px] hover:bg-subtle"
          >
            {r.label}
            {r.days === current && <Check className="size-4 text-brand" />}
          </button>
        ))
      }
    </Dropdown>
  );
}

export function UserMenu({ email }: { email: string }) {
  return (
    <Dropdown
      align="right"
      width="w-64"
      trigger={() => (
        <span className="flex size-9 items-center justify-center rounded-full bg-gradient-to-br from-brand to-ai text-[13px] font-semibold uppercase text-white">
          {email[0]}
        </span>
      )}
    >
      {(close) => (
        <div>
          <div className="px-2.5 py-2">
            <p className="text-[11px] text-ink-3">Signed in as</p>
            <p className="truncate text-[13px] font-medium">{email}</p>
          </div>
          <div className="my-1 border-t border-line" />
          <Link href="/settings" onClick={close} className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] hover:bg-subtle">
            <Settings className="size-4 text-ink-3" /> Settings
          </Link>
          <Link href="/help" onClick={close} className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] hover:bg-subtle">
            <HelpCircle className="size-4 text-ink-3" /> Help & Support
          </Link>
          <form action={logoutAction}>
            <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-danger-ink hover:bg-danger-soft">
              <LogOut className="size-4" /> Sign out
            </button>
          </form>
        </div>
      )}
    </Dropdown>
  );
}
