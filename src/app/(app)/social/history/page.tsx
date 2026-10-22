import { History } from "lucide-react";
import { requireWorkspace } from "@/lib/social/workspace";
import { platformLabel } from "@/lib/social/platforms";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { StatusBadge, fmtDateTime } from "@/components/social";

export const metadata = { title: "Publishing History" };

export default async function HistoryPage() {
  const { repo } = await requireWorkspace();
  const attempts = await repo.listAttempts(100);

  return (
    <div className="space-y-6">
      <PageHeader title="Publishing History" description="Every publishing attempt with the platform's response. Publishing arrives in a later phase." />
      <Card>
        <CardHeader icon={History} title="Attempts" description="Newest first, last 100." />
        {attempts.length === 0 ? (
          <EmptyState icon={History} title="Nothing published yet">Attempts, successes and errors will be listed here once publishing is switched on.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="border-b border-line text-xs text-ink-3">
                <tr>
                  <th className="px-5 py-2.5 font-medium">When</th>
                  <th className="px-5 py-2.5 font-medium">Post</th>
                  <th className="px-5 py-2.5 font-medium">Platform</th>
                  <th className="px-5 py-2.5 font-medium">Attempt</th>
                  <th className="px-5 py-2.5 font-medium">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {attempts.map((a) => (
                  <tr key={a.id} className="align-top">
                    <td className="whitespace-nowrap px-5 py-3 text-ink-2">{fmtDateTime(a.started_at, "UTC")}</td>
                    <td className="px-5 py-3">{a.scheduled_jobs?.post_variants?.posts?.title ?? "Deleted post"}</td>
                    <td className="px-5 py-3">{platformLabel(a.scheduled_jobs?.post_variants?.platform ?? "")}</td>
                    <td className="px-5 py-3 tabular-nums">#{a.attempt_no}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={a.outcome === "success" ? "succeeded" : a.outcome === "error" ? "failed" : "publishing"} />
                      {a.error_message && <p className="mt-1 max-w-sm text-xs text-danger-ink">{a.http_status ? `${a.http_status} · ` : ""}{a.error_message}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
