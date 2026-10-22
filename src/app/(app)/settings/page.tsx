import { LogOut } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { buttonClass, Card, CardHeader, PageHeader } from "@/components/ui";
import { logoutAction } from "../actions";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const email = await requireUser();
  const rows = [
    ["History imported on first sync", `${env.backfillDays()} days`],
    ["Daily sync", "06:00 UTC for every active website"],
    ["URL inspections per site per day", String(env.inspectLimit())],
    ["AI recommendations refresh", `Every ${env.aiReportEveryDays()} days`],
    ["AI model", env.anthropicModel()],
  ];
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Settings" />
      <Card>
        <CardHeader title="Account" description="RnR Os is private. Only this Google account can sign in." />
        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs text-ink-3">Signed in as</p>
            <p className="font-medium">{email}</p>
          </div>
          <form action={logoutAction}>
            <button className={buttonClass("secondary")}><LogOut className="size-4" /> Sign out</button>
          </form>
        </div>
      </Card>
      <Card>
        <CardHeader title="Sync & AI" description="Change these with environment variables in Vercel (see README)." />
        <dl className="divide-y divide-line/70">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-4 px-5 py-3 text-[13px]">
              <dt className="text-ink-2">{k}</dt>
              <dd className="font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}
