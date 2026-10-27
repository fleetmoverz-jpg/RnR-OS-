// Wall-clock times in IANA time zones, and the posting slots of a weekly schedule. Pure, so the
// daylight-saving edge cases are unit-tested. All stored times are UTC; the zone is kept beside them.

export function isTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    formatters.set(tz, f);
  }
  return f;
}
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// The wall-clock reading in `tz` at instant `at`.
export function zonedParts(at: Date, tz: string): Parts {
  const p = Object.fromEntries(formatter(tz).formatToParts(at).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, weekday: WEEKDAY[p.weekday] };
}

const pad = (n: number) => String(n).padStart(2, "0");
export const localLabel = (at: Date, tz: string) => {
  const p = zonedParts(at, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
};

// Offset of `tz` from UTC at instant `at`, in minutes (Karachi = +300).
function offsetMinutes(at: Date, tz: string) {
  const p = zonedParts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

// The UTC instant for a wall-clock date and time in `tz`.
// A time skipped by a spring-forward change (02:30 in New York in March) moves forward by the gap.
// A time that happens twice in autumn resolves to the first occurrence.
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const candidates = new Set<number>();
  // The offsets in force a day either side cover every real-world transition.
  for (const probe of [wall - 864e5, wall, wall + 864e5]) candidates.add(offsetMinutes(new Date(probe), tz));
  const matches = [...candidates]
    .map((off) => wall - off * 60_000)
    .filter((t) => {
      const p = zonedParts(new Date(t), tz);
      return p.year === y && p.month === m && p.day === d && p.hour === hh && p.minute === mm;
    })
    .sort((a, b) => a - b);
  if (matches.length) return new Date(matches[0]);
  // Skipped wall time: use the offset from before the change, which lands after the gap.
  const before = offsetMinutes(new Date(wall - 864e5), tz);
  return new Date(wall - before * 60_000);
}

export type WeeklyRule = { daysOfWeek: number[]; times: string[]; postsPerWeek: number; timezone: string };
export type Slot = { runAt: Date; local: string; week: string };

// The Monday (local date) that starts the week containing a local date.
function weekOf(year: number, month: number, day: number) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
export const weekOfInstant = (at: Date, tz: string) => {
  const p = zonedParts(at, tz);
  return weekOf(p.year, p.month, p.day);
};

// Every slot of the rule after `from` and up to `from + days`, in time order, labelled with its
// local Monday-to-Sunday week. The planner applies postsPerWeek, counting posts already in each week.
export function upcomingSlots(rule: WeeklyRule, from: Date, days: number): Slot[] {
  const times = [...new Set(rule.times)].sort();
  const allowed = new Set(rule.daysOfWeek);
  const start = zonedParts(from, rule.timezone);
  const end = from.getTime() + days * 864e5;
  const out: Slot[] = [];
  for (let i = 0; i <= days + 1; i++) {
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    if (!allowed.has(day.getUTCDay())) continue;
    const date = day.toISOString().slice(0, 10);
    const week = weekOf(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
    for (const t of times) {
      const runAt = zonedToUtc(date, t, rule.timezone);
      if (runAt > from && runAt.getTime() <= end) out.push({ runAt, local: `${date} ${t}`, week });
    }
  }
  return out.sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
}

// Wait before retry n (1-based): 2, 4, 8 … minutes, capped at 6 hours, or what the platform asked for.
export function backoffSeconds(attempt: number, retryAfterSeconds?: number | null) {
  const exp = Math.min(6 * 3600, 120 * 2 ** Math.max(0, attempt - 1));
  return Math.max(exp, retryAfterSeconds ?? 0);
}

// Start of the current UTC day and month, for daily and monthly limits.
export const utcDayStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
export const utcMonthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
