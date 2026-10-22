import { FileText, PenSquare } from "lucide-react";
import { requireWorkspace } from "@/lib/social/workspace";
import { can } from "@/lib/social/policy";
import { ButtonLink, Card, CardHeader, EmptyState, PageHeader, Field, inputClass } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { ActionButton } from "@/components/ActionButton";
import { StatusBadge } from "@/components/social";
import { timeAgo } from "@/components/format";
import { createDraftAction, deleteDraftAction } from "../actions";

export const metadata = { title: "Content Studio" };

export default async function ContentStudioPage() {
  const { repo } = await requireWorkspace();
  const [brands, posts] = await Promise.all([repo.listBrands(), repo.listPosts()]);
  const brandName = new Map(brands.map((b) => [b.id, b.name]));
  const editable = can(repo.ctx.role, "post.edit");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Content Studio"
        description="Write and keep post drafts per brand. AI-written posts and per-platform versions arrive in a later phase."
      />

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader icon={FileText} title="Posts" description={`${posts.length} total`} />
          {posts.length === 0 ? (
            <EmptyState icon={FileText} title="No posts yet">Drafts you write appear here.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {posts.map((p) => (
                <li key={p.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{p.title}</span>
                      <StatusBadge status={p.status} />
                    </p>
                    {p.body && <p className="mt-1 line-clamp-2 text-[13px] text-ink-2">{p.body}</p>}
                    <p className="mt-1 text-xs text-ink-3">{brandName.get(p.brand_id) ?? "Archived brand"} · updated {timeAgo(p.updated_at)}</p>
                  </div>
                  {editable && p.status === "draft" && (
                    <ActionButton action={deleteDraftAction.bind(null, p.id)} label="Delete" pendingLabel="Deleting…" variant="ghost" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader icon={PenSquare} title="New draft" />
          <div className="p-5">
            {brands.length === 0 ? (
              <EmptyState icon={PenSquare} title="Create a brand first" action={<ButtonLink href="/social/brands" variant="primary">Go to Brands</ButtonLink>} />
            ) : !editable ? (
              <p className="text-[13px] text-ink-2">Viewers can read posts but not create them.</p>
            ) : (
              <ActionForm action={createDraftAction} submitLabel="Save draft" resetOnSuccess>
                <Field label="Brand">
                  <select name="brand_id" required className={inputClass}>
                    {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </Field>
                <Field label="Title"><input name="title" required maxLength={200} className={inputClass} /></Field>
                <Field label="Text"><textarea name="body" rows={6} maxLength={5000} className={inputClass} /></Field>
              </ActionForm>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
