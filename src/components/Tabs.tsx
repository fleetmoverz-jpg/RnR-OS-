"use client";

import { useState } from "react";
import { cn } from "./ui";

// Panels are rendered on the server and passed in; this only switches between them.
export function Tabs({ tabs }: { tabs: { id: string; label: string; count?: number; panel: React.ReactNode }[] }) {
  const [active, setActive] = useState(tabs[0]?.id);
  return (
    <div>
      <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line px-3">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            onClick={() => setActive(t.id)}
            className={cn(
              "relative flex items-center gap-1.5 whitespace-nowrap px-3 py-3 text-[13px] font-medium transition-colors",
              active === t.id ? "text-brand" : "text-ink-2 hover:text-ink",
            )}
          >
            {t.label}
            {t.count != null && (
              <span className={cn("rounded-full px-1.5 text-[11px] tabular-nums", active === t.id ? "bg-brand-soft" : "bg-subtle text-ink-3")}>{t.count}</span>
            )}
            {active === t.id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand" />}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" hidden={active !== t.id}>
          {t.panel}
        </div>
      ))}
    </div>
  );
}
