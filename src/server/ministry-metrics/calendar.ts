/**
 * Resolves recurring special Sundays to actual dates for a given year.
 *
 * All dates are handled in UTC and formatted as YYYY-MM-DD. Using UTC avoids
 * the off-by-one-day shifts that come from constructing local-time dates and
 * then formatting them, which matters because every date here is a calendar
 * date with no time component.
 */

export type HighlightRule = {
  key: string;
  name: string;
  rule_type: string;
  rule_value: string | null;
};

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseIsoDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/** Meeus/Jones/Butcher algorithm for Gregorian Easter Sunday. */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/** The last Sunday strictly before the given MM-DD in that year. */
export function sundayBefore(year: number, monthDay: string): Date {
  const [mm, dd] = monthDay.split('-').map(Number);
  const target = new Date(Date.UTC(year, mm - 1, dd));
  const dow = target.getUTCDay();
  // A target that already falls on Sunday still resolves to the prior Sunday,
  // since the rule is "the Sunday before Christmas Day".
  return addDays(target, dow === 0 ? -7 : -dow);
}

/** The Sunday closest to the given MM-DD, looking both directions. */
export function sundayNearest(year: number, monthDay: string): Date {
  const [mm, dd] = monthDay.split('-').map(Number);
  const target = new Date(Date.UTC(year, mm - 1, dd));
  const dow = target.getUTCDay();
  if (dow === 0) return target;
  const previous = addDays(target, -dow);
  const next = addDays(target, 7 - dow);
  const toPrevious = dow;
  const toNext = 7 - dow;
  return toPrevious <= toNext ? previous : next;
}

export function resolveHighlightDate(rule: HighlightRule, year: number): string | null {
  switch (rule.rule_type) {
    case 'computed_easter':
      return toIsoDate(easterSunday(year));
    case 'sunday_before':
      return rule.rule_value ? toIsoDate(sundayBefore(year, rule.rule_value)) : null;
    case 'sunday_nearest':
      return rule.rule_value ? toIsoDate(sundayNearest(year, rule.rule_value)) : null;
    case 'manual':
      return null;
    default:
      return null;
  }
}

/** Every Sunday in a year, in order. */
export function sundaysInYear(year: number): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(year, 0, 1));
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
  while (d.getUTCFullYear() === year) {
    out.push(toIsoDate(d));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}
