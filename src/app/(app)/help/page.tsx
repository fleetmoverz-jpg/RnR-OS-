import { BookOpen } from "lucide-react";
import { Card, CardHeader, PageHeader } from "@/components/ui";

export const metadata = { title: "Help & Support" };

const FAQ = [
  ["Why is the newest data two days old?", "Google publishes Search Console data with a delay of about two days. RnR Os always shows the newest complete days."],
  ["What does average position mean?", "Where your pages appear in Google on average. 1 is the top result, so a lower number is better and a falling number is an improvement."],
  ["What is CTR?", "Click-through rate: the share of impressions that turned into clicks. A low CTR at a good position usually means the title or description isn't compelling."],
  ["What is page 2 striking distance?", "Queries where you rank 11–20. They already have Google's attention, so a content refresh or a few internal links can move them to page one."],
  ["What is cannibalization?", "Two or more of your own pages competing for the same query, which splits clicks and can hold both back. Usually fixed by merging pages or making each one clearly about something different."],
  ["How often does data update?", "Every day at 06:00 UTC, automatically. Use Refresh data on any page to sync right away."],
  ["How are AI recommendations made?", "Claude reads a summary of your Search Console insights and writes a prioritised plan. They refresh weekly, or whenever you click Regenerate."],
];

export default function HelpPage() {
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Help & Support" description="How RnR Os works and what the numbers mean." />
      <Card>
        <CardHeader icon={BookOpen} title="Frequently asked questions" />
        <div className="divide-y divide-line/70">
          {FAQ.map(([q, a]) => (
            <details key={q} className="group px-5 py-4">
              <summary className="cursor-pointer list-none font-medium marker:hidden">
                <span className="flex items-center justify-between gap-4">
                  {q}
                  <span className="text-ink-3 transition-transform group-open:rotate-45">+</span>
                </span>
              </summary>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{a}</p>
            </details>
          ))}
        </div>
      </Card>
    </div>
  );
}
