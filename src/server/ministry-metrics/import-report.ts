import type { ParsedWeek, ParseResult } from './parse-workbook.js';
import { resolveHighlightDate, sundaysInYear, type HighlightRule } from './calendar.js';

/**
 * Structured dry-run report for a workbook, shared by the command line
 * verifier and the in-app importer so both apply identical checks.
 */

export type ImportReport = {
  weekCount: number;
  dateRange: { first: string; last: string } | null;
  skippedSheets: string[];
  coverage: Array<{
    year: number;
    present: number;
    expected: number;
    missingInside: string[];
    missingOutside: string[];
  }>;
  schedules: Array<{ schedule: string; weeks: number; first: string; last: string }>;
  venues: Array<{ venue: string; weeks: number; first: string; last: string }>;
  highlights: Array<{ year: number; name: string; date: string; matched: boolean; note: string | null }>;
  corrections: Array<{ date: string; scope: string; severity: string; note: string }>;
  givingConflicts: ParseResult['givingConflicts'];
  problems: string[];
  totals: {
    adults: number;
    kids: number;
    giving: number;
    weeksNoService: number;
  };
};

const HIGHLIGHT_RULES: HighlightRule[] = [
  { key: 'easter', name: 'Easter', rule_type: 'computed_easter', rule_value: null },
  { key: 'church_birthday', name: 'Church Birthday', rule_type: 'sunday_nearest', rule_value: '09-16' },
  { key: 'christmas', name: 'Christmas', rule_type: 'sunday_before', rule_value: '12-25' },
];

function sumOf(week: ParsedWeek, field: 'adult_attendance' | 'kids_attendance' | 'online_attendance') {
  const parts = week.services
    .filter((s) => (field === 'online_attendance' ? true : s.kind === 'in_person'))
    .map((s) => s[field])
    .filter((v): v is number => typeof v === 'number');
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

function inPersonTotal(week: ParsedWeek) {
  const parts = week.services
    .filter((s) => s.kind === 'in_person')
    .flatMap((s) => [s.adult_attendance, s.kids_attendance])
    .filter((v): v is number => typeof v === 'number');
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function buildImportReport(result: ParseResult): ImportReport {
  const { weeks, skippedSheets, givingConflicts } = result;

  const years = [...new Set(weeks.map((w) => Number(w.service_date.slice(0, 4))))].sort();

  const coverage = years.map((year) => {
    const expected = sundaysInYear(year);
    const present = weeks
      .filter((w) => w.service_date.startsWith(String(year)))
      .map((w) => w.service_date)
      .sort();
    const first = present[0];
    const last = present[present.length - 1];
    const missing = expected.filter((d) => !present.includes(d));
    return {
      year,
      present: present.length,
      expected: expected.length,
      missingInside: missing.filter((d) => d > first && d < last),
      missingOutside: missing.filter((d) => d < first || d > last),
    };
  });

  const scheduleMap = new Map<string, string[]>();
  for (const w of weeks) {
    if (w.status !== 'held') continue;
    const key = w.services
      .map((s) => `${s.service_time}${s.kind === 'online_rebroadcast' ? '*' : ''}`)
      .join(' / ');
    if (!scheduleMap.has(key)) scheduleMap.set(key, []);
    scheduleMap.get(key)!.push(w.service_date);
  }
  const schedules = [...scheduleMap.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([schedule, dates]) => ({
      schedule,
      weeks: dates.length,
      first: dates[0],
      last: dates[dates.length - 1],
    }));

  const venueMap = new Map<string, string[]>();
  for (const w of weeks) {
    const v = w.venue ?? '(blank)';
    if (!venueMap.has(v)) venueMap.set(v, []);
    venueMap.get(v)!.push(w.service_date);
  }
  const venues = [...venueMap.entries()].map(([venue, dates]) => ({
    venue,
    weeks: dates.length,
    first: dates[0],
    last: dates[dates.length - 1],
  }));

  const highlights: ImportReport['highlights'] = [];
  for (const year of years) {
    for (const rule of HIGHLIGHT_RULES) {
      const date = resolveHighlightDate(rule, year);
      if (!date) continue;
      const week = weeks.find((w) => w.service_date === date);
      highlights.push({
        year,
        name: rule.name,
        date,
        matched: Boolean(week),
        note: week?.note ?? null,
      });
    }
  }

  const corrections = weeks.flatMap((w) =>
    w.issues.map((i) => ({
      date: w.service_date,
      scope: i.scope,
      severity: i.severity,
      note: i.note,
    }))
  );

  const medianInPerson = median(
    weeks.map((w) => inPersonTotal(w)).filter((v): v is number => v != null)
  );
  const medianOnline = median(
    weeks.map((w) => sumOf(w, 'online_attendance')).filter((v): v is number => v != null)
  );

  const problems: string[] = [];
  const seen = new Set<string>();
  for (const w of weeks) {
    if (seen.has(w.service_date)) problems.push(`${w.service_date}: appears on more than one sheet`);
    seen.add(w.service_date);

    if (w.status === 'no_service') continue;

    if (w.services.length === 0) problems.push(`${w.service_date}: no service columns found`);

    const hasAttendance = w.services.some(
      (s) => s.adult_attendance != null || s.kids_attendance != null || s.online_attendance != null
    );
    if (!hasAttendance) {
      problems.push(
        `${w.service_date}: no attendance recorded anywhere on the sheet${w.note ? ` (note: "${w.note}")` : ''}`
      );
    }

    const total = inPersonTotal(w);
    if (total != null && medianInPerson && (total < medianInPerson * 0.4 || total > medianInPerson * 2.5)) {
      problems.push(
        `${w.service_date}: in-person total of ${total} is far from the ${medianInPerson} median${w.note ? ` (note: "${w.note}")` : ''}`
      );
    }

    const onlineExplained = w.issues.some(
      (i) => i.scope === 'online_attendance' && i.severity === 'warning'
    );
    const online = sumOf(w, 'online_attendance');
    if (
      !onlineExplained &&
      online != null &&
      medianOnline &&
      (online < medianOnline * 0.2 || online > medianOnline * 3)
    ) {
      problems.push(`${w.service_date}: online total of ${online} is far from the ${medianOnline} median`);
    }

    const giving = w.giving?.tithes_offerings;
    if (giving != null && (giving < 1000 || giving > 250000)) {
      problems.push(`${w.service_date}: giving of ${giving} is outside the expected range`);
    }
  }

  const dates = weeks.map((w) => w.service_date).sort();

  return {
    weekCount: weeks.length,
    dateRange: dates.length ? { first: dates[0], last: dates[dates.length - 1] } : null,
    skippedSheets,
    coverage,
    schedules,
    venues,
    highlights,
    corrections,
    givingConflicts,
    problems,
    totals: {
      adults: weeks.reduce((a, w) => a + (sumOf(w, 'adult_attendance') ?? 0), 0),
      kids: weeks.reduce((a, w) => a + (sumOf(w, 'kids_attendance') ?? 0), 0),
      giving: weeks.reduce((a, w) => a + (w.giving?.tithes_offerings ?? 0), 0),
      weeksNoService: weeks.filter((w) => w.status === 'no_service').length,
    },
  };
}
