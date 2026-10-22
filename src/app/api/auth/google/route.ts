import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authorizationUrl } from "@/lib/google/oauth";

export async function GET() {
  const state = crypto.randomUUID();
  (await cookies()).set("rnr_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return NextResponse.redirect(authorizationUrl(state));
}
