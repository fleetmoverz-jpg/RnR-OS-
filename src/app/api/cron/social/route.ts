import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { contentDeps } from "@/lib/social/content/server";
import { publishDeps } from "@/lib/social/publish/server";
import { runWorker } from "@/lib/social/automation/worker";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// The publishing queue worker. Called every 5 minutes by Supabase pg_cron (see docs/automation.md),
// with CRON_SECRET as a bearer token. Safe to call more often or twice at once.
async function handle(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${env.cronSecret()}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const stats = await runWorker(db(), { workerId: `cron:${randomUUID().slice(0, 8)}`, publish: publishDeps(), content: contentDeps(), budgetMs: 45_000 });
  // Counts only: error details stay in worker_runs and in each workspace's alerts.
  const { errors, ...counts } = stats;
  return NextResponse.json({ ok: errors.length === 0, ...counts, errors: errors.length });
}

export const GET = handle;
export const POST = handle;
