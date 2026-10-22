// Text and research providers against mocked HTTP. No real API is called.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { braveSearch, estimateCost, openAiCompatibleText, ProviderError, tavilySearch, type Fetch } from "../src/lib/social/ai/providers";

function mockFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: Fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fn, calls };
}

const req = { system: "sys", prompt: "hi", schema: { type: "object" }, schemaName: "drafts", maxTokens: 100 };

describe("xAI / OpenAI-compatible text", () => {
  test("sends a strict JSON-schema request with a bearer key and reads usage", async () => {
    const m = mockFetch(200, { model: "grok-test", choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 5 } });
    const p = openAiCompatibleText({ id: "xai", baseUrl: "https://api.x.ai/v1/", apiKey: "k", model: "grok-test", fetch: m.fn });
    const r = await p.generate(req);
    assert.deepEqual(r, { data: { ok: true }, model: "grok-test", inputTokens: 12, outputTokens: 5 });
    assert.equal(m.calls[0].url, "https://api.x.ai/v1/chat/completions");
    assert.equal((m.calls[0].init.headers as Record<string, string>).authorization, "Bearer k");
    const sent = JSON.parse(String(m.calls[0].init.body));
    assert.equal(sent.response_format.type, "json_schema");
    assert.equal(sent.response_format.json_schema.strict, true);
    assert.deepEqual(sent.messages.map((x: { role: string }) => x.role), ["system", "user"]);
  });

  test("turns auth, rate limit, refusal and truncation into clear errors", async () => {
    const make = (status: number, body: unknown) => openAiCompatibleText({ id: "xai", baseUrl: "https://api.x.ai/v1", apiKey: "k", model: "m", fetch: mockFetch(status, body).fn });
    await assert.rejects(make(401, "no").generate(req), (e: ProviderError) => e.status === 401 && /rejected the API key/.test(e.message));
    await assert.rejects(make(429, "slow").generate(req), /rate limiting/);
    await assert.rejects(make(200, { choices: [{ message: { refusal: "no" } }] }).generate(req), /declined/);
    await assert.rejects(make(200, { choices: [{ message: { content: "{" }, finish_reason: "length" }] }).generate(req), /ran out of output tokens/);
    await assert.rejects(make(200, { choices: [] }).generate(req), /returned no content/);
  });
});

describe("research providers", () => {
  test("Brave sends the key header and keeps URL, title, snippet and date", async () => {
    const m = mockFetch(200, {
      web: {
        results: [
          { url: "https://news.test/a", title: "<strong>Storm</strong> season", description: "Hail &amp; wind expected", page_age: "2026-10-01T00:00:00", profile: { name: "News" } },
          { url: "javascript:alert(1)", title: "bad", description: "x" },
          { url: "https://empty.test", title: "no snippet" },
        ],
      },
    });
    const r = await braveSearch("key", m.fn).search("storm austin", { maxResults: 3, recentDays: 30 });
    assert.deepEqual(r, [{ url: "https://news.test/a", title: "Storm season", snippet: "Hail & wind expected", publishedAt: "2026-10-01T00:00:00", publisher: "News" }]);
    assert.match(m.calls[0].url, /q=storm\+austin/);
    assert.match(m.calls[0].url, /freshness=pm/);
    assert.equal((m.calls[0].init.headers as Record<string, string>)["x-subscription-token"], "key");
  });

  test("Tavily posts the query and maps results", async () => {
    const m = mockFetch(200, { results: [{ url: "https://www.gov.test/rule", title: "New rule", content: "  Permits  now required ", published_date: "2026-09-01" }] });
    const r = await tavilySearch("key", m.fn).search("permits", { recentDays: 365 });
    assert.deepEqual(r, [{ url: "https://www.gov.test/rule", title: "New rule", snippet: "Permits now required", publishedAt: "2026-09-01", publisher: "gov.test" }]);
    const sent = JSON.parse(String(m.calls[0].init.body));
    assert.equal(sent.query, "permits");
    assert.equal(sent.days, 365);
  });

  test("bad keys are reported, not swallowed", async () => {
    await assert.rejects(braveSearch("k", mockFetch(403, {}).fn).search("q"), /rejected the API key/);
    await assert.rejects(tavilySearch("k", mockFetch(500, {}).fn).search("q"), /returned 500/);
  });
});

describe("cost", () => {
  test("is unknown without prices and computed with them", () => {
    assert.equal(estimateCost({ inputPerMTok: null, outputPerMTok: 15, researchPerCall: null }, 1000, 1000), null);
    assert.equal(estimateCost({ inputPerMTok: 3, outputPerMTok: 15, researchPerCall: null }, 1_000_000, 100_000), 4.5);
  });
});
