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
      <PageHeader title="Publishing History" description="Every publishing attempt with the platform's answer. A post counts as published only when the platform confirms it." />
      <Card>
        <CardHeader icon={History} title="Attempts" description="Newest first, last 100." />
        {attempts.length === 0 ? (
          <EmptyState icon={History} title="Nothing published yet">Attempts, successes and errors are listed here after you publish an approved post.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="border-b border-line text-xs text-ink-3">
                <tr>
                  <th className="px-5 py-2.5 font-medium">When</th>
                  <th className="px-5 py-2.5 font-medium">Post</th>
                  <th className="px-5 py-2.5 font-medium">Account</th>
                  <th className="px-5 py-2.5 font-medium">Attempt</th>
                  <th className="px-5 py-2.5 font-medium">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {attempts.map((a) => (
                  <tr key={a.id} className="align-top">
                    <td className="whitespace-nowrap px-5 py-3 text-ink-2">{fmtDateTime(a.started_at, "UTC")}</td>
                    <td className="px-5 py-3">{a.scheduled_jobs?.post_variants?.posts?.title ?? "Deleted post"}</td>
                    <td className="px-5 py-3">
                      {platformLabel(a.scheduled_jobs?.post_variants?.platform ?? "")}
                      {a.scheduled_jobs?.social_accounts && <p className="text-xs text-ink-3">{a.scheduled_jobs.social_accounts.display_name}</p>}
                    </td>
                    <td className="px-5 py-3 tabular-nums">#{a.attempt_no}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={a.outcome === "success" ? "published" : a.outcome === "reconciled" ? "reconciled" : a.outcome === "ambiguous" ? "needs_check" : a.outcome === "error" ? "failed" : "publishing"} />
                      {(a.outcome === "success" || a.outcome === "reconciled") && a.scheduled_jobs?.post_variants?.external_url && (
                        <a href={a.scheduled_jobs.post_variants.external_url} target="_blank" rel="noopener noreferrer" className="mt-1 block text-xs text-brand hover:underline">View post</a>
                      )}
                      {a.outcome === "reconciled" && <p className="mt-1 text-xs text-ink-3">Confirmed by checking the platform after an unclear answer.</p>}
                      {a.error_message && <p className="mt-1 max-w-sm text-xs text-danger-ink">{[a.http_status, a.error_code].filter(Boolean).join(" · ")}{a.http_status || a.error_code ? " · " : ""}{a.error_message}</p>}
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
