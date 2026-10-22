import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { exchangeCode, saveTokens } from "@/lib/google/oauth";
import { createSession } from "@/lib/auth/session";
import { discoverSites } from "@/lib/gsc/sync";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const fail = (reason: string) => NextResponse.redirect(`${env.appUrl()}/login?error=${reason}`);

  const jar = await cookies();
  const expected = jar.get("rnr_oauth_state")?.value;
  jar.delete("rnr_oauth_state");
  if (!expected || url.searchParams.get("state") !== expected) return fail("state");

  const code = url.searchParams.get("code");
  if (!code) return fail("google");

  try {
    const { email, tokens } = await exchangeCode(code);
    if (email !== env.allowedEmail()) return fail("denied");
    await saveTokens(email, tokens);
    await createSession(email);
    await discoverSites().catch(() => undefined); // listed on the dashboard; retry from there if this fails
  } catch (e) {
    console.error("OAuth callback failed", e);
    return fail("google");
  }
  return NextResponse.redirect(`${env.appUrl()}/search-console`);
}
