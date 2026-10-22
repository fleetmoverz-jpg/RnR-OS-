// All dates are YYYY-MM-DD strings in UTC, matching what Search Console returns.
export function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

export function today() {
  return isoDate(new Date());
}

// The latest `days` days of data and the same number of days before them.
export function comparisonWindows(latest: string, days = 28) {
  return {
    days,
    curStart: addDays(latest, -(days - 1)),
    curEnd: latest,
    prevStart: addDays(latest, -(2 * days - 1)),
    prevEnd: addDays(latest, -days),
  };
}

export type Windows = ReturnType<typeof comparisonWindows>;

export function* chunks(start: string, end: string, size: number) {
  for (let s = start; s <= end; s = addDays(s, size)) {
    const e = addDays(s, size - 1);
    yield { start: s, end: e < end ? e : end };
  }
}
