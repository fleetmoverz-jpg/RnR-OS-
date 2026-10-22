// Workspace Google connections: encrypted token storage, refresh, Search Console discovery, import and disconnect.
// Scoped to one workspace like repo.ts; Google calls go through the injected fetch so tests can mock them.
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret } from "./crypto";
import {
  GooglePermissionError,
  GoogleRateLimited,
  GoogleReauthRequired,
  listSites,
  PERMISSION_INFO,
  refreshAccessToken,
  revokeToken,
  type Fetch,
  type GrantedTokens,
  type OAuthClient,
  type PermissionLevel,
} from "./google";
import { assertCan, NotFound } from "./policy";
import type { SocialContext } from "./repo";
import { normalizeWebsite } from "./validation";

export type GoogleDeps = { fetch: Fetch; client: OAuthClient; encryptionKey: string; now?: () => Date; retryDelayMs?: number };

export type GoogleConnection = {
  id: string;
  google_email: string;
  scopes: string[];
  status: "active" | "needs_reconnect";
  last_error: string | null;
  last_discovered_at: string | null;
  connected_by: string;
  connected_at: string;
};

export type DiscoveredProperty = {
  id: string;
  connection_id: string;
  site_url: string;
  property_type: "domain" | "url_prefix";
  permission_level: PermissionLevel;
  discovered_at: string;
  imported_website_id: string | null;
};

type ConnectionRow = GoogleConnection & { access_token_enc: string | null; refresh_token_enc: string; access_token_expires_at: string | null };

// Columns that are safe to send to pages. Token columns are never selected outside this module.
const PUBLIC_COLUMNS = "id, google_email, scopes, status, last_error, last_discovered_at, connected_by, connected_at";

function check<T>({ data, error }: { data: T | null; error: { message: string } | null }): T {
  if (error) throw new Error(error.message);
  return data as T;
}

export function websiteFromProperty(siteUrl: string) {
  const site = normalizeWebsite(siteUrl);
  if (!site) return null;
  // Keep the URL-prefix exactly (scheme, host and path); a domain property covers every URL, shown as https.
  const url = siteUrl.startsWith("sc-domain:") ? site.url : siteUrl.replace(/\/$/, "");
  return { url, domain: site.domain };
}

export function googleService(client: SupabaseClient, ctx: SocialContext, deps: GoogleDeps) {
  const ws = ctx.workspaceId;
  const now = () => deps.now?.() ?? new Date();

  async function audit(action: string, entityId: string | null, details: Record<string, unknown>) {
    check(await client.from("audit_events").insert({ workspace_id: ws, actor_email: ctx.email, action, entity_type: "google_connection", entity_id: entityId, details }));
  }

  async function row(connectionId: string): Promise<ConnectionRow> {
    const r = check(await client.from("google_connections").select("*").eq("workspace_id", ws).eq("id", connectionId).maybeSingle()) as ConnectionRow | null;
    if (!r) throw new NotFound("Google connection");
    return r;
  }

  async function markNeedsReconnect(connectionId: string, message: string) {
    check(await client.from("google_connections").update({ status: "needs_reconnect", last_error: message, access_token_enc: null, access_token_expires_at: null }).eq("workspace_id", ws).eq("id", connectionId));
  }

  const service = {
    async listConnections() {
      assertCan(ctx.role, "workspace.view");
      return check(await client.from("google_connections").select(PUBLIC_COLUMNS).eq("workspace_id", ws).order("connected_at")) as GoogleConnection[];
    },

    // Called from the OAuth callback with tokens Google just issued. Reconnecting the same Google account updates it.
    async saveConnection(tokens: GrantedTokens): Promise<string> {
      assertCan(ctx.role, "account.connect");
      const saved = check(
        await client
          .from("google_connections")
          .upsert(
            {
              workspace_id: ws,
              google_sub: tokens.sub,
              google_email: tokens.email,
              scopes: tokens.scopes,
              access_token_enc: encryptSecret(tokens.accessToken, deps.encryptionKey),
              refresh_token_enc: encryptSecret(tokens.refreshToken, deps.encryptionKey),
              access_token_expires_at: tokens.expiresAt.toISOString(),
              status: "active",
              last_error: null,
              connected_by: ctx.email,
              connected_at: now().toISOString(),
            },
            { onConflict: "workspace_id,google_sub" },
          )
          .select("id")
          .single(),
      ) as { id: string };
      await audit("google_connection.connected", saved.id, { google_email: tokens.email, scopes: tokens.scopes });
      return saved.id;
    },

    // A valid access token, refreshed when it expires within a minute. Never leaves the server.
    async accessToken(connectionId: string): Promise<string> {
      const r = await row(connectionId);
      if (r.status === "needs_reconnect") throw new GoogleReauthRequired("This Google account needs to be connected again.");
      const expires = r.access_token_expires_at ? new Date(r.access_token_expires_at).getTime() : 0;
      if (r.access_token_enc && expires - now().getTime() > 60_000) return decryptSecret(r.access_token_enc, deps.encryptionKey);
      try {
        const fresh = await refreshAccessToken(deps.fetch, deps.client, decryptSecret(r.refresh_token_enc, deps.encryptionKey), now());
        const update: Record<string, unknown> = {
          access_token_enc: encryptSecret(fresh.accessToken, deps.encryptionKey),
          access_token_expires_at: fresh.expiresAt.toISOString(),
        };
        if (fresh.refreshToken) update.refresh_token_enc = encryptSecret(fresh.refreshToken, deps.encryptionKey);
        check(await client.from("google_connections").update(update).eq("workspace_id", ws).eq("id", connectionId));
        return fresh.accessToken;
      } catch (e) {
        if (e instanceof GoogleReauthRequired) await markNeedsReconnect(connectionId, e.message);
        throw e;
      }
    },

    // Fetches the properties from the Sites API and stores them as Google reported them.
    async discover(connectionId: string): Promise<{ count: number }> {
      assertCan(ctx.role, "website.manage");
      await row(connectionId);
      let sites;
      try {
        sites = await listSites(deps.fetch, await service.accessToken(connectionId), { retryDelayMs: deps.retryDelayMs });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof GoogleReauthRequired || e instanceof GooglePermissionError) await markNeedsReconnect(connectionId, message);
        else check(await client.from("google_connections").update({ last_error: message }).eq("workspace_id", ws).eq("id", connectionId));
        throw e;
      }

      const stamp = now().toISOString();
      if (sites.length) {
        check(
          await client.from("gsc_properties").upsert(
            sites.map((s) => ({ workspace_id: ws, connection_id: connectionId, site_url: s.siteUrl, property_type: s.propertyType, permission_level: s.permissionLevel, discovered_at: stamp })),
            { onConflict: "connection_id,site_url" },
          ),
        );
      }
      // Properties the account can no longer see are removed from the list.
      const returned = new Set(sites.map((s) => s.siteUrl));
      const stored = check(await client.from("gsc_properties").select("id, site_url").eq("workspace_id", ws).eq("connection_id", connectionId)) as { id: string; site_url: string }[];
      const gone = stored.filter((p) => !returned.has(p.site_url)).map((p) => p.id);
      if (gone.length) check(await client.from("gsc_properties").delete().eq("workspace_id", ws).in("id", gone));

      // Keep imported websites truthful: verified only while Google still reports siteOwner.
      const imported = check(await client.from("workspace_websites").select("id, gsc_property_url, verification_status").eq("workspace_id", ws).eq("google_connection_id", connectionId)) as {
        id: string;
        gsc_property_url: string;
        verification_status: string;
      }[];
      const levels = new Map(sites.map((s) => [s.siteUrl, s.permissionLevel]));
      for (const w of imported) {
        const level = levels.get(w.gsc_property_url) ?? null;
        const owner = level ? PERMISSION_INFO[level].verifiedOwner : false;
        check(
          await client
            .from("workspace_websites")
            .update({
              permission_level: level,
              verification_status: owner ? "verified" : "unverified",
              verification_method: owner ? "search_console" : null,
              verified_at: owner ? (w.verification_status === "verified" ? undefined : stamp) : null,
              last_checked_at: stamp,
            })
            .eq("workspace_id", ws)
            .eq("id", w.id),
        );
      }

      check(await client.from("google_connections").update({ status: "active", last_error: null, last_discovered_at: stamp }).eq("workspace_id", ws).eq("id", connectionId));
      await audit("google_connection.discovered", connectionId, { properties: sites.length });
      return { count: sites.length };
    },

    async listProperties(): Promise<DiscoveredProperty[]> {
      assertCan(ctx.role, "workspace.view");
      const [props, sites] = await Promise.all([
        client.from("gsc_properties").select("id, connection_id, site_url, property_type, permission_level, discovered_at").eq("workspace_id", ws).order("site_url"),
        client.from("workspace_websites").select("id, gsc_property_url").eq("workspace_id", ws).not("gsc_property_url", "is", null),
      ]);
      const importedBy = new Map((check(sites) as { id: string; gsc_property_url: string }[]).map((s) => [s.gsc_property_url, s.id]));
      return (check(props) as Omit<DiscoveredProperty, "imported_website_id">[]).map((p) => ({ ...p, imported_website_id: importedBy.get(p.site_url) ?? null }));
    },

    // Imports selected discovered properties as workspace websites. Already-imported properties are skipped.
    async importProperties(propertyIds: string[], brandId: string | null = null) {
      assertCan(ctx.role, "website.manage");
      if (brandId) {
        const b = check(await client.from("brands").select("id").eq("workspace_id", ws).eq("id", brandId).maybeSingle());
        if (!b) throw new NotFound("Brand");
      }
      const ids = [...new Set(propertyIds)];
      const props = ids.length
        ? (check(await client.from("gsc_properties").select("id, connection_id, site_url, property_type, permission_level").eq("workspace_id", ws).in("id", ids)) as Omit<DiscoveredProperty, "discovered_at" | "imported_website_id">[])
        : [];
      const result = { imported: [] as string[], skipped: [] as string[], notFound: ids.length - props.length };
      const stamp = now().toISOString();
      for (const p of props) {
        const site = websiteFromProperty(p.site_url);
        if (!site) {
          result.skipped.push(p.site_url);
          continue;
        }
        const owner = PERMISSION_INFO[p.permission_level].verifiedOwner;
        const { data, error } = await client
          .from("workspace_websites")
          .insert({
            workspace_id: ws,
            brand_id: brandId,
            url: site.url,
            domain: site.domain,
            gsc_property_url: p.site_url,
            property_type: p.property_type,
            permission_level: p.permission_level,
            google_connection_id: p.connection_id,
            verification_status: owner ? "verified" : "unverified",
            verification_method: owner ? "search_console" : null,
            verified_at: owner ? stamp : null,
            last_checked_at: stamp,
          })
          .select("id")
          .single();
        if (error?.code === "23505") {
          result.skipped.push(p.site_url);
          continue;
        }
        if (error) throw new Error(error.message);
        result.imported.push(p.site_url);
        check(
          await client.from("audit_events").insert({
            workspace_id: ws,
            actor_email: ctx.email,
            action: "website.added",
            entity_type: "website",
            entity_id: (data as { id: string }).id,
            details: { domain: site.domain, property: p.site_url, source: "search_console", permission_level: p.permission_level },
          }),
        );
      }
      return result;
    },

    // Revokes the grant at Google, then deletes the stored tokens and discovered properties.
    // Imported websites stay, unlinked from the connection.
    async disconnect(connectionId: string): Promise<{ revokedAtGoogle: boolean }> {
      assertCan(ctx.role, "account.connect");
      const r = await row(connectionId);
      let revokedAtGoogle = false;
      try {
        revokedAtGoogle = await revokeToken(deps.fetch, decryptSecret(r.refresh_token_enc, deps.encryptionKey));
      } catch {
        revokedAtGoogle = false;
      }
      check(await client.from("google_connections").delete().eq("workspace_id", ws).eq("id", connectionId));
      await audit("google_connection.disconnected", connectionId, { google_email: r.google_email, revoked_at_google: revokedAtGoogle });
      return { revokedAtGoogle };
    },
  };
  return service;
}

export type GoogleService = ReturnType<typeof googleService>;

// Message for the UI from any discovery or connection error.
export function describeGoogleError(e: unknown): string {
  if (e instanceof GoogleReauthRequired || e instanceof GooglePermissionError || e instanceof GoogleRateLimited) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
