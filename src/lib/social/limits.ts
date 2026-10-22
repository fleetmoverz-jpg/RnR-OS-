// Request limits for expensive or sensitive actions, counted in the database so they hold across
// serverless instances. A fixed window per key: e.g. 20 AI calls per 10 minutes per person.
import type { SupabaseClient } from "@supabase/supabase-js";

export class RateLimited extends Error {
  name = "RateLimited";
}

export const LIMITS = {
  ai: { limit: 20, windowSeconds: 600, message: "Too many AI requests in a short time. Wait a few minutes and try again." },
  publish: { limit: 30, windowSeconds: 600, message: "Too many publishing requests in a short time. Wait a few minutes and try again." },
  connect: { limit: 10, windowSeconds: 600, message: "Too many sign-in attempts. Wait a few minutes and try again." },
  worker: { limit: 6, windowSeconds: 600, message: "The queue was run several times just now. Wait a few minutes." },
} as const;
export type LimitName = keyof typeof LIMITS;

export async function rateLimit(client: SupabaseClient, name: LimitName, who: string, now?: Date) {
  const l = LIMITS[name];
  const { data, error } = await client.rpc("social_rate_limit", { p_key: `${name}:${who}`, p_limit: l.limit, p_window_seconds: l.windowSeconds, ...(now ? { p_now: now.toISOString() } : {}) });
  if (error) throw new Error(error.message);
  if (data !== true) throw new RateLimited(l.message);
}
