import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import { env } from "../env";

const COOKIE = "rnr_session";
const MAX_AGE = 60 * 60 * 24 * 30;

const key = () => new TextEncoder().encode(env.sessionSecret());

export async function createSession(email: string) {
  const token = await new SignJWT({ email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(key());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function destroySession() {
  (await cookies()).delete(COOKIE);
}

export async function getSessionEmail(): Promise<string | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    const email = typeof payload.email === "string" ? payload.email : null;
    // Re-check on every request so changing ALLOWED_EMAIL locks out old sessions.
    return email && email === env.allowedEmail() ? email : null;
  } catch {
    return null;
  }
}

export async function requireUser(): Promise<string> {
  const email = await getSessionEmail();
  if (!email) redirect("/login");
  return email;
}
