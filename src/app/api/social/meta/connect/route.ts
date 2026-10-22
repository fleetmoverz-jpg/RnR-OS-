import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { requireWorkspace } from "@/lib/social/workspace";
import { can } from "@/lib/social/policy";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/social/limits";
import { randomState } from "@/lib/social/google";
import { connectionDeps, META_CALLBACK_PATH, META_COOKIE, metaSetupProblems, sealMetaState } from "@/lib/social/publish/server";

const back = (reason: string) => NextResponse.redirect(`${env.appUrl()}/social/accounts?meta_error=${reason}`);

// Starts "Connect Facebook & Instagram": the browser goes to Facebook's login dialog.
export async function GET() {
  const { repo } = await requireWorkspace();
  if (!can(repo.ctx.role, "account.connect")) return back("forbidden");
  if (metaSetupProblems().length) return back("not_configured");
  try {
    await rateLimit(db(), "connect", repo.ctx.email);
  } catch {
    return back("rate_limited");
  }
  const state = randomState();
  (await cookies()).set(META_COOKIE, await sealMetaState({ state, workspaceId: repo.ctx.workspaceId, email: repo.ctx.email }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: META_CALLBACK_PATH,
    maxAge: 600,
  });
  return NextResponse.redirect(connectionDeps().provider.authorizationUrl(state));
}
