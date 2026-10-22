import "server-only";
import { env } from "../../env";
import { anthropicText, braveSearch, openAiCompatibleText, tavilySearch, type Pricing, type ResearchProvider, type TextProvider } from "../ai/providers";
import type { ContentDeps } from "./service";

const num = (name: string) => {
  const v = process.env[name];
  return v && Number.isFinite(Number(v)) ? Number(v) : null;
};

// Picks the text and research providers from environment variables. Keys never leave the server.
//   CONTENT_AI_PROVIDER = anthropic (default) | xai | openai_compatible
//   RESEARCH_PROVIDER   = brave | tavily (optional)
export function contentProviders(): { text: TextProvider | null; textReason?: string; research: ResearchProvider | null; researchReason?: string; pricing: Pricing } {
  const provider = (process.env.CONTENT_AI_PROVIDER || "anthropic").toLowerCase();
  const model = process.env.CONTENT_AI_MODEL;
  let text: TextProvider | null = null;
  let textReason: string | undefined;
  if (provider === "anthropic") {
    const key = env.anthropicApiKey();
    if (key) text = anthropicText(key, model || env.anthropicModel());
    else textReason = "ANTHROPIC_API_KEY is not set";
  } else if (provider === "xai") {
    if (!process.env.XAI_API_KEY) textReason = "XAI_API_KEY is not set";
    else if (!model) textReason = "CONTENT_AI_MODEL is not set (choose a Grok model from the xAI console)";
    else text = openAiCompatibleText({ id: "xai", baseUrl: process.env.XAI_BASE_URL || "https://api.x.ai/v1", apiKey: process.env.XAI_API_KEY, model });
  } else if (provider === "openai_compatible") {
    if (!process.env.OPENAI_COMPATIBLE_BASE_URL || !process.env.OPENAI_COMPATIBLE_API_KEY || !model) textReason = "OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_API_KEY and CONTENT_AI_MODEL are required";
    else text = openAiCompatibleText({ id: "openai_compatible", baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL, apiKey: process.env.OPENAI_COMPATIBLE_API_KEY, model });
  } else {
    textReason = `CONTENT_AI_PROVIDER "${provider}" isn't supported`;
  }

  const rp = (process.env.RESEARCH_PROVIDER || "").toLowerCase();
  let research: ResearchProvider | null = null;
  let researchReason: string | undefined;
  if (rp === "brave") {
    if (process.env.BRAVE_SEARCH_API_KEY) research = braveSearch(process.env.BRAVE_SEARCH_API_KEY);
    else researchReason = "BRAVE_SEARCH_API_KEY is not set";
  } else if (rp === "tavily") {
    if (process.env.TAVILY_API_KEY) research = tavilySearch(process.env.TAVILY_API_KEY);
    else researchReason = "TAVILY_API_KEY is not set";
  } else {
    researchReason = rp ? `RESEARCH_PROVIDER "${rp}" isn't supported` : "RESEARCH_PROVIDER is not set";
  }

  const pricing = { inputPerMTok: num("AI_PRICE_INPUT_PER_MTOK"), outputPerMTok: num("AI_PRICE_OUTPUT_PER_MTOK"), researchPerCall: num("RESEARCH_PRICE_PER_CALL") };
  return { text, textReason, research, researchReason, pricing };
}

export function contentDeps(): ContentDeps {
  const p = contentProviders();
  return { text: p.text, research: p.research, pricing: p.pricing, textUnavailable: p.textReason, researchUnavailable: p.researchReason };
}
