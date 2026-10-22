import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getSessionEmail } from "@/lib/auth/session";
import { resolveWorkspace } from "@/lib/social/repo";
import { can } from "@/lib/social/policy";
import { exchangeCode, GooglePermissionError } from "@/lib/social/google";
import { describeGoogleError, googleService } from "@/lib/social/googleConnections";
import { googleDeps, OAUTH_COOKIE, CALLBACK_PATH, openOAuthState } from "@/lib/social/googleServer";

const to = (query: string) => NextResponse.redirect(`${env.appUrl()}/social/websites?${query}`);

// Google sends the browser back here with a one-time code. Tokens are exchanged and stored server-side only.
export async function GET(req: NextRequest) {
  const jar = await cookies();
  const saved = await openOAuthState(jar.get(OAUTH_COOKIE)?.value);
  jar.set(OAUTH_COOKIE, "", { path: CALLBACK_PATH, maxAge: 0 });

  const params = req.nextUrl.searchParams;
  if (!saved || params.get("state") !== saved.state) return to("google_error=state");
  // The person who started the flow must still be signed in and still allowed to connect accounts there.
  const email = await getSessionEmail();
  if (!email || email !== saved.email) return to("google_error=session");
  if (params.get("error")) return to(`google_error=${params.get("error") === "access_denied" ? "denied" : "google"}`);
  const code = params.get("code");
  if (!code) return to("google_error=google");

  const resolved = await resolveWorkspace(db(), email, { preferredId: saved.workspaceId });
  if (!resolved || resolved.ctx.workspaceId !== saved.workspaceId || !can(resolved.ctx.role, "account.connect")) return to("google_error=forbidden");

  const deps = googleDeps();
  const service = googleService(db(), resolved.ctx, deps);
  let connectionId: string;
  try {
    connectionId = await service.saveConnection(await exchangeCode(deps.fetch, deps.client, code, saved.verifier));
  } catch (e) {
    console.error("Google connect failed", describeGoogleError(e));
    return to(e instanceof GooglePermissionError ? "google_error=scope" : `google_error=exchange&detail=${encodeURIComponent(describeGoogleError(e).slice(0, 200))}`);
  }
  // Discover straight away; if Google is slow or rate limited, the page offers a retry.
  try {
    const { count } = await service.discover(connectionId);
    return to(`google=connected&found=${count}`);
  } catch (e) {
    return to(`google=connected&detail=${encodeURIComponent(describeGoogleError(e).slice(0, 200))}`);
  }
}
