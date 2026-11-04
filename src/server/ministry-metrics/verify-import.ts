import path from 'path';
import { parseWorkbook, type ParsedWeek } from './parse-workbook.js';
import { resolveHighlightDate, sundaysInYear, type HighlightRule } from './calendar.js';

/**
 * Dry-run report for a Ministry Metrics workbook import. Prints what would be
 * written and what looks wrong, without touching the database.
 *
 *   npx tsx src/server/ministry-metrics/verify-import.ts <file.xlsx>
 */

const HIGHLIGHT_RULES: HighlightRule[] = [
  { key: 'easter', name: 'Easter', rule_type: 'computed_easter', rule_value: null },
  { key: 'church_birthday', name: 'Church Birthday', rule_type: 'sunday_nearest', rule_value: '09-16' },
  { key: 'christmas', name: 'Christmas', rule_type: 'sunday_before', rule_value: '12-25' },
];

const money = (n: number | null | undefined) =>
  n == null ? '' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const padL = (s: string | number, n: number) => String(s).padStart(n);

function sumOf(week: ParsedWeek, field: 'adult_attendance' | 'kids_attendance' | 'online_attendance') {
  const parts = week.services.map((s) => s[field]).filter((v): v is number => typeof v === 'number');
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

function inPersonTotal(week: ParsedWeek) {
  const parts = week.services
    .filter((s) => s.kind === 'in_person')
    .flatMap((s) => [s.adult_attendance, s.kids_attendance])
    .filter((v): v is number => typeof v === 'number');
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: verify-import <file.xlsx>');
    process.exit(1);
  }

  const result = await parseWorkbook(path.resolve(file));
  const { weeks, skippedSheets, givingConflicts } = result;

  console.log('MINISTRY METRICS - IMPORT VERIFICATION');
  console.log('='.repeat(100));
  console.log(`Source       : ${path.basename(file)}`);
  console.log(`Weeks parsed : ${weeks.length}`);
  if (skippedSheets.length) {
    console.log(`Skipped      : ${skippedSheets.length} sheet(s) with no readable date -> ${skippedSheets.join(', ')}`);
  }

  // ---- Per-week table ----------------------------------------------------
  console.log('\nPARSED WEEKS');
  console.log('-'.repeat(100));
  console.log(
    pad('date', 12) + pad('svcs', 5) + padL('adult', 7) + padL('kids', 6) + padL('online', 7) +
    padL('inPerson', 9) + padL('giving', 14) + '  venue / note'
  );
  console.log('-'.repeat(100));

  for (const w of weeks) {
    const times = w.services.map((s) => s.service_time + (s.kind === 'online_rebroadcast' ? '*' : '')).join(' ');
    console.log(
      pad(w.service_date, 12) +
        pad(w.services.length, 5) +
        padL(sumOf(w, 'adult_attendance') ?? '-', 7) +
        padL(sumOf(w, 'kids_attendance') ?? '-', 6) +
        padL(sumOf(w, 'online_attendance') ?? '-', 7) +
        padL(inPersonTotal(w) ?? '-', 9) +
        padL(money(w.giving?.tithes_offerings), 14) +
        '  ' + (w.venue ?? '?') + (w.note ? ` [${w.note}]` : '') +
        '  { ' + times + ' }'
    );
  }

  // ---- Coverage ----------------------------------------------------------
  const years = [...new Set(weeks.map((w) => w.service_date.slice(0, 4)))].map(Number);
  console.log('\nCOVERAGE');
  console.log('-'.repeat(100));
  for (const year of years) {
    const expected = sundaysInYear(year);
    const have = new Set(weeks.filter((w) => w.service_date.startsWith(String(year))).map((w) => w.service_date));
    const missing = expected.filter((d) => !have.has(d));
    console.log(`${year}: ${have.size} of ${expected.length} Sundays present`);
    if (missing.length) {
      const covered = [...have].sort();
      const first = covered[0];
      const last = covered[covered.length - 1];
      const interior = missing.filter((d) => d > first && d < last);
      const outside = missing.filter((d) => d < first || d > last);
      console.log(`      absent: ${missing.join(', ')}`);
      if (interior.length) {
        console.log(`      -> inside the covered range, recorded as "no service held": ${interior.join(', ')}`);
      }
      if (outside.length) {
        console.log(`      -> outside the covered range, not recorded at all: ${outside.join(', ')}`);
      }
    }
  }

  // ---- Highlights --------------------------------------------------------
  console.log('\nHIGHLIGHTED SUNDAYS');
  console.log('-'.repeat(100));
  for (const year of years) {
    for (const rule of HIGHLIGHT_RULES) {
      const date = resolveHighlightDate(rule, year);
      if (!date) continue;
      const week = weeks.find((w) => w.service_date === date);
      const status = week ? 'matched' : 'NO WEEK IN DATA';
      const note = week?.note ? ` (sheet note: "${week.note}")` : '';
      console.log(`${year} ${pad(rule.name, 18)} ${date}  ${status}${note}`);
    }
  }

  // ---- Service schedule eras --------------------------------------------
  console.log('\nSERVICE SCHEDULES');
  console.log('-'.repeat(100));
  const schedules = new Map<string, string[]>();
  for (const w of weeks) {
    const key = w.services.map((s) => `${s.service_time}${s.kind === 'online_rebroadcast' ? '*' : ''}`).join(' / ');
    if (!schedules.has(key)) schedules.set(key, []);
    schedules.get(key)!.push(w.service_date);
  }
  for (const [schedule, dates] of [...schedules].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${padL(dates.length, 3)} week(s)  ${schedule}`);
    console.log(`            ${dates[0]} .. ${dates[dates.length - 1]}`);
  }
  console.log('(* = online rebroadcast, excluded from in-person totals)');

  // ---- Venues ------------------------------------------------------------
  console.log('\nVENUES');
  console.log('-'.repeat(100));
  const venues = new Map<string, string[]>();
  for (const w of weeks) {
    const v = w.venue ?? '(blank)';
    if (!venues.has(v)) venues.set(v, []);
    venues.get(v)!.push(w.service_date);
  }
  for (const [v, dates] of venues) {
    console.log(`${pad(v, 24)} ${dates.length} week(s)  ${dates[0]} .. ${dates[dates.length - 1]}`);
  }

  // ---- Corrections and conflicts ----------------------------------------
  console.log('\nCORRECTIONS APPLIED');
  console.log('-'.repeat(100));
  const withIssues = weeks.filter((w) => w.issues.length > 0);
  if (!withIssues.length) console.log('none');
  for (const w of withIssues) {
    for (const issue of w.issues) {
      console.log(`${w.service_date}  [${issue.scope}] ${issue.note}`);
    }
  }

  console.log('\nGIVING CONFLICTS');
  console.log('-'.repeat(100));
  if (!givingConflicts.length) console.log('none - all repeated copies agree');
  for (const c of givingConflicts) {
    console.log(`${c.date}  using ${money(c.chosen.value)} from "${c.chosen.sheet}"`);
    for (const r of c.rejected) {
      console.log(`            ignoring ${money(r.value)} from "${r.sheet}"`);
    }
  }

  // ---- Gaps in metrics ---------------------------------------------------
  console.log('\nMETRIC COMPLETENESS');
  console.log('-'.repeat(100));
  const metricKeys = [...new Set(weeks.flatMap((w) => Object.keys(w.metrics)))].sort();
  for (const key of metricKeys) {
    const present = weeks.filter((w) => w.metrics[key] != null).length;
    const bar = '#'.repeat(Math.round((present / weeks.length) * 40));
    console.log(`${pad(key, 26)} ${padL(present, 3)}/${weeks.length}  ${bar}`);
  }
  const givingPresent = weeks.filter((w) => w.giving?.tithes_offerings != null).length;
  console.log(`${pad('giving.tithes_offerings', 26)} ${padL(givingPresent, 3)}/${weeks.length}`);

  // ---- Sanity checks -----------------------------------------------------
  console.log('\nSANITY CHECKS');
  console.log('-'.repeat(100));
  const problems: string[] = [];

  const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const medianOnline = median(
    weeks.map((w) => sumOf(w, 'online_attendance')).filter((v): v is number => v != null)
  );
  const medianInPerson = median(
    weeks.map((w) => inPersonTotal(w)).filter((v): v is number => v != null)
  );

  for (const w of weeks) {
    // Weeks known to have had no gathering are expected to be empty.
    if (w.status === 'no_service') continue;

    if (w.services.length === 0) problems.push(`${w.service_date}: no service columns found`);

    // Weeks carrying giving but no attendance at all are blank in the source
    // spreadsheet, not a parsing failure - they need to be filled in by hand.
    const hasAttendance = w.services.some(
      (s) => s.adult_attendance != null || s.kids_attendance != null || s.online_attendance != null
    );
    if (!hasAttendance) {
      problems.push(`${w.service_date}: no attendance recorded anywhere on the sheet${w.note ? ` (note: "${w.note}")` : ''}`);
    }

    const total = inPersonTotal(w);
    if (total != null && medianInPerson && (total < medianInPerson * 0.4 || total > medianInPerson * 2.5)) {
      problems.push(
        `${w.service_date}: in-person total of ${total} is far from the ${medianInPerson} median${w.note ? ` (note: "${w.note}")` : ''}`
      );
    }

    // An already-recorded warning about online figures makes an outlier expected.
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
      problems.push(`${w.service_date}: giving of ${money(giving)} is outside the expected range`);
    }
  }

  const seen = new Set<string>();
  for (const w of weeks) {
    if (seen.has(w.service_date)) problems.push(`${w.service_date}: appears on more than one sheet`);
    seen.add(w.service_date);
  }

  if (!problems.length) console.log('no problems found');
  for (const p of problems) console.log(`!! ${p}`);

  // Evening in-person services are unusual enough to call out, since they are
  // normally the rebroadcast slot.
  const eveningServices = weeks.flatMap((w) =>
    w.services
      .filter((s) => s.kind === 'in_person' && Number(s.service_time.slice(0, 2)) >= 16)
      .map((s) => ({ date: w.service_date, s, note: w.note }))
  );
  if (eveningServices.length) {
    console.log('\nEVENING SERVICES TREATED AS IN-PERSON');
    console.log('-'.repeat(100));
    for (const e of eveningServices) {
      console.log(
        `${e.date}  ${e.s.service_time}  adult=${e.s.adult_attendance ?? '-'} kids=${e.s.kids_attendance ?? '-'} online=${e.s.online_attendance ?? '-'}` +
          (e.note ? `  [${e.note}]` : '')
      );
    }
  }

  console.log('\n' + '='.repeat(100));
  console.log(
    `SUMMARY: ${weeks.length} weeks, ${withIssues.reduce((a, w) => a + w.issues.length, 0)} corrections, ` +
      `${givingConflicts.length} giving conflicts, ${problems.length} open problems`
  );
  console.log('Nothing has been written to the database.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
