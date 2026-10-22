import Link from "next/link";
import { Bot, Gauge, Pause, Play, ShieldAlert, Users } from "lucide-react";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/social/workspace";
import { can } from "@/lib/social/policy";
import { platformLabel } from "@/lib/social/platforms";
import { CATEGORIES, CATEGORY_LABEL } from "@/lib/social/content/rules";
import { publishService } from "@/lib/social/publish/service";
import { publishDeps } from "@/lib/social/publish/server";
import { connectionService } from "@/lib/social/publish/connections";
import { DEFAULT_BRAND_AUTOMATION, MODES, MODE_INFO, queueService } from "@/lib/social/automation/queue";
import { upcomingSlots } from "@/lib/social/automation/time";
import { Badge, Card, CardHeader, EmptyState, Field, inputClass, PageHeader } from "@/components/ui";
import { ActionButton } from "@/components/ActionButton";
import { ActionForm } from "@/components/ActionForm";
import { StatusBadge } from "@/components/social";
import { saveAutomationLimitsAction, saveBrandAutomationAction, setAccountAutomationAction, setBrandPausedAction, setPauseAllAction } from "../actions";

export const metadata = { title: "Automation" };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function AutomationPage() {
  const { repo } = await requireWorkspace();
  const admin = can(repo.ctx.role, "automation.manage");
  const q = queueService(db(), repo.ctx, { publish: publishService(db(), repo.ctx, publishDeps()) });
  const accountsService = connectionService(db(), repo.ctx, { provider: null as never, adapters: {}, encryptionKey: "" });
  const [settings, automation, brands, accounts] = await Promise.all([q.settings(), q.brandAutomation(), repo.listBrands(), accountsService.listAccounts()]);
  const now = new Date();

  return (
    <div className="space-y-6">
      <PageHeader title="Automation" description="When each brand posts, how much the app may do on its own, and the limits that keep it in check. Everything starts switched off." />

      <Card>
        <CardHeader
          icon={ShieldAlert}
          title="Safety"
          description={settings.paused ? "Everything is paused. Nothing is published or generated." : "Automation runs within these limits. Pause everything at any time."}
          action={admin && <ActionButton action={setPauseAllAction.bind(null, !settings.paused)} label={settings.paused ? "Resume everything" : "Pause everything"} pendingLabel="Saving…" variant={settings.paused ? "primary" : "secondary"} icon={settings.paused ? <Play className="size-4" /> : <Pause className="size-4" />} />}
        />
        <div className="p-5">
          {admin ? (
            <ActionForm action={saveAutomationLimitsAction} submitLabel="Save limits" variant="secondary">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Posts per day" hint="All brands together, per UTC day">
                  <input name="daily_post_limit" type="number" min={0} max={500} required defaultValue={settings.daily_post_limit} className={inputClass} />
                </Field>
                <Field label="Posts per month" hint="Queued posts wait when it's reached">
                  <input name="monthly_post_limit" type="number" min={0} max={10000} required defaultValue={settings.monthly_post_limit} className={inputClass} />
                </Field>
                <Field label="AI spending per day (USD)" hint="Draft writing stops for the day">
                  <input name="daily_ai_cost_limit_usd" type="number" min={0} step="0.01" required defaultValue={settings.daily_ai_cost_limit_usd} className={inputClass} />
                </Field>
              </div>
              <p className="text-xs text-ink-3">
                The monthly AI limits are in <Link href="/social/settings" className="text-brand hover:underline">Social Settings</Link>. Posts you publish by hand don&apos;t count against these limits.
              </p>
            </ActionForm>
          ) : (
            <p className="text-[13px] text-ink-2">Up to {settings.daily_post_limit} posts a day and {settings.monthly_post_limit} a month; ${settings.daily_ai_cost_limit_usd} of AI a day. Only admins can change this.</p>
          )}
        </div>
      </Card>

      {brands.length === 0 ? (
        <Card>
          <EmptyState icon={Bot} title="No brands yet">Create a brand first, then set when it should post.</EmptyState>
        </Card>
      ) : (
        brands.map((b) => {
          const a = automation.get(b.id) ?? { brand_id: b.id, ...DEFAULT_BRAND_AUTOMATION };
          const next = upcomingSlots({ daysOfWeek: a.days_of_week, times: a.times, postsPerWeek: a.posts_per_week, timezone: b.timezone }, now, 14).slice(0, 3);
          return (
            <Card key={b.id}>
              <CardHeader
                icon={Bot}
                title={b.name}
                description={
                  <span className="flex flex-wrap items-center gap-2">
                    {a.enabled ? <Badge tone={a.paused ? "warning" : "success"}>{a.paused ? "Paused" : "On"}</Badge> : <Badge>Off</Badge>}
                    <span>{MODE_INFO[a.mode].label}</span>
                  </span>
                }
                action={admin && a.enabled && <ActionButton action={setBrandPausedAction.bind(null, b.id, !a.paused)} label={a.paused ? "Resume brand" : "Pause brand"} pendingLabel="Saving…" variant="ghost" icon={a.paused ? <Play className="size-4" /> : <Pause className="size-4" />} />}
              />
              <div className="p-5">
                <ActionForm action={saveBrandAutomationAction.bind(null, b.id)} submitLabel="Save" variant="secondary">
                  <label className="flex items-center gap-2 text-[13px] font-medium">
                    <input type="checkbox" name="enabled" defaultChecked={a.enabled} disabled={!admin} className="size-4 accent-brand" /> Automation on for {b.name}
                  </label>
                  <fieldset className="space-y-2" disabled={!admin}>
                    <legend className="mb-1 text-[13px] font-medium">What it may do</legend>
                    {MODES.map((m) => (
                      <label key={m} className="flex items-start gap-2 text-[13px]">
                        <input type="radio" name="mode" value={m} defaultChecked={a.mode === m} className="mt-0.5 size-4 accent-brand" />
                        <span>
                          <span className="font-medium">{MODE_INFO[m].label}</span>
                          <span className="block text-xs text-ink-3">{MODE_INFO[m].help}</span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  <div className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning-ink">
                    <label className="flex items-start gap-2">
                      <input type="checkbox" name="confirm_full_auto" disabled={!admin} className="mt-0.5 size-4 accent-brand" />
                      <span>
                        I understand that <strong>Fully automatic</strong> publishes posts nobody has read. Only drafts that pass every check are approved. You can pause everything at any time.
                        {a.full_auto_confirmed_by && <span className="block">Confirmed by {a.full_auto_confirmed_by} on {a.full_auto_confirmed_at?.slice(0, 10)}.</span>}
                      </span>
                    </label>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label="Posting days">
                      <div className="flex flex-wrap gap-x-4 gap-y-2 text-[13px]">
                        {DAYS.map((d, i) => (
                          <label key={d} className="flex items-center gap-1.5">
                            <input type="checkbox" name="days_of_week" value={i} defaultChecked={a.days_of_week.includes(i)} disabled={!admin} className="size-4 accent-brand" /> {d}
                          </label>
                        ))}
                      </div>
                    </Field>
                    <Field label="Times" hint={`24-hour, in ${b.timezone} (the brand's time zone)`}>
                      <input name="times" defaultValue={a.times.join(", ")} required disabled={!admin} className={inputClass} placeholder="09:00, 18:30" />
                    </Field>
                    <Field label="Posts per week" hint="Includes posts you schedule by hand">
                      <input name="posts_per_week" type="number" min={1} max={21} required defaultValue={a.posts_per_week} disabled={!admin} className={inputClass} />
                    </Field>
                    <Field label="Topic categories" hint="None ticked: use the content strategy's">
                      <div className="flex flex-wrap gap-x-4 gap-y-2 text-[13px]">
                        {CATEGORIES.map((c) => (
                          <label key={c} className="flex items-center gap-1.5">
                            <input type="checkbox" name="categories" value={c} defaultChecked={a.categories.includes(c)} disabled={!admin} className="size-4 accent-brand" /> {CATEGORY_LABEL[c]}
                          </label>
                        ))}
                      </div>
                    </Field>
                  </div>
                  <p className="text-xs text-ink-3">
                    Next slots: {next.length ? next.map((s) => s.local).join(" · ") : "none in the next two weeks"} ({b.timezone}).
                    {a.last_generated_at && ` Last wrote drafts ${a.last_generated_at.slice(0, 16).replace("T", " ")} UTC.`}
                  </p>
                </ActionForm>
              </div>
            </Card>
          );
        })
      )}

      <Card>
        <CardHeader icon={Users} title="Accounts" description="Switch automation off for one account and the queue won't plan or publish to it. Nothing is ever moved to another account." />
        {accounts.length === 0 ? (
          <EmptyState icon={Gauge} title="No accounts connected">Connect a Facebook Page or Instagram account on <Link href="/social/accounts" className="text-brand hover:underline">Connected Accounts</Link>.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {accounts.map((acc) => (
              <li key={acc.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-[13px]">
                    <span className="font-medium">{acc.display_name}</span>
                    <StatusBadge status={acc.status} />
                    {acc.automation_paused ? <Badge tone="warning">Automation off</Badge> : <Badge tone="success">Automation on</Badge>}
                  </p>
                  <p className="text-xs text-ink-3">{platformLabel(acc.platform)} · {brands.find((b) => b.id === acc.brand_id)?.name ?? "Archived brand"}</p>
                </div>
                {admin && acc.status !== "revoked" && <ActionButton action={setAccountAutomationAction.bind(null, acc.id, !acc.automation_paused)} label={acc.automation_paused ? "Turn on" : "Turn off"} pendingLabel="Saving…" variant="ghost" />}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
