import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { requireWorkspace } from "@/lib/social/workspace";
import { can } from "@/lib/social/policy";
import { authorizationUrl, createPkce, randomState } from "@/lib/social/google";
import { googleDeps, googleSetupProblems, OAUTH_COOKIE, CALLBACK_PATH, sealOAuthState } from "@/lib/social/googleServer";

const back = (reason: string) => NextResponse.redirect(`${env.appUrl()}/social/websites?google_error=${reason}`);

// Starts "Connect Google account": the browser is sent to Google's consent screen.
export async function GET() {
  const { repo } = await requireWorkspace();
  if (!can(repo.ctx.role, "account.connect")) return back("forbidden");
  if (googleSetupProblems().length) return back("not_configured");

  const { verifier, challenge } = createPkce();
  const state = randomState();
  (await cookies()).set(OAUTH_COOKIE, await sealOAuthState({ state, verifier, workspaceId: repo.ctx.workspaceId, email: repo.ctx.email }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: CALLBACK_PATH,
    maxAge: 600,
  });
  return NextResponse.redirect(authorizationUrl(googleDeps().client, state, challenge));
}
