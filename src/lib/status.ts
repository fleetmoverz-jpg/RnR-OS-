import "server-only";
import { db } from "./db";
import { env } from "./env";

export type ConnectionStatus = {
  google: "connected" | "missing";
  googleUpdatedAt: string | null;
  scope: string | null;
  claude: boolean;
  lastSyncAt: string | null;
  failingSites: number;
};

export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const [{ data: account }, { data: sites }] = await Promise.all([
    db().from("google_accounts").select("updated_at, scope").eq("email", env.allowedEmail()).maybeSingle(),
    db().from("sites").select("last_synced_at, last_sync_error, enabled"),
  ]);
  const enabled = (sites ?? []).filter((s) => s.enabled);
  const lastSyncAt = enabled.map((s) => s.last_synced_at as string | null).filter(Boolean).sort().pop() ?? null;
  return {
    google: account ? "connected" : "missing",
    googleUpdatedAt: account?.updated_at ?? null,
    scope: account?.scope ?? null,
    claude: Boolean(env.anthropicApiKey()),
    lastSyncAt,
    failingSites: enabled.filter((s) => s.last_sync_error).length,
  };
}
