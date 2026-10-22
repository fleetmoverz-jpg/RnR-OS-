import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { syncAllSites } from "@/lib/gsc/sync";

export const maxDuration = 300;

// Called once a day by Vercel Cron (see vercel.json). Vercel sends CRON_SECRET as a bearer token.
export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${env.cronSecret()}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const results = await syncAllSites(220_000);
  return NextResponse.json({ results });
}
