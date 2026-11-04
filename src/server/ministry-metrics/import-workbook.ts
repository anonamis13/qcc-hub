import type Database from 'better-sqlite3';
import { initializeMetricsDb } from './db.js';
import { parseWorkbook, type ParsedWeek } from './parse-workbook.js';
import { resolveHighlightDate, sundaysInYear, type HighlightRule } from './calendar.js';

/**
 * Writes a parsed workbook into the Ministry Metrics database.
 *
 * Re-running is safe: weeks are keyed by service_date and every write is an
 * upsert, so importing the same file twice produces the same result.
 */

export type ImportSummary = {
  weeksInserted: number;
  weeksUpdated: number;
  servicesWritten: number;
  metricsWritten: number;
  givingWritten: number;
  highlightsAttached: number;
  issuesRecorded: number;
  noServiceWeeks: string[];
};

export async function importWorkbook(
  filePath: string,
  options: { importedBy?: string } = {}
): Promise<ImportSummary> {
  const db = initializeMetricsDb();
  const { weeks } = await parseWorkbook(filePath);
  const now = Date.now();
  const importedBy = options.importedBy ?? 'workbook-import';

  const summary: ImportSummary = {
    weeksInserted: 0,
    weeksUpdated: 0,
    servicesWritten: 0,
    metricsWritten: 0,
    givingWritten: 0,
    highlightsAttached: 0,
    issuesRecorded: 0,
    noServiceWeeks: [],
  };

  const selectWeek = db.prepare<[string]>('SELECT id FROM mm_weeks WHERE service_date = ?');
  const insertWeek = db.prepare(`
    INSERT INTO mm_weeks (service_date, venue, status, note, created_at, updated_at)
    VALUES (@service_date, @venue, @status, @note, @now, @now)
    ON CONFLICT(service_date) DO UPDATE SET
      venue = excluded.venue,
      status = excluded.status,
      note = COALESCE(excluded.note, mm_weeks.note),
      updated_at = excluded.updated_at
  `);

  const deleteServices = db.prepare<[number]>('DELETE FROM mm_services WHERE week_id = ?');
  const insertService = db.prepare(`
    INSERT INTO mm_services (
      week_id, service_time, kind, sort_order,
      adult_attendance, kids_attendance, online_attendance,
      created_at, updated_at
    ) VALUES (
      @week_id, @service_time, @kind, @sort_order,
      @adult_attendance, @kids_attendance, @online_attendance,
      @now, @now
    )
  `);

  const insertMetric = db.prepare(`
    INSERT INTO mm_week_metrics (week_id, metric_key, value, created_at, updated_at)
    VALUES (@week_id, @metric_key, @value, @now, @now)
    ON CONFLICT(week_id, metric_key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `);

  const insertGiving = db.prepare(`
    INSERT INTO mm_giving (
      week_id, tithes_offerings, first_time_givers, first_time_givers_amount,
      donors_giving, tap_form_completions, created_at, updated_at
    ) VALUES (
      @week_id, @tithes_offerings, @first_time_givers, @first_time_givers_amount,
      @donors_giving, @tap_form_completions, @now, @now
    )
    ON CONFLICT(week_id) DO UPDATE SET
      tithes_offerings = excluded.tithes_offerings,
      first_time_givers = excluded.first_time_givers,
      first_time_givers_amount = excluded.first_time_givers_amount,
      donors_giving = excluded.donors_giving,
      tap_form_completions = excluded.tap_form_completions,
      updated_at = excluded.updated_at
  `);

  const insertIssue = db.prepare(`
    INSERT INTO mm_data_issues (week_id, scope, severity, note, created_at)
    VALUES (@week_id, @scope, @severity, @note, @now)
    ON CONFLICT(week_id, scope, note) DO NOTHING
  `);

  const insertAudit = db.prepare(`
    INSERT INTO mm_audit (entity, entity_id, field, old_value, new_value, changed_by, changed_at)
    VALUES (@entity, @entity_id, @field, @old_value, @new_value, @changed_by, @changed_at)
  `);

  const writeWeek = (week: ParsedWeek) => {
    const existing = selectWeek.get(week.service_date) as { id: number } | undefined;
    if (existing) summary.weeksUpdated++;
    else summary.weeksInserted++;

    insertWeek.run({
      service_date: week.service_date,
      venue: week.venue,
      status: week.status,
      note: week.note,
      now,
    });

    const row = selectWeek.get(week.service_date) as { id: number };
    const weekId = row.id;

    // Services are replaced wholesale: the set of services for a week is small
    // and comes from a single source, so reconciling individually buys nothing.
    deleteServices.run(weekId);
    for (const s of week.services) {
      insertService.run({
        week_id: weekId,
        service_time: s.service_time,
        kind: s.kind,
        sort_order: s.sort_order,
        adult_attendance: s.adult_attendance,
        kids_attendance: s.kids_attendance,
        online_attendance: s.online_attendance,
        now,
      });
      summary.servicesWritten++;
    }

    for (const [key, value] of Object.entries(week.metrics)) {
      if (value == null) continue;
      insertMetric.run({ week_id: weekId, metric_key: key, value, now });
      summary.metricsWritten++;
    }

    if (week.giving) {
      insertGiving.run({
        week_id: weekId,
        tithes_offerings: week.giving.tithes_offerings,
        first_time_givers: week.giving.first_time_givers,
        first_time_givers_amount: week.giving.first_time_givers_amount,
        donors_giving: week.giving.donors_giving,
        tap_form_completions: week.giving.tap_form_completions,
        now,
      });
      summary.givingWritten++;
    }

    for (const issue of week.issues) {
      insertIssue.run({
        week_id: weekId,
        scope: issue.scope,
        severity: issue.severity,
        note: issue.note,
        now,
      });
      summary.issuesRecorded++;
    }

    insertAudit.run({
      entity: 'mm_weeks',
      entity_id: week.service_date,
      field: 'import',
      old_value: null,
      new_value: `imported from sheet "${week.sheet_name}"`,
      changed_by: importedBy,
      changed_at: now,
    });
  };

  db.transaction(() => {
    for (const week of weeks) writeWeek(week);
    attachHighlights(db, weeks, summary, now);
    summary.noServiceWeeks = fillNoServiceWeeks(db, weeks, now);
  })();

  return summary;
}

/** Links each week to any recurring highlight whose rule resolves to its date. */
function attachHighlights(
  db: Database.Database,
  weeks: ParsedWeek[],
  summary: ImportSummary,
  now: number
) {
  const rules = db
    .prepare('SELECT id, key, name, rule_type, rule_value FROM mm_highlights')
    .all() as Array<HighlightRule & { id: number }>;

  const link = db.prepare(`
    INSERT INTO mm_week_highlights (week_id, highlight_id, label)
    VALUES (@week_id, @highlight_id, @label)
    ON CONFLICT(week_id, highlight_id) DO UPDATE SET label = excluded.label
  `);
  const selectWeek = db.prepare<[string]>('SELECT id, note FROM mm_weeks WHERE service_date = ?');

  const years = [...new Set(weeks.map((w) => Number(w.service_date.slice(0, 4))))];
  for (const year of years) {
    for (const rule of rules) {
      const date = resolveHighlightDate(rule, year);
      if (!date) continue;
      const row = selectWeek.get(date) as { id: number; note: string | null } | undefined;
      if (!row) continue;
      link.run({ week_id: row.id, highlight_id: rule.id, label: row.note ?? rule.name });
      summary.highlightsAttached++;
    }
  }
}

/**
 * Sundays with no worksheet in the source are recorded as "no service held"
 * rather than left absent, so charts can skip them instead of plotting a gap
 * that looks like zero attendance.
 */
function fillNoServiceWeeks(db: Database.Database, weeks: ParsedWeek[], now: number): string[] {
  const present = new Set(weeks.map((w) => w.service_date));
  const years = [...new Set(weeks.map((w) => Number(w.service_date.slice(0, 4))))];

  const insert = db.prepare(`
    INSERT INTO mm_weeks (service_date, venue, status, note, created_at, updated_at)
    VALUES (@service_date, NULL, 'no_service', @note, @now, @now)
    ON CONFLICT(service_date) DO NOTHING
  `);

  const filled: string[] = [];
  for (const year of years) {
    // Only fill gaps inside the range actually covered by the workbook, so a
    // partial year does not generate a tail of invented weeks.
    const covered = [...present].filter((d) => d.startsWith(String(year))).sort();
    if (covered.length === 0) continue;
    const first = covered[0];
    const last = covered[covered.length - 1];

    for (const sunday of sundaysInYear(year)) {
      if (sunday < first || sunday > last) continue;
      if (present.has(sunday)) continue;
      insert.run({
        service_date: sunday,
        note: 'No worksheet in the source workbook; recorded as no service held.',
        now,
      });
      filled.push(sunday);
    }
  }
  return filled;
}
