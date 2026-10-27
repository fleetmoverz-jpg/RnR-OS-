import Link from "next/link";
import { BadgeCheck, BarChart3, CalendarRange, CheckCircle2, ExternalLink, FileText, Gauge, Lightbulb, PenSquare, RefreshCw, Search, Send, Sparkles, TriangleAlert, Wand2, X } from "lucide-react";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/social/workspace";
import { can } from "@/lib/social/policy";
import { contentService, type DraftPost, type Variant } from "@/lib/social/content/service";
import { contentProviders } from "@/lib/social/content/server";
import { connectionService, type AccountRow } from "@/lib/social/publish/connections";
import { publishService, type JobRow } from "@/lib/social/publish/service";
import { publishDeps } from "@/lib/social/publish/server";
import type { ImageCheck } from "@/lib/social/publish/media";
import { CATEGORIES, CATEGORY_LABEL, charCount, PLATFORM_RULES } from "@/lib/social/content/rules";
import { Badge, ButtonLink, Card, CardHeader, cn, EmptyState, Field, inputClass, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { ActionButton } from "@/components/ActionButton";
import { StatusBadge } from "@/components/social";
import { timeAgo } from "@/components/format";
import {
  approvePostAction,
  assignAccountAction,
  checkJobAction,
  createDraftAction,
  dismissTopicAction,
  generateDraftsAction,
  planTopicsAction,
  publishNowAction,
  refreshMetricsAction,
  regenerateVariantAction,
  rejectPostAction,
  researchTopicAction,
  setImageAction,
  updateVariantAction,
} from "../actions";

export const metadata = { title: "Content Studio" };
export const maxDuration = 120;

const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

function VariantCard({ v, editable, canRegenerate, children }: { v: Variant; editable: boolean; canRegenerate: boolean; children?: React.ReactNode }) {
  const rule = PLATFORM_RULES[v.platform];
  const count = charCount(v.platform, v.body, v.hashtags, v.link_url);
  const errors = v.validation?.errors ?? [];
  const warnings = v.validation?.warnings ?? [];
  return (
    <div className="min-w-0 rounded-lg border border-line">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <span className="text-[13px] font-semibold">{rule?.label ?? v.platform}</span>
        <span className={cn("text-xs tabular-nums", count > (rule?.maxChars ?? Infinity) ? "text-danger-ink" : "text-ink-3")}>
          {count} / {rule?.maxChars.toLocaleString()} characters
        </span>
      </div>
      <div className="space-y-2 px-3 py-3 text-[13px]">
        <p className="whitespace-pre-wrap break-words">{v.body}</p>
        {v.hashtags.length > 0 && <p className="break-words text-brand">{v.hashtags.map((h) => `#${h}`).join(" ")}</p>}
        {v.link_url && <p className="break-all text-xs text-ink-3">Link: {v.link_url}</p>}
        {v.call_to_action && <p className="text-xs text-ink-3">Call to action: {v.call_to_action}</p>}
        {v.image_concept && <p className="text-xs text-ink-3"><Sparkles className="mr-1 inline size-3 text-ai" />Image idea: {v.image_concept}</p>}
        {errors.length > 0 && (
          <ul className="space-y-1 rounded-md bg-danger-soft px-2.5 py-2 text-xs text-danger-ink">
            {errors.map((e) => <li key={e} className="flex gap-1.5"><TriangleAlert className="mt-0.5 size-3 shrink-0" />{e}</li>)}
          </ul>
        )}
        {warnings.length > 0 && (
          <ul className="space-y-1 text-xs text-warning-ink">
            {warnings.map((w) => <li key={w}>· {w}</li>)}
          </ul>
        )}
        {v.edited_by && <p className="text-xs text-ink-3">Edited by {v.edited_by}</p>}
      </div>
      {editable && (
        <div className="space-y-2 border-t border-line px-3 py-2">
          <details>
            <summary className="cursor-pointer text-xs font-medium text-brand">Edit</summary>
            <div className="pt-2">
              <ActionForm action={updateVariantAction.bind(null, v.id)} submitLabel="Save" variant="secondary">
                <textarea name="body" rows={6} defaultValue={v.body} maxLength={5000} className={inputClass} aria-label="Post text" />
                <Field label="Hashtags" hint="Separated by spaces, without #."><input name="hashtags" defaultValue={v.hashtags.join(" ")} className={inputClass} /></Field>
                <Field label="Link"><input name="link_url" defaultValue={v.link_url ?? ""} className={inputClass} placeholder="https://" /></Field>
              </ActionForm>
            </div>
          </details>
          {canRegenerate && <ActionButton action={regenerateVariantAction.bind(null, v.id)} label="Regenerate" pendingLabel="Writing…" variant="ghost" align="start" icon={<RefreshCw className="size-4" />} />}
        </div>
      )}
      {children}
    </div>
  );
}

type Publishing = { accounts: AccountRow[]; jobs: JobRow[]; role: string; postStatus: string };
type PubVariant = Variant & { social_account_id?: string | null; image_url?: string | null; image_check?: ImageCheck | null; external_url?: string | null; published_at?: string | null; metrics?: Record<string, number | null> | null; metrics_fetched_at?: string | null };

// Account, image and publishing controls for one platform version.
function PublishPanel({ v, pub }: { v: PubVariant; pub: Publishing }) {
  const accounts = pub.accounts.filter((a) => a.platform === v.platform && a.status !== "revoked");
  const job = pub.jobs.find((j) => j.variant_id === v.id && j.social_account_id === v.social_account_id) ?? null;
  const editable = can(pub.role as never, "post.edit") && ["draft", "approved", "rejected", "failed"].includes(pub.postStatus) && v.status !== "published";
  const canPublish = can(pub.role as never, "post.publish");
  const account = accounts.find((a) => a.id === v.social_account_id) ?? null;
  const check = v.image_check;
  return (
    <div className="space-y-2 border-t border-line px-3 py-2 text-xs">
      {v.status === "published" ? (
        <div className="space-y-1.5">
          <p className="flex flex-wrap items-center gap-2 text-success-ink">
            <CheckCircle2 className="size-3.5" /> Published{account ? ` to ${account.display_name}` : ""}{v.published_at ? ` · ${timeAgo(v.published_at)}` : ""}
            {v.external_url && <a href={v.external_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">View <ExternalLink className="size-3" /></a>}
          </p>
          {v.metrics && (
            <p className="text-ink-2">
              {Object.entries(v.metrics).map(([k, n]) => `${k}: ${n ?? "unavailable"}`).join(" · ")}
              {v.metrics_fetched_at && <span className="text-ink-3"> · {timeAgo(v.metrics_fetched_at)}</span>}
            </p>
          )}
          {account?.permitted_actions.includes("read_metrics") && <ActionButton action={refreshMetricsAction.bind(null, v.id)} label={v.metrics ? "Refresh metrics" : "Get metrics"} pendingLabel="Reading…" variant="ghost" align="start" icon={<BarChart3 className="size-4" />} />}
        </div>
      ) : (
        <>
          {editable ? (
            <ActionForm action={assignAccountAction.bind(null, v.id)} submitLabel="Save" variant="ghost">
              <Field label="Post to">
                <select name="account_id" defaultValue={v.social_account_id ?? ""} className={`${inputClass} h-9 py-0`}>
                  <option value="">{accounts.length ? "Choose an account" : "No connected account for this platform"}</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.display_name}{a.status !== "connected" ? ` (${a.status.replace("_", " ")})` : ""}</option>)}
                </select>
              </Field>
            </ActionForm>
          ) : (
            account && <p className="text-ink-2">Posts to {account.display_name}</p>
          )}
          {(editable || v.image_url) && (
            <details open={Boolean(v.image_url)}>
              <summary className="cursor-pointer font-medium text-brand">{v.image_url ? "Image" : "Add image"}</summary>
              <div className="space-y-1.5 pt-2">
                {v.image_url && <p className="break-all text-ink-3">{v.image_url}</p>}
                {check && (check.ok ? <p className="text-success-ink">{check.mime?.replace("image/", "").toUpperCase()} · {check.width}×{check.height}</p> : <p className="text-danger-ink">{check.errors.join(" ")}</p>)}
                {check?.warnings.map((w) => <p key={w} className="text-warning-ink">{w}</p>)}
                {editable && (
                  <ActionForm action={setImageAction.bind(null, v.id)} submitLabel="Save image" pendingLabel="Checking…" variant="ghost">
                    <input name="image_url" defaultValue={v.image_url ?? ""} placeholder="https://… public image link" className={inputClass} aria-label="Image link" />
                  </ActionForm>
                )}
              </div>
            </details>
          )}
          {job?.status === "needs_check" && (
            <div className="space-y-1 rounded-md bg-warning-soft px-2.5 py-2 text-warning-ink">
              <p>The platform&apos;s answer was unclear, so this may already be posted. It won&apos;t be retried until checked.</p>
              {canPublish && <ActionButton action={checkJobAction.bind(null, job.id)} label="Check if it posted" pendingLabel="Checking…" variant="secondary" align="start" />}
            </div>
          )}
          {job?.status === "failed" && job.last_error && <p className="text-danger-ink">Last attempt: {job.last_error}</p>}
          {canPublish && ["approved", "failed", "publishing"].includes(pub.postStatus) && job?.status !== "needs_check" && v.social_account_id && (
            <ActionButton action={publishNowAction.bind(null, v.id)} label={job?.status === "failed" ? "Try again" : "Publish now"} pendingLabel="Publishing…" variant="primary" align="start" icon={<Send className="size-4" />} />
          )}
        </>
      )}
    </div>
  );
}

function PostCard({ p, role, aiReady, pub }: { p: DraftPost; role: string; aiReady: boolean; pub: Omit<Publishing, "postStatus"> }) {
  const editable = can(role as never, "post.edit") && ["draft", "rejected", "approved"].includes(p.status);
  const blocked = p.variants.some((v) => v.validation?.errors?.length);
  return (
    <li className="space-y-3 px-5 py-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{p.title}</span>
            <StatusBadge status={p.status} />
            {p.origin === "ai" && <Badge tone="ai"><Sparkles className="size-3" /> AI draft</Badge>}
            {p.category && <Badge>{CATEGORY_LABEL[p.category as keyof typeof CATEGORY_LABEL] ?? p.category}</Badge>}
          </p>
          <p className="mt-0.5 text-xs text-ink-3">
            Created {timeAgo(p.created_at)}
            {p.approved_by && ` · approved by ${p.approved_by}`}
            {p.rejected_reason && ` · rejected: ${p.rejected_reason}`}
          </p>
        </div>
        {can(role as never, "post.approve") && (
          <div className="flex flex-wrap gap-1">
            {p.status === "draft" && p.variants.length > 0 && (
              blocked ? (
                <span className="self-center text-xs text-danger-ink">Fix problems to approve</span>
              ) : (
                <ActionButton action={approvePostAction.bind(null, p.id)} label="Approve" pendingLabel="Approving…" variant="primary" icon={<BadgeCheck className="size-4" />} />
              )
            )}
            {["draft", "approved"].includes(p.status) && <ActionButton action={rejectPostAction.bind(null, p.id)} label="Reject" pendingLabel="Saving…" variant="ghost" icon={<X className="size-4" />} />}
          </div>
        )}
      </div>
      {p.variants.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {p.variants.map((v) => (
            <VariantCard key={v.id} v={v} editable={editable} canRegenerate={aiReady && ["draft", "rejected"].includes(p.status)}>
              <PublishPanel v={v as PubVariant} pub={{ ...pub, postStatus: p.status }} />
            </VariantCard>
          ))}
        </div>
      ) : (
        p.body && <p className="whitespace-pre-wrap text-[13px] text-ink-2">{p.body}</p>
      )}
      {p.sources.length > 0 && (
        <div className="text-xs text-ink-3">
          <p className="font-medium text-ink-2">Sources</p>
          <ul className="mt-1 space-y-0.5">
            {p.sources.map((s) => (
              <li key={s.id} className="break-all">
                <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="text-brand hover:underline">{s.title ?? host(s.url)}</a> · {host(s.url)} · retrieved {s.retrieved_at.slice(0, 10)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

export default async function ContentStudioPage({ searchParams }: PageProps<"/social/content">) {
  const sp = await searchParams;
  const { repo } = await requireWorkspace();
  const role = repo.ctx.role;
  const brands = (await repo.listBrands()).filter((b) => b.status === "active");
  const brand = brands.find((b) => b.id === sp.brand) ?? brands[0] ?? null;
  const providers = contentProviders();
  const service = contentService(db(), repo.ctx, { text: providers.text, research: providers.research, pricing: providers.pricing });
  const [profile, strategy, topics, posts, usage] = brand
    ? await Promise.all([repo.getProfile(brand.id), service.getStrategy(brand.id), service.listTopics(brand.id), service.listPosts({ brandId: brand.id }), service.usage()])
    : [null, null, [], [], await service.usage()];
  const approved = profile?.status === "approved";
  const editable = can(role, "post.edit");
  const aiReady = Boolean(providers.text) && approved;
  const openTopics = topics.filter((t) => t.status === "new");
  const pending = posts.filter((p) => p.status === "draft").length;
  const pubDeps = publishDeps();
  const [accounts, jobs] = brand
    ? await Promise.all([connectionService(db(), repo.ctx, { provider: null as never, adapters: {}, encryptionKey: "" }).listAccounts(brand.id), publishService(db(), repo.ctx, pubDeps).jobsForPosts(posts.map((p) => p.id))])
    : [[], []];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Content Studio"
        description="Plan topics, research them and draft posts for each platform. Nothing is published until an admin presses Publish on an approved post."
        actions={
          brands.length > 1 && (
            <form className="flex items-center gap-2">
              <select name="brand" defaultValue={brand?.id} className={`${inputClass} h-9 w-56 py-0`} aria-label="Brand">
                {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <button className="h-9 rounded-lg border border-line bg-card px-3 text-[13px] font-medium">Show</button>
            </form>
          )
        }
      />

      {!brand ? (
        <Card><EmptyState icon={PenSquare} title="Create a brand first" action={<ButtonLink href="/social/brands" variant="primary">Go to Brands</ButtonLink>}>Content is planned per brand.</EmptyState></Card>
      ) : (
        <>
          {!approved && (
            <div className="flex flex-col gap-2 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning-ink sm:flex-row sm:items-center sm:justify-between">
              <span>AI drafting uses only confirmed facts, so {brand.name}&apos;s brand profile must be approved first.</span>
              <ButtonLink href={`/social/brands/${brand.id}/profile`} variant="secondary">Review profile</ButtonLink>
            </div>
          )}
          {!providers.text && (
            <div className="rounded-xl border border-line bg-card px-4 py-3 text-[13px] text-ink-2">
              AI drafting isn&apos;t configured: {providers.textReason}. You can still write drafts by hand.
            </div>
          )}

          <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
            <div className="min-w-0 space-y-6 xl:col-span-2">
              {editable && aiReady && strategy && (
                <Card>
                  <CardHeader icon={Wand2} title="Generate drafts" description={`For ${brand.name}. Each draft gets a separate version per platform.`} />
                  <div className="p-5">
                    <ActionForm action={generateDraftsAction} submitLabel="Generate drafts" pendingLabel="Researching and writing…">
                      <input type="hidden" name="brand_id" value={brand.id} />
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <Field label="Topic" hint="Or let it pick the next planned topics.">
                          <select name="topic_id" className={inputClass} defaultValue="">
                            <option value="">Next planned topics</option>
                            {openTopics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                          </select>
                        </Field>
                        <Field label="Category">
                          <select name="category" className={inputClass} defaultValue="">
                            <option value="">Any from the strategy</option>
                            {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                          </select>
                        </Field>
                        <Field label="Tone" hint={`Default: ${strategy.tone_override ?? profile?.tone ?? "from the brand profile"}`}>
                          <input name="tone" maxLength={200} className={inputClass} placeholder="Leave empty for the brand tone" />
                        </Field>
                        <Field label="How many" hint="1 to 5 posts.">
                          <input name="quantity" type="number" min={1} max={5} defaultValue={1} className={inputClass} />
                        </Field>
                      </div>
                      <fieldset className="min-w-0">
                        <legend className="mb-2 text-[13px] font-medium">Platforms</legend>
                        <div className="flex flex-wrap gap-x-4 gap-y-2 text-[13px]">
                          {Object.entries(PLATFORM_RULES).map(([id, r]) => (
                            <label key={id} className="flex items-center gap-1.5">
                              <input type="checkbox" name="platforms" value={id} defaultChecked={strategy.platforms.includes(id)} className="size-4 accent-brand" /> {r.label}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    </ActionForm>
                  </div>
                </Card>
              )}

              <Card>
                <CardHeader icon={FileText} title="Drafts" description={`${posts.length} posts · ${pending} waiting for approval`} />
                {posts.length === 0 ? (
                  <EmptyState icon={FileText} title="No posts yet">{aiReady ? "Generate drafts above, or write one by hand." : "Write one by hand, or approve the brand profile to use AI."}</EmptyState>
                ) : (
                  <ul className="divide-y divide-line">
                    {posts.map((p) => <PostCard key={p.id} p={p} role={role} aiReady={aiReady} pub={{ accounts, jobs, role }} />)}
                  </ul>
                )}
              </Card>
            </div>

            <div className="min-w-0 space-y-6">
              <Card>
                <CardHeader
                  icon={CalendarRange}
                  title="Topic plan"
                  description={strategy ? `${strategy.posts_per_week} posts a week · ${strategy.categories.length} categories` : undefined}
                  action={<ButtonLink href={`/social/content/strategy?brand=${brand.id}`} variant="ghost">Strategy</ButtonLink>}
                />
                {editable && aiReady && (
                  <div className="border-b border-line p-5">
                    <ActionForm action={planTopicsAction.bind(null, brand.id)} submitLabel="Suggest topics" pendingLabel="Thinking…" variant="secondary">
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="How many"><input name="count" type="number" min={1} max={10} defaultValue={5} className={inputClass} /></Field>
                        <Field label="Category">
                          <select name="category" className={inputClass} defaultValue="">
                            <option value="">Strategy mix</option>
                            {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                          </select>
                        </Field>
                      </div>
                    </ActionForm>
                  </div>
                )}
                {openTopics.length === 0 ? (
                  <EmptyState icon={Lightbulb} title="No planned topics">{aiReady ? "Suggest topics to fill the calendar." : "Topics appear here once the profile is approved."}</EmptyState>
                ) : (
                  <ul className="divide-y divide-line">
                    {openTopics.map((t) => (
                      <li key={t.id} className="space-y-1.5 px-5 py-3 text-[13px]">
                        <p className="font-medium">{t.title}</p>
                        <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                          {t.planned_for && <span>{new Date(`${t.planned_for}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}</span>}
                          {t.category && <Badge>{CATEGORY_LABEL[t.category]}</Badge>}
                          {t.needs_research && <Badge tone={t.sources.length ? "success" : "warning"}>{t.sources.length ? `${t.sources.length} sources` : "Needs research"}</Badge>}
                        </p>
                        {t.angle && <p className="text-xs text-ink-2">{t.angle}</p>}
                        {editable && (
                          <div className="flex flex-wrap gap-1 pt-1">
                            {providers.research && approved && <ActionButton action={researchTopicAction.bind(null, t.id)} label="Research" pendingLabel="Searching…" variant="ghost" align="start" icon={<Search className="size-4" />} />}
                            <ActionButton action={dismissTopicAction.bind(null, t.id)} label="Remove" pendingLabel="Removing…" variant="ghost" align="start" icon={<X className="size-4" />} />
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card>
                <CardHeader icon={Gauge} title="AI usage this month" description={usage.month} />
                <dl className="grid grid-cols-2 gap-4 p-5 text-[13px]">
                  <div>
                    <dt className="text-xs text-ink-3">Generations</dt>
                    <dd className="text-lg font-semibold tabular-nums">{usage.generations} <span className="text-xs font-normal text-ink-3">/ {usage.limits.monthly_generation_limit}</span></dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-3">Research calls</dt>
                    <dd className="text-lg font-semibold tabular-nums">{usage.research} <span className="text-xs font-normal text-ink-3">/ {usage.limits.monthly_research_limit}</span></dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-xs text-ink-3">Estimated cost</dt>
                    <dd className="text-lg font-semibold tabular-nums">${usage.costUsd.toFixed(2)} <span className="text-xs font-normal text-ink-3">/ ${usage.limits.monthly_cost_limit_usd.toFixed(2)}</span></dd>
                    {usage.unpricedCalls > 0 && <p className="text-xs text-ink-3">{usage.unpricedCalls} calls have no price set, so they aren&apos;t in this estimate.</p>}
                  </div>
                  <div className="col-span-2 space-y-1 text-xs text-ink-3">
                    <p>Writing: {providers.text ? `${providers.text.id} · ${providers.text.model}` : `off (${providers.textReason})`}</p>
                    <p>Research: {providers.research ? providers.research.id : `off (${providers.researchReason})`}</p>
                  </div>
                </dl>
              </Card>

              {editable && (
                <Card>
                  <CardHeader icon={PenSquare} title="Write by hand" />
                  <div className="p-5">
                    <ActionForm action={createDraftAction} submitLabel="Save draft" resetOnSuccess>
                      <input type="hidden" name="brand_id" value={brand.id} />
                      <Field label="Title"><input name="title" required maxLength={200} className={inputClass} /></Field>
                      <Field label="Text"><textarea name="body" rows={5} maxLength={5000} className={inputClass} /></Field>
                    </ActionForm>
                  </div>
                </Card>
              )}
              <p className="flex items-center gap-1.5 px-1 text-xs text-ink-3"><CheckCircle2 className="size-3.5" /> AI text is never treated as fact. Claims, numbers and links are checked against the approved profile and cited sources.</p>
              <p className="px-1 text-xs text-ink-3"><Link href="/social/calendar" className="text-brand hover:underline">See planned topics on the calendar</Link></p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
