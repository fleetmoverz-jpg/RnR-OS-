// Small queue helpers shared by publishing, content editing and the worker.
import type { SupabaseClient } from "@supabase/supabase-js";

// Jobs that still hold a slot in the queue.
export const QUEUED = ["pending", "claimed", "paused"] as const;

function check<T>({ data, error }: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as T;
}

// Takes a post's waiting jobs out of the queue, e.g. because it was edited and needs approval again.
// A job that is being published right now (claimed) is left alone.
export async function cancelPostJobs(client: SupabaseClient, ws: string, postId: string, reason: string) {
  const variants = check(await client.from("post_variants").select("id").eq("workspace_id", ws).eq("post_id", postId)) as { id: string }[];
  if (!variants.length) return 0;
  const ids = variants.map((v) => v.id);
  const cancelled = check(
    await client.from("scheduled_jobs").update({ status: "cancelled", last_error: reason.slice(0, 1000) }).eq("workspace_id", ws).in("variant_id", ids).in("status", ["pending", "paused"]).select("id"),
  ) as { id: string }[];
  check(await client.from("post_variants").update({ status: "approved" }).eq("workspace_id", ws).in("id", ids).eq("status", "scheduled"));
  return cancelled.length;
}

export type NewNotification = {
  brand_id?: string | null;
  kind: string;
  severity: "info" | "warning" | "error";
  title: string;
  body?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  // The same unread alert (same key) is raised only once.
  dedupe_key?: string | null;
};

export async function notify(client: SupabaseClient, ws: string, n: NewNotification) {
  const { error } = await client.from("notifications").insert({
    workspace_id: ws,
    brand_id: n.brand_id ?? null,
    kind: n.kind,
    severity: n.severity,
    title: n.title.slice(0, 200),
    body: n.body?.slice(0, 1000) ?? null,
    entity_type: n.entity_type ?? null,
    entity_id: n.entity_id ?? null,
    dedupe_key: n.dedupe_key?.slice(0, 200) ?? null,
  });
  if (error && error.code !== "23505") throw new Error(error.message);
}
