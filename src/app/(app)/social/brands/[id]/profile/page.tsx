import Link from "next/link";
import { notFound } from "next/navigation";
import { BadgeCheck, CheckCircle2, ClipboardCheck, FileSearch, Lock, PencilLine, RotateCcw, ScanSearch, Sparkles, TriangleAlert, X } from "lucide-react";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/social/workspace";
import { can, NotFound } from "@/lib/social/policy";
import { analysisService, type BrandFact, type ReviewField } from "@/lib/social/analysis";
import { analysisDeps } from "@/lib/social/analysisServer";
import { Badge, Card, CardHeader, cn, EmptyState, Field, inputClass, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { ActionButton } from "@/components/ActionButton";
import { fmtDateTime } from "@/components/social";
import { timeAgo } from "@/components/format";
import { approveProfileAction, confirmFactAction, rejectFactAction, reopenProfileAction, saveProfileAction, scanWebsiteAction } from "../../../actions";

export const metadata = { title: "Brand profile" };
export const maxDuration = 60;

const STATUS: Record<ReviewField["status"], { tone: "success" | "brand" | "warning" | "ai" | "neutral"; text: string }> = {
  confirmed: { tone: "success", text: "Confirmed by you" },
  found: { tone: "brand", text: "Found on website, please confirm" },
  conflict: { tone: "warning", text: "Conflicting values, choose one" },
  suggested: { tone: "ai", text: "AI suggestion only" },
  missing: { tone: "neutral", text: "Not found, please add" },
};

function OriginBadge({ origin }: { origin: BrandFact["origin"] }) {
  if (origin === "ai_suggestion") return <Badge tone="ai"><Sparkles className="size-3" /> AI suggestion, not a verified fact</Badge>;
  if (origin === "structured_data") return <Badge tone="accent">Website structured data</Badge>;
  if (origin === "website") return <Badge>Website text</Badge>;
  return <Badge>Added by you</Badge>;
}

const shortUrl = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, "")}${x.pathname === "/" ? "" : x.pathname}`;
  } catch {
    return u;
  }
};

function FactRow({ fact, editable, showValue = true }: { fact: BrandFact; editable: boolean; showValue?: boolean }) {
  const isLink = /^https?:\/\//.test(fact.value);
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1 space-y-1">
        {showValue && (
          <p className="break-words text-[13px] font-medium">
            {isLink ? (
              <a href={fact.value} target="_blank" rel="noopener noreferrer nofollow" className="hover:underline">{fact.label ?? shortUrl(fact.value)}</a>
            ) : (
              fact.value
            )}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <OriginBadge origin={fact.origin} />
          {fact.confidence != null && <Badge>{Math.round(fact.confidence * 100)}% confidence</Badge>}
          {fact.status === "confirmed" && <Badge tone="success"><CheckCircle2 className="size-3" /> Confirmed</Badge>}
        </div>
        {fact.source_url && (
          <p className="text-xs text-ink-3">
            Source:{" "}
            <a href={fact.source_url} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-brand hover:underline">{shortUrl(fact.source_url)}</a>
            {fact.source_quote && <span className="mt-0.5 block break-words italic text-ink-2">“{fact.source_quote.slice(0, 220)}”</span>}
          </p>
        )}
      </div>
      {editable && fact.status !== "confirmed" && (
        <div className="flex shrink-0 gap-1">
          <ActionButton action={confirmFactAction.bind(null, fact.id)} label="Use" pendingLabel="Saving…" icon={<CheckCircle2 className="size-4" />} align="start" />
          <ActionButton action={rejectFactAction.bind(null, fact.id)} label="Reject" pendingLabel="Saving…" variant="ghost" icon={<X className="size-4" />} align="start" />
        </div>
      )}
    </li>
  );
}

const display = (v: string | string[] | null) => (Array.isArray(v) ? (v.length ? v.join(", ") : null) : v);

export default async function BrandProfilePage({ params }: PageProps<"/social/brands/[id]/profile">) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { repo } = await requireWorkspace();
  const service = analysisService(db(), repo.ctx, analysisDeps());
  const review = await service.review(id).catch((e) => {
    if (e instanceof NotFound) notFound();
    throw e;
  });
  const { brand, profile, fields, lists, latestScan, conflicts, missing } = review;
  const role = repo.ctx.role;
  const editable = can(role, "brand.edit");
  const websites = (await repo.listWebsites()).filter((w) => w.brand_id === id);
  const scanTarget = websites.find((w) => w.id === profile?.source_website_id) ?? websites[0];
  const approved = profile?.status === "approved";
  const toReview = fields.filter((f) => f.needsConfirmation);
  const done = fields.filter((f) => !f.needsConfirmation);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <span>
            <Link href="/social/brands" className="hover:text-ink">Brands</Link> / <Link href={`/social/brands/${id}`} className="hover:text-ink">{brand.name}</Link>
          </span>
        }
        title="Brand profile"
        description="Facts read from the website, each with its source. Nothing is used in content until you confirm it."
        actions={
          <div className="flex flex-wrap items-start gap-2">
            {scanTarget && can(role, "website.manage") && (
              <ActionButton action={scanWebsiteAction.bind(null, scanTarget.id)} label={latestScan ? "Rescan website" : "Analyse website"} pendingLabel="Analysing…" icon={<ScanSearch className="size-4" />} />
            )}
            {can(role, "profile.approve") &&
              (approved ? (
                <ActionButton action={reopenProfileAction.bind(null, id)} label="Move back to draft" pendingLabel="Saving…" icon={<RotateCcw className="size-4" />} variant="ghost" />
              ) : (
                <ActionButton action={approveProfileAction.bind(null, id)} label="Approve profile" pendingLabel="Approving…" icon={<BadgeCheck className="size-4" />} variant="primary" />
              ))}
          </div>
        }
      />

      <div className={cn("flex flex-col gap-1 rounded-xl border px-4 py-3 text-[13px]", approved ? "border-success/30 bg-success-soft text-success-ink" : "border-line bg-card")}>
        {approved ? (
          <p className="flex items-center gap-2 font-medium"><BadgeCheck className="size-4" /> Approved by {profile?.approved_by} on {fmtDateTime(profile!.approved_at!)}.</p>
        ) : (
          <p className="flex items-center gap-2 font-medium"><ClipboardCheck className="size-4 text-ink-3" /> Draft. Review the fields below, then approve.</p>
        )}
        {conflicts.length > 0 && <p className="flex items-center gap-2 text-warning-ink"><TriangleAlert className="size-4" /> Conflicting values to resolve: {conflicts.join(", ")}.</p>}
        {missing.length > 0 && <p className="text-ink-3">Not found on the website, add if you want them used: {missing.join(", ")}.</p>}
      </div>

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card>
            <CardHeader icon={FileSearch} title="Needs your review" description={`${toReview.length} of ${fields.length} fields`} />
            {toReview.length === 0 ? (
              <EmptyState icon={CheckCircle2} title="All fields confirmed">You can still edit them below.</EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {toReview.map((f) => (
                  <li key={f.field} className="px-5 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[13px] font-semibold">{f.label}</p>
                      <Badge tone={STATUS[f.status].tone}>{STATUS[f.status].text}</Badge>
                    </div>
                    <p className="mt-0.5 break-words text-xs text-ink-3">Current value: {display(f.value) ?? "not set"}</p>
                    {f.candidates.length > 0 && (
                      <ul className="mt-1 divide-y divide-line/60">
                        {f.candidates.slice(0, 6).map((c) => <FactRow key={c.id} fact={c} editable={editable} />)}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader icon={PencilLine} title="Edit profile" description="Saving marks every filled field as confirmed by you. A rescan never changes confirmed fields." />
            <div className="p-5">
              <ActionForm action={saveProfileAction.bind(null, id)} submitLabel="Save and confirm">
                <fieldset disabled={!editable} className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
                  <Field label="Business name"><input name="business_name" defaultValue={profile?.business_name ?? ""} maxLength={120} className={inputClass} /></Field>
                  <Field label="Website"><input name="website_url" defaultValue={profile?.website_url ?? ""} className={inputClass} placeholder="https://" /></Field>
                  <Field label="Domain"><input name="canonical_domain" defaultValue={profile?.canonical_domain ?? ""} className={inputClass} /></Field>
                  <Field label="Industry"><input name="industry" defaultValue={profile?.industry ?? ""} maxLength={120} className={inputClass} /></Field>
                  <Field label="Niche"><input name="niche" defaultValue={profile?.niche ?? ""} maxLength={120} className={inputClass} /></Field>
                  <Field label="Phone"><input name="phone" defaultValue={profile?.phone ?? ""} maxLength={40} className={inputClass} /></Field>
                  <Field label="Email"><input name="email" type="email" defaultValue={profile?.email ?? ""} className={inputClass} /></Field>
                  <Field label="City"><input name="city" defaultValue={profile?.city ?? ""} maxLength={120} className={inputClass} /></Field>
                  <Field label="State or region"><input name="region" defaultValue={profile?.region ?? ""} maxLength={120} className={inputClass} /></Field>
                  <Field label="Address" hint="Only a public business address."><input name="address" defaultValue={profile?.address ?? ""} maxLength={300} className={inputClass} /></Field>
                  <Field label="Business hours"><input name="hours" defaultValue={profile?.hours ?? ""} maxLength={500} className={inputClass} /></Field>
                  <Field label="Logo" hint="An https:// image link."><input name="logo_url" defaultValue={profile?.logo_url ?? ""} className={inputClass} /></Field>
                  <Field label="Services and products" hint="One per line.">
                    <textarea name="services" rows={5} defaultValue={profile?.services.join("\n") ?? ""} className={inputClass} />
                  </Field>
                  <Field label="Service areas" hint="Towns or regions, one per line.">
                    <textarea name="service_areas" rows={5} defaultValue={profile?.service_areas.join("\n") ?? ""} className={inputClass} />
                  </Field>
                  <Field label="Value proposition"><textarea name="value_proposition" rows={2} defaultValue={profile?.value_proposition ?? ""} maxLength={500} className={inputClass} /></Field>
                  <Field label="Tone of voice" hint="For example: friendly, local, no jargon."><input name="tone" defaultValue={profile?.tone ?? ""} maxLength={200} className={inputClass} /></Field>
                  <div className="md:col-span-2">
                    <Field label="Description"><textarea name="description" rows={3} defaultValue={profile?.description ?? ""} maxLength={2000} className={inputClass} /></Field>
                  </div>
                </fieldset>
              </ActionForm>
            </div>
          </Card>

          {lists.map((l) => (
            <Card key={l.kind}>
              <CardHeader icon={l.kind === "certification" || l.kind === "claim" || l.kind === "offer" ? Lock : FileSearch} title={l.label} description={l.facts.length ? `${l.facts.length} found` : "None found on the website"} />
              {l.facts.length > 0 && (
                <div className="px-5 pb-2">
                  {(l.kind === "certification" || l.kind === "claim" || l.kind === "offer") && (
                    <p className="pt-1 text-xs text-ink-3">Quoted word for word from the website. Confirm only what is true today; unconfirmed claims are never used.</p>
                  )}
                  <ul className="divide-y divide-line/60">
                    {l.facts.map((f) => <FactRow key={f.id} fact={f} editable={editable} />)}
                  </ul>
                </div>
              )}
            </Card>
          ))}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader icon={ScanSearch} title="Last analysis" />
            {!latestScan ? (
              <EmptyState icon={ScanSearch} title="Not analysed yet">
                {scanTarget ? "Analyse the website to fill this profile." : "Assign a website to this brand on the Websites page first."}
              </EmptyState>
            ) : (
              <div className="space-y-2 p-5 text-[13px]">
                <p>
                  <span className="font-medium capitalize">{latestScan.status}</span>{" "}
                  <span className="text-ink-3">· {timeAgo(latestScan.finished_at ?? latestScan.started_at)} by {latestScan.requested_by}</span>
                </p>
                {latestScan.error && <p className="text-danger-ink">{latestScan.error}</p>}
                <p className="text-ink-3">
                  {latestScan.pages_fetched} pages read, {latestScan.pages_skipped} skipped. robots.txt: {latestScan.report.robots ?? "n/a"}. AI suggestions: {latestScan.report.ai ?? "n/a"}.
                </p>
                {latestScan.report.pages && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-brand">Pages</summary>
                    <ul className="mt-2 space-y-1">
                      {latestScan.report.pages.map((p) => (
                        <li key={p.url} className="break-all">
                          {p.reason ? <span className="text-ink-3">Skipped {shortUrl(p.url)}: {p.reason}</span> : <span>{shortUrl(p.url)}</span>}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader icon={CheckCircle2} title="Confirmed" description={`${done.length} fields`} />
            {done.length === 0 ? (
              <EmptyState icon={CheckCircle2} title="Nothing confirmed yet">Use a value from the website or edit the profile.</EmptyState>
            ) : (
              <dl className="divide-y divide-line text-[13px]">
                {done.map((f) => (
                  <div key={f.field} className="px-5 py-2.5">
                    <dt className="text-xs text-ink-3">{f.label}</dt>
                    <dd className="break-words">{display(f.value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
