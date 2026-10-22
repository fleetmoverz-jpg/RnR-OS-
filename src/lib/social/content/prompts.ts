// Prompts and output schemas for topic planning and drafting. Bump a version whenever its prompt
// changes, so every stored generation says which prompt produced it.
import { CATEGORIES, CATEGORY_LABEL, PLATFORM_RULES, type Category } from "./rules";

export const PROMPT_VERSIONS = { topics: "topics-v1", drafts: "drafts-v1" } as const;

// Only approved, user-confirmed information reaches the model.
export type BrandBrief = {
  name: string;
  website: string | null;
  industry: string | null;
  niche: string | null;
  city: string | null;
  region: string | null;
  serviceAreas: string[];
  services: string[];
  description: string | null;
  valueProposition: string | null;
  tone: string | null;
  audience: string | null;
  phone: string | null;
  confirmedClaims: string[];
  articles: { title: string; url: string }[];
};

export type SourceForPrompt = { id: string; url: string; title: string | null; excerpt: string; retrieved_at: string; published_at: string | null };

function briefText(b: BrandBrief) {
  const line = (label: string, v: string | null | undefined | string[]) => (Array.isArray(v) ? (v.length ? `${label}: ${v.join("; ")}` : null) : v ? `${label}: ${v}` : null);
  return [
    line("Business", b.name),
    line("Website", b.website),
    line("Industry", b.industry),
    line("Niche", b.niche),
    line("Based in", [b.city, b.region].filter(Boolean).join(", ") || null),
    line("Service areas", b.serviceAreas),
    line("Services", b.services),
    line("Description", b.description),
    line("Why customers choose them", b.valueProposition),
    line("Audience", b.audience),
    line("Tone of voice", b.tone),
    line("Phone (only number allowed in posts)", b.phone),
    line("Confirmed claims and credentials (the ONLY ones allowed)", b.confirmedClaims),
    b.articles.length ? `Existing articles on the website:\n${b.articles.map((a) => `- ${a.title}: ${a.url}`).join("\n")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

const RULES = `Hard rules:
- Use only the facts in the brand brief and the numbered research sources. Model knowledge is not a source.
- Never invent weather, local events, statistics, prices, reviews, testimonials, customer stories, awards, licences, certifications or years in business.
- A claim or credential may appear only if it is listed under "Confirmed claims and credentials".
- Any number, statistic or time-sensitive statement must come from a research source; cite it by putting its id in used_source_ids.
- No engagement bait ("like if", "tag a friend", "comment YES"), no clickbait, no keyword stuffing, no fake urgency.
- Phone numbers: only the one in the brief. Links: only the brand's website or a cited source URL.
- Write original, useful content in the brand's tone. Each platform variant must be written for that platform, not copied.`;

export const TOPICS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topics"],
  properties: {
    topics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "category", "angle", "service", "location", "needs_research", "search_query"],
        properties: {
          title: { type: "string" },
          category: { type: "string", enum: [...CATEGORIES] },
          angle: { type: "string" },
          service: { type: "string" },
          location: { type: "string" },
          needs_research: { type: "boolean" },
          search_query: { type: "string" },
        },
      },
    },
  },
};

export function topicsPrompt(b: BrandBrief, opts: { count: number; categories: Category[]; recentTitles: string[]; avoid: string[] }) {
  const system = `You plan social media topics for a local business. ${RULES}
Return topics that help the business's customers: education, common questions, maintenance tips, seasonal advice, industry updates, service explainers and local relevance.
Set needs_research to true for anything that depends on current events, seasons, weather, regulations or numbers, and give a precise web search_query for it. Otherwise use an empty search_query.
"service" is one of the brand's services or an empty string. "location" is one of the brand's service areas or an empty string.`;
  const prompt = `${briefText(b)}

Suggest ${opts.count} new topics in these categories: ${opts.categories.map((c) => CATEGORY_LABEL[c]).join(", ")}.
Do not repeat or closely rephrase these recent topics:
${opts.recentTitles.length ? opts.recentTitles.map((t) => `- ${t}`).join("\n") : "- (none yet)"}
${opts.avoid.length ? `Avoid these subjects entirely: ${opts.avoid.join("; ")}` : ""}`;
  return { system, prompt };
}

export function draftsSchema(platforms: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "core_message", "variants", "used_source_ids"],
    properties: {
      title: { type: "string" },
      core_message: { type: "string" },
      used_source_ids: { type: "array", items: { type: "string" } },
      variants: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["platform", "body", "hashtags", "link_url", "call_to_action", "image_concept"],
          properties: {
            platform: { type: "string", enum: platforms },
            body: { type: "string" },
            hashtags: { type: "array", items: { type: "string" } },
            link_url: { type: "string" },
            call_to_action: { type: "string" },
            image_concept: { type: "string" },
          },
        },
      },
    },
  };
}

export function draftsPrompt(b: BrandBrief, opts: { topic: { title: string; angle: string | null; category: string | null }; platforms: string[]; tone: string | null; sources: SourceForPrompt[]; avoidOpenings: string[] }) {
  const platformText = opts.platforms
    .map((p) => {
      const r = PLATFORM_RULES[p];
      return `- ${p} (${r.label}): ${r.idealChars[0]}-${r.idealChars[1]} characters, max ${r.maxChars}; ${r.idealHashtags[0]}-${r.idealHashtags[1]} hashtags; links: ${r.links}. ${r.notes}`;
    })
    .join("\n");
  const system = `You write social media posts for a local business. ${RULES}
Write one variant per requested platform. Hashtags go in the hashtags array without "#", not in the body.
link_url is the brand's website page or an empty string. image_concept describes a simple, honest photo or graphic that fits the post (no text claims, no fake people or reviews).`;
  const sources = opts.sources.length
    ? `Research sources (cite by id):\n${opts.sources.map((s) => `[${s.id}] ${s.title ?? s.url} (${s.url}; retrieved ${s.retrieved_at.slice(0, 10)}${s.published_at ? `; published ${s.published_at.slice(0, 10)}` : ""})\n${s.excerpt}`).join("\n\n")}`
    : "Research sources: none. Do not include statistics, dates of events or anything time-sensitive.";
  const prompt = `${briefText(b)}

Topic: ${opts.topic.title}
${opts.topic.angle ? `Angle: ${opts.topic.angle}` : ""}
${opts.topic.category ? `Category: ${opts.topic.category}` : ""}
${opts.tone ? `Tone for this post: ${opts.tone}` : ""}

${sources}

Platforms:
${platformText}
${opts.avoidOpenings.length ? `\nDon't reuse these openings from recent posts:\n${opts.avoidOpenings.map((o) => `- ${o}`).join("\n")}` : ""}`;
  return { system, prompt };
}
