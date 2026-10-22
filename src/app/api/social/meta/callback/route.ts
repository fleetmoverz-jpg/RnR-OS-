import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getSessionEmail } from "@/lib/auth/session";
import { resolveWorkspace } from "@/lib/social/repo";
import { can } from "@/lib/social/policy";
import { connectionService } from "@/lib/social/publish/connections";
import { PublishError } from "@/lib/social/publish/types";
import { connectionDeps, META_CALLBACK_PATH, META_COOKIE, openMetaState } from "@/lib/social/publish/server";

const to = (query: string) => NextResponse.redirect(`${env.appUrl()}/social/accounts?${query}`);

// Facebook sends the browser back here with a one-time code. Tokens are exchanged and stored server-side only.
export async function GET(req: NextRequest) {
  const jar = await cookies();
  const saved = await openMetaState(jar.get(META_COOKIE)?.value);
  jar.set(META_COOKIE, "", { path: META_CALLBACK_PATH, maxAge: 0 });

  const params = req.nextUrl.searchParams;
  if (!saved || params.get("state") !== saved.state) return to("meta_error=state");
  const email = await getSessionEmail();
  if (!email || email !== saved.email) return to("meta_error=session");
  if (params.get("error")) return to(`meta_error=${params.get("error_reason") === "user_denied" ? "denied" : "meta"}`);
  const code = params.get("code");
  if (!code) return to("meta_error=meta");

  const resolved = await resolveWorkspace(db(), email, { preferredId: saved.workspaceId });
  if (!resolved || resolved.ctx.workspaceId !== saved.workspaceId || !can(resolved.ctx.role, "account.connect")) return to("meta_error=forbidden");

  const deps = connectionDeps();
  const service = connectionService(db(), resolved.ctx, deps);
  let connectionId: string;
  try {
    connectionId = await service.saveConnection(await deps.provider.exchangeCode(code));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("Meta connect failed", e instanceof PublishError ? `${e.kind} ${e.code ?? ""}` : message.slice(0, 200));
    return to(`meta_error=exchange&detail=${encodeURIComponent(message.slice(0, 200))}`);
  }
  try {
    const { count } = await service.discover(connectionId);
    return to(`meta=connected&found=${count}`);
  } catch (e) {
    return to(`meta=connected&detail=${encodeURIComponent((e instanceof Error ? e.message : String(e)).slice(0, 200))}`);
  }
}
