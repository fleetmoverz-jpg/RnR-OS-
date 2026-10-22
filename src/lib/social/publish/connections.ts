// Meta connections and the social accounts made from them: encrypted token storage, discovery of
// Pages and Instagram accounts, adding them to brands, health checks, disconnect and revoke.
// Scoped to one workspace. Token columns are read only inside this module and the publishing service.
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret } from "../crypto";
import { assertCan, NotFound } from "../policy";
import type { SocialContext } from "../repo";
import type { Platform } from "../platforms";
import { permittedActions } from "./meta";
import { PublishError, type ConnectProvider, type ConnectedUser, type PublishAdapter } from "./types";

export type ConnectionDeps = { provider: ConnectProvider; adapters: Partial<Record<Platform, PublishAdapter>>; encryptionKey: string; now?: () => Date };

export type MetaConnection = {
  id: string;
  meta_user_name: string | null;
  scopes: string[];
  declined_scopes: string[];
  token_expires_at: string | null;
  status: "active" | "needs_reconnect" | "revoked";
  last_error: string | null;
  last_discovered_at: string | null;
  connected_by: string;
  connected_at: string;
};

export type MetaAsset = {
  id: string;
  connection_id: string;
  platform: "facebook_page" | "instagram";
  external_account_id: string;
  page_id: string;
  name: string;
  username: string | null;
  picture_url: string | null;
  tasks: string[];
  account_id: string | null;
  account_brand_id: string | null;
  account_status: string | null;
};

export type AccountRow = {
  id: string;
  brand_id: string;
  platform: Platform;
  external_account_id: string;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
  status: "connected" | "needs_reconnect" | "revoked" | "error";
  scopes: string[];
  permitted_actions: string[];
  rate_limited_until: string | null;
  meta_connection_id: string | null;
  last_error: string | null;
  last_checked_at: string | null;
  connected_at: string;
};

const CONNECTION_COLUMNS = "id, meta_user_name, scopes, declined_scopes, token_expires_at, status, last_error, last_discovered_at, connected_by, connected_at";
export const ACCOUNT_COLUMNS = "id, brand_id, platform, external_account_id, display_name, username, avatar_url, status, scopes, permitted_actions, rate_limited_until, meta_connection_id, last_error, last_checked_at, connected_at";

function check<T>({ data, error }: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as T;
}

// The decrypted token for one account, for the publishing service. Never returned to pages.
export async function accountCredential(client: SupabaseClient, workspaceId: string, accountId: string, encryptionKey: string) {
  const row = check(await client.from("social_account_credentials").select("access_token_enc").eq("workspace_id", workspaceId).eq("social_account_id", accountId).maybeSingle()) as { access_token_enc: string } | null;
  return row ? decryptSecret(row.access_token_enc, encryptionKey) : null;
}

export function connectionService(client: SupabaseClient, ctx: SocialContext, deps: ConnectionDeps) {
  const ws = ctx.workspaceId;
  const now = () => deps.now?.() ?? new Date();
  const enc = (s: string) => encryptSecret(s, deps.encryptionKey);

  async function audit(action: string, entityType: string, entityId: string | null, details: Record<string, unknown> = {}) {
    check(await client.from("audit_events").insert({ workspace_id: ws, actor_email: ctx.email, action, entity_type: entityType, entity_id: entityId, details }));
  }

  async function connection(id: string) {
    const c = check(await client.from("meta_connections").select(CONNECTION_COLUMNS).eq("workspace_id", ws).eq("id", id).maybeSingle()) as MetaConnection | null;
    if (!c) throw new NotFound("Meta connection");
    return c;
  }

  async function userToken(id: string) {
    const row = check(await client.from("meta_connection_credentials").select("user_token_enc").eq("workspace_id", ws).eq("connection_id", id).maybeSingle()) as { user_token_enc: string } | null;
    if (!row) throw new PublishError("auth", "This Meta connection has no stored token. Connect it again.");
    return decryptSecret(row.user_token_enc, deps.encryptionKey);
  }

  async function account(id: string) {
    const a = check(await client.from("social_accounts").select(ACCOUNT_COLUMNS).eq("workspace_id", ws).eq("id", id).maybeSingle()) as AccountRow | null;
    if (!a) throw new NotFound("Account");
    return a;
  }

  async function revokeAccountRow(a: AccountRow, reason: string) {
    check(await client.from("social_account_credentials").delete().eq("workspace_id", ws).eq("social_account_id", a.id));
    check(await client.from("social_accounts").update({ status: "revoked", last_error: reason, permitted_actions: [] }).eq("workspace_id", ws).eq("id", a.id));
  }

  const service = {
    async listConnections() {
      assertCan(ctx.role, "workspace.view");
      return check(await client.from("meta_connections").select(CONNECTION_COLUMNS).eq("workspace_id", ws).neq("status", "revoked").order("connected_at")) as MetaConnection[];
    },

    async listAssets(): Promise<MetaAsset[]> {
      assertCan(ctx.role, "workspace.view");
      const [assets, accounts] = await Promise.all([
        client.from("meta_assets").select("id, connection_id, platform, external_account_id, page_id, name, username, picture_url, tasks").eq("workspace_id", ws).order("name"),
        client.from("social_accounts").select("id, brand_id, platform, external_account_id, status").eq("workspace_id", ws).in("platform", ["facebook_page", "instagram"]),
      ]);
      const linked = check(accounts) as { id: string; brand_id: string; platform: string; external_account_id: string; status: string }[];
      return (check(assets) as Omit<MetaAsset, "account_id" | "account_brand_id" | "account_status">[]).map((a) => {
        const acc = linked.find((l) => l.platform === a.platform && l.external_account_id === a.external_account_id);
        return { ...a, account_id: acc?.id ?? null, account_brand_id: acc?.brand_id ?? null, account_status: acc?.status ?? null };
      });
    },

    async listAccounts(brandId?: string) {
      assertCan(ctx.role, "workspace.view");
      let q = client.from("social_accounts").select(ACCOUNT_COLUMNS).eq("workspace_id", ws).order("platform");
      if (brandId) q = q.eq("brand_id", brandId);
      return check(await q) as AccountRow[];
    },

    // Called from the OAuth callback. Reconnecting the same Facebook user updates the same connection.
    async saveConnection(user: ConnectedUser): Promise<string> {
      assertCan(ctx.role, "account.connect");
      const saved = check(
        await client
          .from("meta_connections")
          .upsert(
            {
              workspace_id: ws, meta_user_id: user.userId, meta_user_name: user.userName, scopes: user.scopes, declined_scopes: user.declined,
              token_expires_at: user.expiresAt?.toISOString() ?? null, status: "active", last_error: null, connected_by: ctx.email, connected_at: now().toISOString(),
            },
            { onConflict: "workspace_id,meta_user_id" },
          )
          .select("id")
          .single(),
      ) as { id: string };
      check(await client.from("meta_connection_credentials").upsert({ connection_id: saved.id, workspace_id: ws, user_token_enc: enc(user.token) }, { onConflict: "connection_id" }));
      await audit("meta_connection.connected", "meta_connection", saved.id, { scopes: user.scopes, declined: user.declined });
      return saved.id;
    },

    // Lists the Pages and Instagram accounts this login can reach. Accounts already added to a brand
    // get the fresh Page token and permissions; ones that disappeared lose their token.
    async discover(connectionId: string) {
      assertCan(ctx.role, "account.connect");
      const conn = await connection(connectionId);
      let found;
      try {
        found = await deps.provider.discover(await userToken(connectionId));
      } catch (e) {
        if (e instanceof PublishError && e.kind === "auth") {
          check(await client.from("meta_connections").update({ status: "needs_reconnect", last_error: e.message }).eq("workspace_id", ws).eq("id", connectionId));
        }
        throw e;
      }
      const keep: string[] = [];
      for (const d of found) {
        const asset = check(
          await client
            .from("meta_assets")
            .upsert(
              { workspace_id: ws, connection_id: connectionId, platform: d.platform, external_account_id: d.externalAccountId, page_id: d.pageId, name: d.name.slice(0, 200), username: d.username, picture_url: d.pictureUrl, tasks: d.tasks, discovered_at: now().toISOString() },
              { onConflict: "connection_id,platform,external_account_id" },
            )
            .select("id")
            .single(),
        ) as { id: string };
        keep.push(asset.id);
        check(await client.from("meta_asset_credentials").upsert({ asset_id: asset.id, workspace_id: ws, page_token_enc: enc(d.pageToken) }, { onConflict: "asset_id" }));
        const linked = check(await client.from("social_accounts").select(ACCOUNT_COLUMNS).eq("workspace_id", ws).eq("platform", d.platform).eq("external_account_id", d.externalAccountId).eq("meta_connection_id", connectionId).neq("status", "revoked").maybeSingle()) as AccountRow | null;
        if (linked) {
          check(await client.from("social_account_credentials").upsert({ social_account_id: linked.id, workspace_id: ws, access_token_enc: enc(d.pageToken) }, { onConflict: "social_account_id" }));
          check(await client.from("social_accounts").update({ status: "connected", last_error: null, display_name: d.name.slice(0, 200), username: d.username, avatar_url: d.pictureUrl, scopes: conn.scopes, permitted_actions: permittedActions(d.platform, conn.scopes, d.tasks) }).eq("workspace_id", ws).eq("id", linked.id));
        }
      }
      const stale = (check(await client.from("meta_assets").select("id, platform, external_account_id").eq("workspace_id", ws).eq("connection_id", connectionId)) as { id: string; platform: string; external_account_id: string }[]).filter((a) => !keep.includes(a.id));
      for (const s of stale) {
        check(await client.from("meta_assets").delete().eq("workspace_id", ws).eq("id", s.id));
        const gone = check(await client.from("social_accounts").select(ACCOUNT_COLUMNS).eq("workspace_id", ws).eq("platform", s.platform).eq("external_account_id", s.external_account_id).eq("meta_connection_id", connectionId).maybeSingle()) as AccountRow | null;
        if (gone && gone.status !== "revoked") {
          check(await client.from("social_account_credentials").delete().eq("workspace_id", ws).eq("social_account_id", gone.id));
          check(await client.from("social_accounts").update({ status: "needs_reconnect", last_error: "This login no longer has access to the account." }).eq("workspace_id", ws).eq("id", gone.id));
        }
      }
      check(await client.from("meta_connections").update({ last_discovered_at: now().toISOString(), status: "active", last_error: null }).eq("workspace_id", ws).eq("id", connectionId));
      await audit("meta_connection.discovered", "meta_connection", connectionId, { found: found.length, removed: stale.length });
      return { count: found.length };
    },

    // Turns a discovered Page or Instagram account into a social account of one brand.
    async addAccount(assetId: string, brandId: string) {
      assertCan(ctx.role, "account.connect");
      const asset = check(await client.from("meta_assets").select("*").eq("workspace_id", ws).eq("id", assetId).maybeSingle()) as (MetaAsset & { connection_id: string }) | null;
      if (!asset) throw new NotFound("Page or account");
      const brand = check(await client.from("brands").select("id, name, status").eq("workspace_id", ws).eq("id", brandId).maybeSingle()) as { id: string; name: string; status: string } | null;
      if (!brand) throw new NotFound("Brand");
      if (brand.status !== "active") throw new Error("Choose an active brand.");
      const conn = await connection(asset.connection_id);
      if (conn.status !== "active") throw new Error("Reconnect this Meta login first.");
      const tokenRow = check(await client.from("meta_asset_credentials").select("page_token_enc").eq("workspace_id", ws).eq("asset_id", assetId).maybeSingle()) as { page_token_enc: string } | null;
      if (!tokenRow) throw new Error("No access token for this Page. Refresh the list and try again.");
      const existing = check(await client.from("social_accounts").select(ACCOUNT_COLUMNS).eq("workspace_id", ws).eq("platform", asset.platform).eq("external_account_id", asset.external_account_id).maybeSingle()) as AccountRow | null;
      if (existing && existing.status !== "revoked" && existing.brand_id !== brandId) {
        // An account posts for one brand only, so a failing target is never silently swapped for another.
        throw new Error("This account is already connected to another brand. Disconnect it there first.");
      }
      const fields = {
        brand_id: brandId, display_name: asset.name, username: asset.username, avatar_url: asset.picture_url, status: "connected", scopes: conn.scopes,
        permitted_actions: permittedActions(asset.platform, conn.scopes, asset.tasks), meta_connection_id: asset.connection_id, last_error: null, connected_by: ctx.email, connected_at: now().toISOString(), token_expires_at: null,
      };
      const saved = existing
        ? (check(await client.from("social_accounts").update(fields).eq("workspace_id", ws).eq("id", existing.id).select("id").single()) as { id: string })
        : (check(await client.from("social_accounts").insert({ workspace_id: ws, platform: asset.platform, external_account_id: asset.external_account_id, ...fields }).select("id").single()) as { id: string });
      check(await client.from("social_account_credentials").upsert({ social_account_id: saved.id, workspace_id: ws, access_token_enc: tokenRow.page_token_enc }, { onConflict: "social_account_id" }));
      await audit("social_account.connected", "social_account", saved.id, { platform: asset.platform, brand_id: brandId, name: asset.name });
      return saved.id;
    },

    // Asks the platform whether the stored token still works.
    async checkAccount(accountId: string) {
      assertCan(ctx.role, "workspace.view");
      const a = await account(accountId);
      const adapter = deps.adapters[a.platform];
      if (!adapter) throw new Error("This platform can't be checked yet.");
      const token = await accountCredential(client, ws, a.id, deps.encryptionKey);
      if (!token) throw new Error("This account has no stored token. Connect it again.");
      try {
        const r = await adapter.checkAccount({ externalAccountId: a.external_account_id, token });
        check(await client.from("social_accounts").update({ status: "connected", last_error: null, last_checked_at: now().toISOString(), display_name: r.name.slice(0, 200) }).eq("workspace_id", ws).eq("id", a.id));
        return { ok: true as const, name: r.name };
      } catch (e) {
        if (!(e instanceof PublishError)) throw e;
        const status = e.kind === "auth" || e.kind === "permission" ? "needs_reconnect" : a.status;
        check(await client.from("social_accounts").update({ status, last_error: e.message.slice(0, 1000), last_checked_at: now().toISOString() }).eq("workspace_id", ws).eq("id", a.id));
        return { ok: false as const, message: e.message };
      }
    },

    // Removes the app's token for one account. The Meta login stays for other accounts.
    async disconnectAccount(accountId: string) {
      assertCan(ctx.role, "account.connect");
      const a = await account(accountId);
      await revokeAccountRow(a, "Disconnected in RnR Os.");
      await audit("social_account.disconnected", "social_account", a.id, { platform: a.platform });
    },

    // Revokes the app's permissions at Meta, then deletes every token from this login.
    async revokeConnection(connectionId: string) {
      assertCan(ctx.role, "account.connect");
      const conn = await connection(connectionId);
      let revokedAtMeta = false;
      let note: string | null = null;
      try {
        const id = (check(await client.from("meta_connections").select("meta_user_id").eq("workspace_id", ws).eq("id", connectionId).single()) as { meta_user_id: string }).meta_user_id;
        await deps.provider.revoke(await userToken(connectionId), id);
        revokedAtMeta = true;
      } catch (e) {
        // A token that's already invalid has nothing left to revoke; anything else is reported.
        if (!(e instanceof PublishError && e.kind === "auth")) note = e instanceof Error ? e.message : String(e);
      }
      const accounts = check(await client.from("social_accounts").select(ACCOUNT_COLUMNS).eq("workspace_id", ws).eq("meta_connection_id", connectionId)) as AccountRow[];
      for (const a of accounts) if (a.status !== "revoked") await revokeAccountRow(a, "The Meta login was disconnected.");
      check(await client.from("meta_assets").delete().eq("workspace_id", ws).eq("connection_id", connectionId));
      check(await client.from("meta_connection_credentials").delete().eq("workspace_id", ws).eq("connection_id", connectionId));
      check(await client.from("meta_connections").update({ status: "revoked", last_error: note }).eq("workspace_id", ws).eq("id", connectionId));
      await audit("meta_connection.revoked", "meta_connection", connectionId, { revoked_at_meta: revokedAtMeta, accounts: accounts.length, user: conn.meta_user_name });
      return { revokedAtMeta, note };
    },
  };
  return service;
}

export type ConnectionService = ReturnType<typeof connectionService>;
