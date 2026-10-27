// Server-side error logging that never writes credentials. Vercel keeps these in its function logs.

// Strips anything that looks like a credential: token parameters, Meta/OpenAI/Google token shapes, bearer headers.
export const scrub = (s: string) =>
  s
    .replace(/(access_token|appsecret_proof|client_secret|refresh_token|api_key|key)=[^&\s"']+/gi, "$1=[redacted]")
    .replace(/\b(EA[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|ya29\.[A-Za-z0-9._-]{16,})\b/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");

export const errorText = (e: unknown) => scrub(e instanceof Error ? e.message : String(e));

// One JSON line per error, so the logs can be searched by scope.
export function logError(scope: string, e: unknown, context: Record<string, string | number | boolean | null> = {}) {
  console.error(JSON.stringify({ level: "error", scope, message: errorText(e), name: e instanceof Error ? e.name : typeof e, ...context, at: new Date().toISOString() }));
}
