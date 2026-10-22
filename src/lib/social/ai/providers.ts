// Model and research providers behind two small interfaces, so the content pipeline never depends on
// one vendor. Text generation and research/search are separate capabilities with separate keys.
// Every provider takes fetch, so tests run against mocked HTTP responses.
import Anthropic from "@anthropic-ai/sdk";

export type Fetch = typeof fetch;

export class ProviderError extends Error {
  name = "ProviderError";
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

// ---- text

export type TextRequest = { system: string; prompt: string; schema: Record<string, unknown>; schemaName: string; maxTokens: number };
export type TextResult = { data: unknown; model: string; inputTokens: number; outputTokens: number };
export interface TextProvider {
  id: string;
  model: string;
  generate(req: TextRequest): Promise<TextResult>;
}

export function anthropicText(apiKey: string, model: string, fetchFn?: Fetch): TextProvider {
  const client = new Anthropic({ apiKey, ...(fetchFn ? { fetch: fetchFn } : {}) });
  return {
    id: "anthropic",
    model,
    async generate(req) {
      let response;
      try {
        response = await client.messages.create({
          model,
          max_tokens: req.maxTokens,
          output_config: { format: { type: "json_schema", schema: req.schema } },
          system: req.system,
          messages: [{ role: "user", content: req.prompt }],
        });
      } catch (e) {
        const status = (e as { status?: number }).status ?? null;
        throw new ProviderError(`Claude request failed${status ? ` (${status})` : ""}: ${e instanceof Error ? e.message : String(e)}`, status);
      }
      if (response.stop_reason === "refusal") throw new ProviderError("The model declined this request.");
      if (response.stop_reason === "max_tokens") throw new ProviderError("The model ran out of output tokens.");
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return { data: JSON.parse(text), model: response.model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    },
  };
}

// xAI (Grok) and other providers with an OpenAI-compatible Chat Completions API and JSON-schema output.
// xAI docs: https://docs.x.ai/docs/guides/structured-outputs
export function openAiCompatibleText(opts: { id: string; baseUrl: string; apiKey: string; model: string; fetch?: Fetch }): TextProvider {
  const fetchFn = opts.fetch ?? fetch;
  return {
    id: opts.id,
    model: opts.model,
    async generate(req) {
      const res = await fetchFn(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: req.maxTokens,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.prompt },
          ],
          response_format: { type: "json_schema", json_schema: { name: req.schemaName, schema: req.schema, strict: true } },
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        if (res.status === 401 || res.status === 403) throw new ProviderError(`${opts.id} rejected the API key (${res.status}).`, res.status);
        if (res.status === 429) throw new ProviderError(`${opts.id} is rate limiting requests. Try again shortly.`, 429);
        throw new ProviderError(`${opts.id} returned ${res.status}: ${detail.slice(0, 200)}`, res.status);
      }
      const body = (await res.json()) as { model?: string; choices?: { message?: { content?: string; refusal?: string | null }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const choice = body.choices?.[0];
      if (choice?.message?.refusal) throw new ProviderError("The model declined this request.");
      if (choice?.finish_reason === "length") throw new ProviderError("The model ran out of output tokens.");
      const content = choice?.message?.content;
      if (!content) throw new ProviderError(`${opts.id} returned no content.`);
      return { data: JSON.parse(content), model: body.model ?? opts.model, inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 };
    },
  };
}

// ---- research

export type ResearchResult = { url: string; title: string | null; snippet: string; publishedAt: string | null; publisher: string | null };
export interface ResearchProvider {
  id: string;
  search(query: string, opts?: { maxResults?: number; recentDays?: number }): Promise<ResearchResult[]>;
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};

async function researchFetch(fetchFn: Fetch, id: string, url: string, init: RequestInit) {
  const res = await fetchFn(url, init);
  if (res.status === 401 || res.status === 403) throw new ProviderError(`${id} rejected the API key (${res.status}).`, res.status);
  if (res.status === 429) throw new ProviderError(`${id} is rate limiting requests. Try again shortly.`, 429);
  if (!res.ok) throw new ProviderError(`${id} returned ${res.status}.`, res.status);
  return res.json();
}

// Brave Search API. Docs: https://api-dashboard.search.brave.com/app/documentation/web-search/get-started
export function braveSearch(apiKey: string, fetchFn: Fetch = fetch): ResearchProvider {
  return {
    id: "brave",
    async search(query, opts = {}) {
      const params = new URLSearchParams({ q: query, count: String(opts.maxResults ?? 5), safesearch: "strict" });
      if (opts.recentDays) params.set("freshness", opts.recentDays <= 7 ? "pw" : opts.recentDays <= 31 ? "pm" : "py");
      const body = (await researchFetch(fetchFn, "Brave Search", `https://api.search.brave.com/res/v1/web/search?${params}`, {
        headers: { accept: "application/json", "x-subscription-token": apiKey },
      })) as { web?: { results?: { url: string; title?: string; description?: string; page_age?: string; profile?: { name?: string } }[] } };
      return (body.web?.results ?? [])
        .filter((r) => /^https?:\/\//.test(r.url) && r.description)
        .map((r) => ({ url: r.url, title: r.title ? stripTags(r.title) : null, snippet: stripTags(r.description!), publishedAt: r.page_age ?? null, publisher: r.profile?.name ?? hostOf(r.url) }));
    },
  };
}

// Tavily Search API. Docs: https://docs.tavily.com/documentation/api-reference/endpoint/search
export function tavilySearch(apiKey: string, fetchFn: Fetch = fetch): ResearchProvider {
  return {
    id: "tavily",
    async search(query, opts = {}) {
      const body = (await researchFetch(fetchFn, "Tavily", "https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query, max_results: opts.maxResults ?? 5, search_depth: "basic", include_answer: false, ...(opts.recentDays ? { days: opts.recentDays, topic: "news" } : {}) }),
      })) as { results?: { url: string; title?: string; content?: string; published_date?: string }[] };
      return (body.results ?? [])
        .filter((r) => /^https?:\/\//.test(r.url) && r.content)
        .map((r) => ({ url: r.url, title: r.title ?? null, snippet: r.content!.replace(/\s+/g, " ").trim(), publishedAt: r.published_date ?? null, publisher: hostOf(r.url) }));
    },
  };
}

// ---- cost

export type Pricing = { inputPerMTok: number | null; outputPerMTok: number | null; researchPerCall: number | null };

// Null when prices aren't configured: the app never makes up a cost.
export function estimateCost(p: Pricing, inputTokens: number, outputTokens: number): number | null {
  if (p.inputPerMTok == null || p.outputPerMTok == null) return null;
  return Math.round(((inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000) * 1e6) / 1e6;
}
