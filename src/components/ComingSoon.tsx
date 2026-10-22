import type { LucideIcon } from "lucide-react";
import { Check } from "lucide-react";
import { Badge, Card, PageHeader } from "./ui";

// Planned modules: describe what's coming without pretending there is data.
export function ComingSoon({ icon: Icon, title, phase, intro, features }: { icon: LucideIcon; title: string; phase: string; intro: string; features: string[] }) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} />
      <Card className="overflow-hidden">
        <div className="bg-gradient-to-br from-brand-soft via-ai-soft to-card px-6 py-10 sm:px-10">
          <span className="flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-brand to-ai text-white shadow-sm">
            <Icon className="size-6" />
          </span>
          <div className="mt-5 flex items-center gap-2">
            <Badge tone="ai">{phase}</Badge>
            <Badge>In planning</Badge>
          </div>
          <h2 className="mt-3 text-xl font-semibold tracking-tight">{title} is coming next</h2>
          <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-ink-2">{intro}</p>
        </div>
        <ul className="grid gap-x-8 gap-y-3 px-6 py-6 sm:grid-cols-2 sm:px-10">
          {features.map((f) => (
            <li key={f} className="flex gap-2 text-[13px]">
              <Check className="mt-0.5 size-4 shrink-0 text-brand" />
              {f}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
