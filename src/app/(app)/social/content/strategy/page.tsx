import { notFound } from "next/navigation";
import { Target } from "lucide-react";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/social/workspace";
import { can } from "@/lib/social/policy";
import { contentService } from "@/lib/social/content/service";
import { CATEGORIES, CATEGORY_LABEL, PLATFORM_RULES } from "@/lib/social/content/rules";
import { ButtonLink, Card, CardHeader, Field, inputClass, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { saveStrategyAction } from "../../actions";

export const metadata = { title: "Content Strategy" };

// Reading and saving the strategy never calls a model.
const NO_AI = { text: null, research: null, pricing: { inputPerMTok: null, outputPerMTok: null, researchPerCall: null } };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Checks({ name, options, checked }: { name: string; options: [string, string][]; checked: string[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2 text-[13px]">
      {options.map(([value, label]) => (
        <label key={value} className="flex items-center gap-1.5">
          <input type="checkbox" name={name} value={value} defaultChecked={checked.includes(value)} className="size-4 accent-brand" /> {label}
        </label>
      ))}
    </div>
  );
}

export default async function StrategyPage({ searchParams }: PageProps<"/social/content/strategy">) {
  const sp = await searchParams;
  const { repo } = await requireWorkspace();
  const brand = (await repo.listBrands()).find((b) => b.id === sp.brand);
  if (!brand) notFound();
  const strategy = await contentService(db(), repo.ctx, NO_AI).getStrategy(brand.id);
  const editable = can(repo.ctx.role, "brand.edit");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Content strategy"
        description={`What ${brand.name} posts about, where and how often. Topic planning and drafting follow this.`}
        actions={<ButtonLink href={`/social/content?brand=${brand.id}`} variant="secondary">Back to Content Studio</ButtonLink>}
      />
      <Card className="max-w-3xl">
        <CardHeader icon={Target} title={brand.name} />
        <div className="p-5">
          {!editable && <p className="mb-4 text-[13px] text-ink-3">Only editors can change the strategy.</p>}
          <fieldset disabled={!editable} className="min-w-0">
          <ActionForm action={saveStrategyAction.bind(null, brand.id)} submitLabel="Save strategy">
            <fieldset className="min-w-0">
              <legend className="mb-2 text-[13px] font-medium">Topic categories</legend>
              <Checks name="categories" options={CATEGORIES.map((c) => [c, CATEGORY_LABEL[c]])} checked={strategy.categories} />
            </fieldset>
            <fieldset className="min-w-0">
              <legend className="mb-2 text-[13px] font-medium">Platforms</legend>
              <Checks name="platforms" options={Object.entries(PLATFORM_RULES).map(([id, r]) => [id, r.label])} checked={strategy.platforms} />
            </fieldset>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Posts per week" hint="0 to 21.">
                <input name="posts_per_week" type="number" min={0} max={21} defaultValue={strategy.posts_per_week} className={inputClass} />
              </Field>
              <fieldset className="min-w-0">
                <legend className="mb-2 text-[13px] font-medium">Posting days</legend>
                <Checks name="preferred_days" options={DAYS.map((d, i) => [String(i), d])} checked={strategy.preferred_days.map(String)} />
              </fieldset>
            </div>
            <Field label="Audience" hint="Who the posts are for, e.g. homeowners in older houses.">
              <textarea name="audience" rows={2} maxLength={500} defaultValue={strategy.audience ?? ""} className={inputClass} />
            </Field>
            <Field label="Goals" hint="e.g. more inspection requests, answer common questions.">
              <textarea name="goals" rows={2} maxLength={500} defaultValue={strategy.goals ?? ""} className={inputClass} />
            </Field>
            <Field label="Tone" hint="Leave empty to use the tone from the brand profile.">
              <input name="tone_override" maxLength={200} defaultValue={strategy.tone_override ?? ""} className={inputClass} />
            </Field>
            <Field label="Topics to avoid" hint="One per line.">
              <textarea name="avoid_topics" rows={3} defaultValue={strategy.avoid_topics.join("\n")} className={inputClass} />
            </Field>
          </ActionForm>
          </fieldset>
        </div>
      </Card>
    </div>
  );
}
