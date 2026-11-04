import { initializeMetricsDb } from './db.js';

/** Read access for the Ministry Metrics dashboard. */

export type ServiceRow = {
  service_time: string;
  kind: 'in_person' | 'online_rebroadcast';
  adult_attendance: number | null;
  kids_attendance: number | null;
  online_attendance: number | null;
};

export type WeekRow = {
  service_date: string;
  status: string;
  venue: string | null;
  note: string | null;
  services: ServiceRow[];
  adults: number | null;
  kids: number | null;
  in_person: number | null;
  online: number | null;
  metrics: Record<string, number>;
  giving: {
    tithes_offerings: number | null;
    first_time_givers: number | null;
    first_time_givers_amount: number | null;
    donors_giving: number | null;
    tap_form_completions: number | null;
  } | null;
  highlights: Array<{ key: string; name: string; color: string | null; label: string | null }>;
  issues: Array<{ scope: string; severity: string; note: string }>;
};

/** Sums a field across services, returning null when nothing was recorded. */
function sumOrNull(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => typeof v === 'number');
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

export function getAvailableYears(): number[] {
  const db = initializeMetricsDb();
  const rows = db
    .prepare(`SELECT DISTINCT SUBSTR(service_date, 1, 4) AS year FROM mm_weeks ORDER BY year`)
    .all() as Array<{ year: string }>;
  return rows.map((r) => Number(r.year));
}

export function getMetricDefinitions() {
  const db = initializeMetricsDb();
  return db
    .prepare(
      `SELECT key, label, category, unit, zero_is_absent FROM mm_metric_definitions
       WHERE is_active = 1 ORDER BY display_order`
    )
    .all() as Array<{
    key: string;
    label: string;
    category: string;
    unit: string | null;
    zero_is_absent: number;
  }>;
}

export function getHighlightDefinitions() {
  const db = initializeMetricsDb();
  return db
    .prepare(
      `SELECT key, name, rule_type, rule_value, color, is_anchor
       FROM mm_highlights ORDER BY display_order`
    )
    .all() as Array<{
    key: string;
    name: string;
    rule_type: string;
    rule_value: string | null;
    color: string | null;
    is_anchor: number;
  }>;
}

export function getWeeks(years: number[]): WeekRow[] {
  const db = initializeMetricsDb();
  if (years.length === 0) return [];

  const placeholders = years.map(() => '?').join(', ');
  const yearStrings = years.map(String);

  const weeks = db
    .prepare(
      `SELECT id, service_date, status, venue, note
       FROM mm_weeks
       WHERE SUBSTR(service_date, 1, 4) IN (${placeholders})
       ORDER BY service_date`
    )
    .all(...yearStrings) as Array<{
    id: number;
    service_date: string;
    status: string;
    venue: string | null;
    note: string | null;
  }>;

  if (weeks.length === 0) return [];

  const ids = weeks.map((w) => w.id);
  const idPlaceholders = ids.map(() => '?').join(', ');

  const services = db
    .prepare(
      `SELECT week_id, service_time, kind, adult_attendance, kids_attendance, online_attendance
       FROM mm_services WHERE week_id IN (${idPlaceholders}) ORDER BY sort_order`
    )
    .all(...ids) as Array<ServiceRow & { week_id: number }>;

  const metrics = db
    .prepare(
      `SELECT week_id, metric_key, value FROM mm_week_metrics
       WHERE week_id IN (${idPlaceholders}) AND value IS NOT NULL`
    )
    .all(...ids) as Array<{ week_id: number; metric_key: string; value: number }>;

  const giving = db
    .prepare(
      `SELECT week_id, tithes_offerings, first_time_givers, first_time_givers_amount,
              donors_giving, tap_form_completions
       FROM mm_giving WHERE week_id IN (${idPlaceholders})`
    )
    .all(...ids) as Array<{ week_id: number } & NonNullable<WeekRow['giving']>>;

  const highlights = db
    .prepare(
      `SELECT wh.week_id, h.key, h.name, h.color, wh.label
       FROM mm_week_highlights wh
       JOIN mm_highlights h ON h.id = wh.highlight_id
       WHERE wh.week_id IN (${idPlaceholders})
       ORDER BY h.display_order`
    )
    .all(...ids) as Array<{
    week_id: number;
    key: string;
    name: string;
    color: string | null;
    label: string | null;
  }>;

  const issues = db
    .prepare(
      `SELECT week_id, scope, severity, note FROM mm_data_issues
       WHERE week_id IN (${idPlaceholders})`
    )
    .all(...ids) as Array<{ week_id: number; scope: string; severity: string; note: string }>;

  const byWeek = <T extends { week_id: number }>(rows: T[]) => {
    const map = new Map<number, T[]>();
    for (const r of rows) {
      if (!map.has(r.week_id)) map.set(r.week_id, []);
      map.get(r.week_id)!.push(r);
    }
    return map;
  };

  const servicesByWeek = byWeek(services);
  const metricsByWeek = byWeek(metrics);
  const highlightsByWeek = byWeek(highlights);
  const issuesByWeek = byWeek(issues);
  const givingByWeek = new Map(giving.map((g) => [g.week_id, g]));

  return weeks.map((w) => {
    const svc = (servicesByWeek.get(w.id) ?? []).map((s) => ({
      service_time: s.service_time,
      kind: s.kind,
      adult_attendance: s.adult_attendance,
      kids_attendance: s.kids_attendance,
      online_attendance: s.online_attendance,
    }));

    // The online rebroadcast is deliberately excluded from in-person figures.
    const inPersonServices = svc.filter((s) => s.kind === 'in_person');
    const adults = sumOrNull(inPersonServices.map((s) => s.adult_attendance));
    const kids = sumOrNull(inPersonServices.map((s) => s.kids_attendance));
    const inPerson = adults == null && kids == null ? null : (adults ?? 0) + (kids ?? 0);

    const g = givingByWeek.get(w.id);

    return {
      service_date: w.service_date,
      status: w.status,
      venue: w.venue,
      note: w.note,
      services: svc,
      adults,
      kids,
      in_person: inPerson,
      online: sumOrNull(svc.map((s) => s.online_attendance)),
      metrics: Object.fromEntries((metricsByWeek.get(w.id) ?? []).map((m) => [m.metric_key, m.value])),
      giving: g
        ? {
            tithes_offerings: g.tithes_offerings,
            first_time_givers: g.first_time_givers,
            first_time_givers_amount: g.first_time_givers_amount,
            donors_giving: g.donors_giving,
            tap_form_completions: g.tap_form_completions,
          }
        : null,
      highlights: (highlightsByWeek.get(w.id) ?? []).map((h) => ({
        key: h.key,
        name: h.name,
        color: h.color,
        label: h.label,
      })),
      issues: (issuesByWeek.get(w.id) ?? []).map((i) => ({
        scope: i.scope,
        severity: i.severity,
        note: i.note,
      })),
    };
  });
}

export type YearSummary = {
  year: number;
  weeks_held: number;
  weeks_no_service: number;
  avg_in_person: number | null;
  peak_in_person: { date: string; value: number } | null;
  total_adults: number;
  total_kids: number;
  total_giving: number | null;
  total_first_time_guests: number | null;
  total_baptisms: number | null;
  total_decisions: number | null;
};

export function getYearSummaries(years: number[]): YearSummary[] {
  const weeks = getWeeks(years);
  const byYear = new Map<number, WeekRow[]>();
  for (const w of weeks) {
    const y = Number(w.service_date.slice(0, 4));
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(w);
  }

  const sumMetric = (rows: WeekRow[], key: string) => {
    const values = rows.map((r) => r.metrics[key]).filter((v): v is number => typeof v === 'number');
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };

  return [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, rows]) => {
      const held = rows.filter((r) => r.status === 'held');
      const attended = held.filter((r) => r.in_person != null) as Array<WeekRow & { in_person: number }>;
      const peak = attended.reduce<{ date: string; value: number } | null>(
        (best, r) => (!best || r.in_person > best.value ? { date: r.service_date, value: r.in_person } : best),
        null
      );
      const givingValues = rows
        .map((r) => r.giving?.tithes_offerings)
        .filter((v): v is number => typeof v === 'number');

      return {
        year,
        weeks_held: held.length,
        weeks_no_service: rows.filter((r) => r.status === 'no_service').length,
        avg_in_person: attended.length
          ? Math.round(attended.reduce((a, r) => a + r.in_person, 0) / attended.length)
          : null,
        peak_in_person: peak,
        total_adults: held.reduce((a, r) => a + (r.adults ?? 0), 0),
        total_kids: held.reduce((a, r) => a + (r.kids ?? 0), 0),
        total_giving: givingValues.length ? givingValues.reduce((a, b) => a + b, 0) : null,
        total_first_time_guests: sumMetric(rows, 'first_time_guests'),
        total_baptisms: sumMetric(rows, 'baptisms'),
        total_decisions: sumMetric(rows, 'decisions'),
      };
    });
}
