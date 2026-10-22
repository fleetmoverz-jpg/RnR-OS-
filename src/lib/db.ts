import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

let client: SupabaseClient | undefined;

// Single-user app: the server uses the service role key. It must never reach the browser.
export function db(): SupabaseClient {
  client ??= createClient(env.supabaseUrl(), env.supabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

// PostgREST caps responses (1000 rows by default), so page through larger results,
// a few pages at a time in parallel to keep round trips down.
export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
  parallel = 6,
): Promise<T[]> {
  // Most tables fit in one page, so ask for that first and only fan out when it comes back full.
  const first = await page(0, pageSize - 1);
  if (first.error) throw new Error(first.error.message);
  const rows: T[] = [...(first.data ?? [])];
  if (rows.length < pageSize) return rows;
  for (let start = pageSize; ; start += pageSize * parallel) {
    const batch = await Promise.all(
      Array.from({ length: parallel }, (_, k) => page(start + k * pageSize, start + (k + 1) * pageSize - 1)),
    );
    for (const { data, error } of batch) {
      if (error) throw new Error(error.message);
      rows.push(...(data ?? []));
      if (!data || data.length < pageSize) return rows;
    }
  }
}

export async function upsertInBatches(table: string, rows: object[], onConflict: string, size = 1000) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await db().from(table).upsert(rows.slice(i, i + size), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}
