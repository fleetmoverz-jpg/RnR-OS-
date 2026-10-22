import "server-only";
import { env } from "../env";
import type { AnalysisDeps } from "./analysis";
import { claudeSuggester } from "./brandAi";
import { safeFetcher } from "./safeFetch";

// Production dependencies for website analysis: the SSRF-guarded fetcher and, when configured, Claude.
export function analysisDeps(): AnalysisDeps {
  const key = env.anthropicApiKey();
  let agent = "RnROsBot/1.0";
  try {
    agent = `RnROsBot/1.0 (+${env.appUrl()})`;
  } catch {
    // APP_URL is only used to identify the crawler.
  }
  return {
    fetcher: safeFetcher({ userAgent: agent, timeoutMs: 8000, maxBytes: 1_500_000, maxRedirects: 3 }),
    suggest: key ? claudeSuggester(key, env.anthropicModel()) : null,
    aiUnavailable: key ? undefined : "ANTHROPIC_API_KEY is not set",
    crawl: { maxPages: 12, concurrency: 3, budgetMs: 40_000 },
  };
}
