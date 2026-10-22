import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "../db";
import { env } from "../env";
import { requireUser } from "../auth/session";
import { resolveWorkspace, socialRepo, SocialTablesMissing, type SocialRepo, type WorkspaceSummary } from "./repo";

export const WORKSPACE_COOKIE = "rnr_workspace";

// The signed-in person's active workspace and a repo scoped to it. Cached per request.
// The app owner (ALLOWED_EMAIL) gets a workspace created on first visit.
export const requireWorkspace = cache(async (): Promise<{ repo: SocialRepo; workspaces: WorkspaceSummary[] }> => {
  const email = await requireUser();
  const preferredId = (await cookies()).get(WORKSPACE_COOKIE)?.value ?? null;
  const resolved = await resolveWorkspace(db(), email, { preferredId, bootstrapOwner: email === env.allowedEmail() }).catch((e) => {
    if (e instanceof SocialTablesMissing) redirect("/social/setup");
    throw e;
  });
  if (!resolved) redirect("/login?error=denied");
  return { repo: socialRepo(db(), resolved.ctx), workspaces: resolved.workspaces };
});
