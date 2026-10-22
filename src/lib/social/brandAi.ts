// AI suggestions for the descriptive parts of a brand profile: industry, niche, tone, value proposition
// and a short description. Contact details, credentials and claims are never asked of the model.
import Anthropic from "@anthropic-ai/sdk";
import type { Candidate } from "./extract";

export type SuggestInput = { domain: string; pages: { url: string; title: string | null; text: string }[] };
export type SuggestFn = (input: SuggestInput) => Promise<Candidate[]>;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["industry", "niche", "tone", "value_proposition", "description"],
  properties: {
    industry: { type: "string" },
    niche: { type: "string" },
    tone: { type: "string" },
    value_proposition: { type: "string" },
    description: { type: "string" },
  },
};

const SYSTEM = `You read the text of a small business website and describe the business for its owner to review.
Use only what the pages say. Leave a field as an empty string if the pages don't support it.
- industry: the broad industry, 1-4 words (for example "Home services", "Dental care").
- niche: the specific specialty, 2-6 words (for example "Roof leak repair").
- tone: how the website writes, as 3-6 comma-separated adjectives.
- value_proposition: one sentence on why customers choose them, paraphrasing the site, max 200 characters.
- description: 1-2 plain sentences describing the business, max 300 characters.
Never add phone numbers, addresses, prices, credentials, awards, reviews, years in business or claims that are not on the pages.`;

const KIND = { industry: "industry", niche: "niche", tone: "tone", value_proposition: "usp", description: "description" } as const;

export function pageDigest(input: SuggestInput, limit = 12_000) {
  let budget = limit;
  const parts: string[] = [];
  for (const p of input.pages) {
    if (budget <= 0) break;
    const chunk = `# ${p.title ?? p.url}\n${p.url}\n${p.text.slice(0, Math.min(3000, budget))}`;
    parts.push(chunk);
    budget -= chunk.length;
  }
  return `Website: ${input.domain}\n\n${parts.join("\n\n")}`;
}

export function suggestionsToCandidates(parsed: Record<string, unknown>, model: string): Candidate[] {
  return Object.entries(KIND).flatMap(([field, kind]) => {
    const value = typeof parsed[field] === "string" ? (parsed[field] as string).trim().slice(0, 500) : "";
    return value ? [{ kind, value, label: `Suggested by ${model}`, source_url: null, source_quote: null, origin: "ai_suggestion" as const, confidence: null }] : [];
  });
}

export function claudeSuggester(apiKey: string, model: string): SuggestFn {
  const client = new Anthropic({ apiKey });
  return async (input) => {
    const response = await client.messages.create({
      model,
      max_tokens: 2000,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: pageDigest(input) }],
    });
    if (response.stop_reason === "refusal") return [];
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return suggestionsToCandidates(JSON.parse(text), response.model);
  };
}
