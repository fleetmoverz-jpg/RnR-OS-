import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { exchangeCode, saveTokens } from "@/lib/google/oauth";
import { createSession } from "@/lib/auth/session";
import { discoverSites } from "@/lib/gsc/sync";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const fail = (reason: string, detail?: string) =>
    NextResponse.redirect(
      `${env.appUrl()}/login?error=${reason}${detail ? `&detail=${encodeURIComponent(detail.slice(0, 300))}` : ""}`,
    );

  const jar = await cookies();
  const expected = jar.get("rnr_oauth_state")?.value;
  jar.delete("rnr_oauth_state");
  if (!expected || url.searchParams.get("state") !== expected) return fail("state");

  const code = url.searchParams.get("code");
  if (!code) return fail("google");

  let step = "exchanging the Google code";
  try {
    const { email, tokens } = await exchangeCode(code);
    if (email !== env.allowedEmail()) return fail("denied");
    step = "saving tokens to Supabase";
    await saveTokens(email, tokens);
    step = "creating the session";
    await createSession(email);
    await discoverSites().catch(() => undefined); // listed on the dashboard; retry from there if this fails
  } catch (e) {
    console.error("OAuth callback failed", e);
    // Error text from Google, Supabase or a missing env var name; never contains secret values.
    return fail("google", `Failed while ${step}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return NextResponse.redirect(`${env.appUrl()}/overview`);
}
