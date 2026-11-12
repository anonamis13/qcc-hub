import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Ministry Metrics is hand-entered data that cannot be re-fetched from any
// external system, so it lives in its own database file rather than sharing
// cache.db (which holds disposable Planning Center responses).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Walks up to the directory holding package.json. Resolving relative to
 * __dirname alone would place the database under dist/ when running the
 * compiled build, and `npm run build` deletes dist/ - which would destroy the
 * one dataset in this app that cannot be rebuilt from an external source.
 */
function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const dbPath = process.env.RENDER
  ? '/data/metrics.db' // Matches the Render disk mount path
  : path.join(findProjectRoot(__dirname), 'src', 'data', 'metrics.db');

let db: Database.Database;

/**
 * Week-level metrics that are stored as key/value rows rather than columns.
 *
 * `zero_is_absent` marks metrics where a recorded 0 means the gathering did not
 * happen that week rather than that nobody came - a ministry on a seasonal
 * break, for instance. Those weeks are left as gaps on charts instead of being
 * plotted as zero. It is false for things like baptisms, where none happening
 * is a real and meaningful figure.
 */
const METRIC_DEFINITIONS: Array<{
  key: string;
  label: string;
  category: string;
  unit: string;
  display_order: number;
  zero_is_absent: number;
}> = [
  { key: 'yth_attendance', label: 'YTH Attendance', category: 'ministry', unit: 'people', display_order: 10, zero_is_absent: 1 },
  { key: 'ya_attendance', label: 'YA Attendance', category: 'ministry', unit: 'people', display_order: 20, zero_is_absent: 1 },
  { key: 'lg_attendance', label: 'Life Group Attendance', category: 'groups', unit: 'people', display_order: 30, zero_is_absent: 1 },
  { key: 'ya_lg_attendance', label: 'YA Life Group Attendance', category: 'groups', unit: 'people', display_order: 40, zero_is_absent: 1 },
  { key: 'family_lg_attendance', label: 'Family Life Group Attendance', category: 'groups', unit: 'people', display_order: 50, zero_is_absent: 1 },
  { key: 'courses_attendance', label: 'Courses Attendance', category: 'ministry', unit: 'people', display_order: 60, zero_is_absent: 1 },
  { key: 'dna_attendance', label: 'DNA Attendance', category: 'ministry', unit: 'people', display_order: 70, zero_is_absent: 1 },
  { key: 'baptisms', label: 'Baptisms', category: 'response', unit: 'count', display_order: 80, zero_is_absent: 0 },
  { key: 'decisions', label: 'Decisions', category: 'response', unit: 'count', display_order: 90, zero_is_absent: 0 },
  { key: 'first_time_guests', label: 'First Time Guests', category: 'engagement', unit: 'people', display_order: 100, zero_is_absent: 0 },
  { key: 'dream_team_checkins', label: 'Dream Team Check-ins', category: 'engagement', unit: 'people', display_order: 110, zero_is_absent: 1 },
];

/**
 * Recurring special Sundays. `rule_type` drives how the date is resolved for a
 * given year so these work for any year without data entry; `is_anchor` marks
 * the ones used to align multiple years on the comparison charts.
 */
const HIGHLIGHTS: Array<{
  key: string;
  name: string;
  rule_type: string;
  rule_value: string | null;
  color: string;
  is_anchor: number;
  display_order: number;
}> = [
  { key: 'easter', name: 'Easter', rule_type: 'computed_easter', rule_value: null, color: '#f59e0b', is_anchor: 1, display_order: 10 },
  { key: 'church_birthday', name: 'Church Birthday', rule_type: 'sunday_nearest', rule_value: '09-16', color: '#8b5cf6', is_anchor: 1, display_order: 20 },
  { key: 'christmas', name: 'Christmas', rule_type: 'sunday_before', rule_value: '12-25', color: '#ef4444', is_anchor: 1, display_order: 30 },
];

export function initializeMetricsDb(): Database.Database {
  if (db) return db;

  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  // One row per Sunday. `status` distinguishes a Sunday with no service from
  // one whose data has not been entered yet - a real zero would drag down every
  // average and trend line that crosses it.
  // `note` holds the annotation carried in from the spreadsheet; `user_note` is
  // typed in the app. They are kept apart so re-importing a workbook, which
  // rewrites `note`, can never clobber something a person wrote.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mm_weeks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_date TEXT NOT NULL UNIQUE,
      venue TEXT,
      status TEXT NOT NULL DEFAULT 'held',
      note TEXT,
      user_note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Added after the table shipped, so existing databases need the column.
  try {
    db.exec(`ALTER TABLE mm_weeks ADD COLUMN user_note TEXT`);
  } catch {
    // Already present.
  }

  // Service times are stored as data, not columns, so schedule changes (two
  // services, the Easter three-service trial, then 8:00/9:45/11:30) coexist
  // without migrations.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mm_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_id INTEGER NOT NULL,
      service_time TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'in_person',
      sort_order INTEGER NOT NULL,
      adult_attendance INTEGER,
      kids_attendance INTEGER,
      online_attendance INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (week_id) REFERENCES mm_weeks(id) ON DELETE CASCADE,
      UNIQUE(week_id, service_time)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mm_metric_definitions (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      category TEXT NOT NULL,
      unit TEXT,
      display_order INTEGER NOT NULL,
      is_active BOOLEAN DEFAULT 1,
      zero_is_absent BOOLEAN DEFAULT 0
    )
  `);

  // Added after the table shipped, so existing databases need the column.
  try {
    db.exec(`ALTER TABLE mm_metric_definitions ADD COLUMN zero_is_absent BOOLEAN DEFAULT 0`);
  } catch {
    // Already present.
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS mm_week_metrics (
      week_id INTEGER NOT NULL,
      metric_key TEXT NOT NULL,
      value REAL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (week_id, metric_key),
      FOREIGN KEY (week_id) REFERENCES mm_weeks(id) ON DELETE CASCADE,
      FOREIGN KEY (metric_key) REFERENCES mm_metric_definitions(key)
    )
  `);

  // Kept in its own table so access to financial figures can be restricted or
  // excluded from exports independently of attendance.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mm_giving (
      week_id INTEGER PRIMARY KEY,
      tithes_offerings REAL,
      first_time_givers INTEGER,
      first_time_givers_amount REAL,
      donors_giving INTEGER,
      tap_form_completions INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (week_id) REFERENCES mm_weeks(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mm_highlights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      rule_type TEXT NOT NULL,
      rule_value TEXT,
      color TEXT,
      is_anchor BOOLEAN DEFAULT 1,
      display_order INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mm_week_highlights (
      week_id INTEGER NOT NULL,
      highlight_id INTEGER NOT NULL,
      label TEXT,
      PRIMARY KEY (week_id, highlight_id),
      FOREIGN KEY (week_id) REFERENCES mm_weeks(id) ON DELETE CASCADE,
      FOREIGN KEY (highlight_id) REFERENCES mm_highlights(id) ON DELETE CASCADE
    )
  `);

  // Records where imported values intentionally differ from what the source
  // spreadsheet reported, so the dashboard can surface the discrepancy.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mm_data_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_id INTEGER NOT NULL,
      scope TEXT NOT NULL,
      severity TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (week_id) REFERENCES mm_weeks(id) ON DELETE CASCADE,
      UNIQUE(week_id, scope, note)
    )
  `);

  // Several people enter data for the same week, each field saving on its own,
  // so every change records who set what and when.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mm_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_by TEXT,
      changed_at INTEGER NOT NULL
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_mm_weeks_date ON mm_weeks(service_date)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mm_services_week ON mm_services(week_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mm_week_metrics_key ON mm_week_metrics(metric_key)`);

  seedReferenceData(db);

  return db;
}

function seedReferenceData(database: Database.Database) {
  const insertMetric = database.prepare(`
    INSERT INTO mm_metric_definitions (key, label, category, unit, display_order, is_active, zero_is_absent)
    VALUES (@key, @label, @category, @unit, @display_order, 1, @zero_is_absent)
    ON CONFLICT(key) DO UPDATE SET
      label = excluded.label,
      category = excluded.category,
      unit = excluded.unit,
      display_order = excluded.display_order,
      zero_is_absent = excluded.zero_is_absent
  `);

  const insertHighlight = database.prepare(`
    INSERT INTO mm_highlights (key, name, rule_type, rule_value, color, is_anchor, display_order)
    VALUES (@key, @name, @rule_type, @rule_value, @color, @is_anchor, @display_order)
    ON CONFLICT(key) DO UPDATE SET
      name = excluded.name,
      rule_type = excluded.rule_type,
      rule_value = excluded.rule_value,
      color = excluded.color,
      is_anchor = excluded.is_anchor,
      display_order = excluded.display_order
  `);

  database.transaction(() => {
    for (const m of METRIC_DEFINITIONS) insertMetric.run(m);
    for (const h of HIGHLIGHTS) insertHighlight.run(h);
  })();
}

export function getMetricsDbPath(): string {
  return dbPath;
}
