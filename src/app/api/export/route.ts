import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/auth/session";
import { getSelection, displaySite } from "@/lib/selection";
import { getSiteInsights } from "@/lib/gsc/insights";

export const maxDuration = 300;

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// CSV of every query or page for the selected website and date range.
export async function GET(req: Request) {
  if (!(await getSessionEmail())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const type = new URL(req.url).searchParams.get("type") === "pages" ? "pages" : "queries";
  const { site, days } = await getSelection();
  if (!site) return NextResponse.json({ error: "no site" }, { status: 404 });
  const i = await getSiteInsights(site.id, days);
  if (!i) return NextResponse.json({ error: "no data" }, { status: 404 });

  const rows = (type === "pages" ? i.pages : i.queries).filter((r) => r.impressions > 0 || r.prev_impressions > 0);
  rows.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  const head = [type === "pages" ? "page" : "query", "clicks", "impressions", "ctr", "position", "prev_clicks", "prev_impressions", "prev_ctr", "prev_position"];
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push(
      [r.key, r.clicks, r.impressions, r.ctr.toFixed(4), r.position?.toFixed(2), r.prev_clicks, r.prev_impressions, r.prev_ctr.toFixed(4), r.prev_position?.toFixed(2)]
        .map(csvCell)
        .join(","),
    );
  }
  const name = `${displaySite(site.site_url).replace(/[^a-z0-9.-]+/gi, "_")}-${type}-${i.window.curStart}-to-${i.window.curEnd}.csv`;
  return new NextResponse(lines.join("\n"), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` },
  });
}
