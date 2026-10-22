import Link from "next/link";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/social/workspace";
import { contentService } from "@/lib/social/content/service";
import { CATEGORY_LABEL } from "@/lib/social/content/rules";
import { platformLabel } from "@/lib/social/platforms";
import { buttonClass, Card, CardHeader, PageHeader } from "@/components/ui";
import { cn } from "@/components/ui";

export const metadata = { title: "Publishing Calendar" };

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function parseMonth(value: string | string[] | undefined) {
  const m = typeof value === "string" ? /^(\d{4})-(\d{2})$/.exec(value) : null;
  const now = new Date();
  const year = m ? Number(m[1]) : now.getUTCFullYear();
  const month = m ? Number(m[2]) - 1 : now.getUTCMonth();
  return new Date(Date.UTC(year, Math.min(Math.max(month, 0), 11), 1));
}

const monthParam = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

export default async function CalendarPage({ searchParams }: PageProps<"/social/calendar">) {
  const start = parseMonth((await searchParams).month);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const prev = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
  const { repo } = await requireWorkspace();
  const noAi = { text: null, research: null, pricing: { inputPerMTok: null, outputPerMTok: null, researchPerCall: null } };
  const [jobs, topics] = await Promise.all([
    repo.listScheduledJobs(start, end),
    contentService(db(), repo.ctx, noAi).plannedTopics(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)),
  ]);

  // Monday-first grid covering the whole month.
  const lead = (start.getUTCDay() + 6) % 7;
  const days = Math.round((end.getTime() - start.getTime()) / 864e5);
  const cells = Array.from({ length: Math.ceil((lead + days) / 7) * 7 }, (_, i) => i - lead + 1);
  const today = new Date().toISOString().slice(0, 10);
  const byDay = new Map<number, typeof jobs>();
  for (const j of jobs) {
    const d = new Date(j.run_at).getUTCDate();
    byDay.set(d, [...(byDay.get(d) ?? []), j]);
  }
  const topicsByDay = new Map<number, typeof topics>();
  for (const t of topics) {
    const d = Number(t.planned_for!.slice(8, 10));
    topicsByDay.set(d, [...(topicsByDay.get(d) ?? []), t]);
  }
  const title = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(start);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Publishing Calendar"
        description="Planned topics and scheduled posts by day (UTC). Scheduling arrives with publishing in a later phase."
        actions={
          <div className="flex items-center gap-2">
            <Link href={`/social/calendar?month=${monthParam(prev)}`} className={buttonClass("secondary")} aria-label="Previous month"><ChevronLeft className="size-4" /></Link>
            <Link href="/social/calendar" className={buttonClass("secondary")}>Today</Link>
            <Link href={`/social/calendar?month=${monthParam(end)}`} className={buttonClass("secondary")} aria-label="Next month"><ChevronRight className="size-4" /></Link>
          </div>
        }
      />
      <Card>
        <CardHeader icon={CalendarDays} title={title} description={jobs.length || topics.length ? `${topics.length} planned topics · ${jobs.length} scheduled posts` : "Nothing planned this month"} />
        <div className="overflow-x-auto">
          <div className="grid min-w-[640px] grid-cols-7 text-[12px]">
            {WEEKDAYS.map((d) => (
              <div key={d} className="border-b border-line px-2 py-2 text-center font-medium text-ink-3">{d}</div>
            ))}
            {cells.map((day, i) => {
              const inMonth = day >= 1 && day <= days;
              const iso = inMonth ? `${monthParam(start)}-${String(day).padStart(2, "0")}` : "";
              return (
                <div key={i} className={cn("min-h-24 border-b border-line p-2", i % 7 !== 6 && "border-r", !inMonth && "bg-subtle/40")}>
                  {inMonth && (
                    <>
                      <span className={cn("inline-flex size-6 items-center justify-center rounded-full text-xs", iso === today ? "bg-brand font-semibold text-white" : "text-ink-2")}>{day}</span>
                      <ul className="mt-1 space-y-1">
                        {(byDay.get(day) ?? []).map((j) => (
                          <li key={j.id} className="truncate rounded bg-brand-soft px-1.5 py-0.5 text-[11px] text-brand" title={j.post_variants?.posts?.title}>
                            {new Date(j.run_at).toISOString().slice(11, 16)} {platformLabel(j.post_variants?.platform ?? "")}
                          </li>
                        ))}
                        {(topicsByDay.get(day) ?? []).map((t) => (
                          <li key={t.id}>
                            <Link href={`/social/content?brand=${t.brand_id}`} className="block truncate rounded border border-dashed border-ai/40 bg-ai-soft px-1.5 py-0.5 text-[11px] text-ai" title={`${t.brand_name}: ${t.title}${t.category ? ` (${CATEGORY_LABEL[t.category]})` : ""}`}>
                              {t.title}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </Card>
    </div>
  );
}
