import { BarChart3, Database, Globe, RefreshCw } from "lucide-react";
import type { Compared, SiteInsights } from "@/lib/gsc/insights";
import type { Site } from "@/lib/gsc/sync";
import { discoverSitesAction, syncSiteAction } from "@/app/(app)/actions";
import { ActionButton } from "./ActionButton";
import { Sparkline } from "./charts/Sparkline";
import type { Row } from "./DataTable";
import { Delta, fmtDate, fmtNum, fmtPct, fmtPos } from "./format";
import { Card, cn, EmptyState, InfoTip } from "./ui";

export const toRows = (list: Compared[], label?: (key: string) => string): Row[] =>
  list.map((r) => ({ ...r, label: label?.(r.key) }));

// Highest-value rows first, capped so pages stay light when a site has tens of thousands of queries.
export const topRows = (list: Compared[], n: number) =>
  [...list].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, n);

export const currentOnly = (list: Compared[]) => list.filter((r) => r.impressions > 0);

export function hasFullComparison(i: SiteInsights) {
  return i.firstDate <= i.window.prevStart;
}

export function PeriodLine({ i }: { i: SiteInsights }) {
  return (
    <span>
      {fmtDate(i.window.curStart)} – {fmtDate(i.window.curEnd)}
      <span className="text-ink-3"> · compared with {fmtDate(i.window.prevStart)} – {fmtDate(i.window.prevEnd)}</span>
      {!hasFullComparison(i) && <span className="text-warning-ink"> (partial: data starts {fmtDate(i.firstDate)})</span>}
    </span>
  );
}

export function SyncButton({ site, variant = "secondary" }: { site: Site; variant?: "primary" | "secondary" }) {
  return (
    <ActionButton
      action={syncSiteAction.bind(null, site.id)}
      label="Refresh data"
      pendingLabel="Syncing… this can take a few minutes"
      icon={<RefreshCw className="size-4" />}
      variant={variant}
    />
  );
}

export function NoSiteState() {
  return (
    <Card>
      <EmptyState
        icon={Globe}
        title="No websites yet"
        action={<ActionButton action={discoverSitesAction} label="Load my Search Console sites" pendingLabel="Loading…" variant="primary" align="start" />}
      >
        Load the properties from your Google Search Console account to get started.
      </EmptyState>
    </Card>
  );
}

export function NoDataState({ site }: { site: Site }) {
  return (
    <Card>
      <EmptyState icon={Database} title="No search data yet" action={<SyncButton site={site} variant="primary" />}>
        {site.last_sync_error
          ? `The last sync failed: ${site.last_sync_error.slice(0, 200)}`
          : "Run the first sync to import up to 6 months of Search Console data. After that it updates every day on its own."}
      </EmptyState>
    </Card>
  );
}

type Kpi = {
  label: string;
  value: string;
  prevValue: string;
  help: string;
  delta: React.ReactNode;
  spark: number[];
  color: string;
  invert?: boolean;
};

export function KpiGrid({ i }: { i: SiteInsights }) {
  const hasPrev = i.prevTotals.impressions > 0;
  const t = i.totals;
  const p = i.prevTotals;
  const kpis: Kpi[] = [
    {
      label: "Total clicks",
      value: fmtNum(t.clicks),
      prevValue: fmtNum(p.clicks),
      help: "How many times someone clicked through to your site from Google Search.",
      delta: <Delta cur={t.clicks} prev={p.clicks} hasPrev={hasPrev} />,
      spark: i.daily.map((d) => d.clicks),
      color: "var(--chart-clicks)",
    },
    {
      label: "Total impressions",
      value: fmtNum(t.impressions),
      prevValue: fmtNum(p.impressions),
      help: "How many times your pages appeared in Google Search results.",
      delta: <Delta cur={t.impressions} prev={p.impressions} hasPrev={hasPrev} />,
      spark: i.daily.map((d) => d.impressions),
      color: "var(--chart-impressions)",
    },
    {
      label: "Average CTR",
      value: fmtPct(t.ctr),
      prevValue: fmtPct(p.ctr),
      help: "Click-through rate: clicks divided by impressions.",
      delta: <Delta cur={t.ctr} prev={p.ctr} mode="points" hasPrev={hasPrev} />,
      spark: i.daily.map((d) => d.ctr),
      color: "var(--chart-ctr)",
    },
    {
      label: "Average position",
      value: fmtPos(t.position),
      prevValue: fmtPos(p.position),
      help: "Average ranking of your pages in Google. A lower number is a better ranking (1 is the top).",
      delta:
        t.position != null && p.position != null ? (
          <Delta cur={t.position} prev={p.position} mode="absolute" digits={1} lowerIsBetter />
        ) : (
          <Delta cur={0} prev={0} hasPrev={false} />
        ),
      spark: i.daily.filter((d) => d.impressions > 0).map((d) => d.position),
      color: "var(--chart-position)",
      invert: true,
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {kpis.map((k) => (
        <Card key={k.label} className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-1.5 whitespace-nowrap text-[13px] font-medium text-ink-2">
              {k.label}
              <InfoTip text={k.help} />
            </div>
            <Sparkline values={k.spark} color={k.color} invert={k.invert} width={64} height={24} />
          </div>
          <p className="mt-2 text-metric font-semibold tracking-tight tabular-nums">{k.value}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2">
            {k.delta}
            {hasPrev && <span className="text-xs text-ink-3 tabular-nums">vs {k.prevValue}</span>}
          </div>
        </Card>
      ))}
    </div>
  );
}

// Share-of-clicks list for countries and devices.
export function ShareList({ rows, label }: { rows: Compared[]; label: (key: string) => string }) {
  const total = rows.reduce((s, r) => s + r.clicks, 0) || 1;
  const list = topRows(currentOnly(rows), 8);
  if (list.length === 0) {
    return <EmptyState icon={BarChart3} title="No data yet">This breakdown fills in after the next sync.</EmptyState>;
  }
  return (
    <ul className="divide-y divide-line/70">
      {list.map((r) => (
        <li key={r.key} className="flex items-center gap-4 px-5 py-3">
          <span className="w-36 shrink-0 truncate text-[13px] font-medium">{label(r.key)}</span>
          <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-subtle">
            <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${(r.clicks / total) * 100}%` }} />
          </span>
          <span className="w-16 shrink-0 text-right text-[13px] tabular-nums">{fmtNum(r.clicks)}</span>
          <span className={cn("w-16 shrink-0 text-right")}>
            <Delta cur={r.clicks} prev={r.prev_clicks} hasPrev={r.prev_impressions > 0} />
          </span>
        </li>
      ))}
    </ul>
  );
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
// Search Console returns ISO 3166-1 alpha-3 codes; map the common ones to names.
const A3_TO_A2: Record<string, string> = {
  usa: "US", gbr: "GB", can: "CA", aus: "AU", ind: "IN", pak: "PK", deu: "DE", fra: "FR", esp: "ES", ita: "IT",
  nld: "NL", irl: "IE", nzl: "NZ", zaf: "ZA", are: "AE", sau: "SA", bra: "BR", mex: "MX", phl: "PH", sgp: "SG",
  mys: "MY", idn: "ID", nga: "NG", ken: "KE", egy: "EG", tur: "TR", pol: "PL", swe: "SE", nor: "NO", dnk: "DK",
  fin: "FI", bel: "BE", che: "CH", aut: "AT", prt: "PT", jpn: "JP", kor: "KR", chn: "CN", hkg: "HK", twn: "TW",
  vnm: "VN", tha: "TH", bgd: "BD", lka: "LK", npl: "NP", arg: "AR", col: "CO", chl: "CL", per: "PE", rus: "RU",
  ukr: "UA", isr: "IL", qat: "QA", kwt: "KW", omn: "OM", bhr: "BH", jor: "JO", mar: "MA", gha: "GH", rou: "RO",
  cze: "CZ", hun: "HU", grc: "GR",
};
export function countryName(code: string) {
  const a2 = A3_TO_A2[code.toLowerCase()];
  if (!a2) return code.toUpperCase();
  try {
    return regionNames.of(a2) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}
export const deviceName = (d: string) => d.charAt(0) + d.slice(1).toLowerCase();
