import ExcelJS from 'exceljs';

/**
 * Parses the "OVERSIGHTS WEEKLY NUMBERS" workbook, which stores one worksheet
 * per Sunday with metrics laid out vertically and services across columns.
 *
 * Blocks are located by their column-A label rather than by row number: the
 * workbook has two layouts (a "DNA" block was added partway through the year)
 * and more rows will be added in future years.
 */

export type ParsedService = {
  service_time: string;
  kind: 'in_person' | 'online_rebroadcast';
  sort_order: number;
  adult_attendance: number | null;
  kids_attendance: number | null;
  online_attendance: number | null;
};

export type ParsedGiving = {
  tithes_offerings: number | null;
  first_time_givers: number | null;
  first_time_givers_amount: number | null;
  donors_giving: number | null;
  tap_form_completions: number | null;
  source_sheet: string;
};

export type ParsedIssue = {
  scope: string;
  severity: 'corrected' | 'warning';
  note: string;
};

export type ParsedWeek = {
  service_date: string;
  sheet_name: string;
  venue: string | null;
  note: string | null;
  status: 'held' | 'no_service';
  services: ParsedService[];
  metrics: Record<string, number | null>;
  giving: ParsedGiving | null;
  issues: ParsedIssue[];
};

/**
 * Facts about specific weeks that the spreadsheet does not record, confirmed
 * with the team. Kept here so the import stays reproducible: re-running the
 * importer reapplies these rather than relying on hand edits to the database.
 */
type SourceCorrection = {
  reason: string;
  status?: 'no_service';
  /** Service times whose online count was entered as 0 but was never measured. */
  clearOnlineFor?: string[];
};

const SOURCE_CORRECTIONS: Record<string, SourceCorrection> = {
  '2025-03-16': {
    status: 'no_service',
    reason: 'No services held: the church was moving buildings and took the week off.',
  },
  '2025-07-13': {
    status: 'no_service',
    reason: 'No services held: Serve Day, serving in the community instead of gathering.',
  },
  '2025-02-02': {
    reason:
      'Online counts for the morning services were entered as 0 but the stream was not measured; treated as not recorded rather than as zero viewers.',
    clearOnlineFor: ['09:00', '11:00'],
  },
};

/** Unwraps formulas, shared formulas, rich text and hyperlink cell values. */
function raw(cell: ExcelJS.Cell | undefined): unknown {
  const v = cell?.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) {
      return (o.richText as Array<{ text: string }>).map((r) => r.text).join('');
    }
    if ('formula' in o || 'sharedFormula' in o) return o.result ?? null;
    if (v instanceof Date) return v;
    if ('text' in o) return o.text;
  }
  return v;
}

function asNumber(cell: ExcelJS.Cell | undefined): number | null {
  const v = raw(cell);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    // Life Group attendance was recorded as "attended/enrolled" for part of the
    // year and as a bare count afterwards; only attendance is kept.
    const ratio = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*\d+(?:\.\d+)?$/);
    if (ratio) return Number(ratio[1]);
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  }
  return null;
}

function asText(cell: ExcelJS.Cell | undefined): string | null {
  const v = raw(cell);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function isoFromCell(cell: ExcelJS.Cell | undefined): string | null {
  const v = raw(cell);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') {
    // Some date cells carry an appended note, e.g. "9/14/2025 (7 year birthday)".
    const m = v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) {
      const [, mm, dd, yyyy] = m;
      return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    }
  }
  return null;
}

/** Trailing annotation on an otherwise plain date or title cell. */
function annotation(cell: ExcelJS.Cell | undefined): string | null {
  const v = raw(cell);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const m = s.match(/^\d{1,2}\/\d{1,2}\/\d{4}\s*[-–(]?\s*(.+?)\)?$/);
  if (m && m[1]) return m[1].trim();
  return null;
}

function findRow(ws: ExcelJS.Worksheet, re: RegExp): number | null {
  let found: number | null = null;
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (found !== null) return;
    const v = raw(row.getCell(1));
    if (typeof v === 'string' && re.test(v.trim())) found = rn;
  });
  return found;
}

/**
 * Value of the "Attendance" row immediately following a bare ministry heading
 * (YTH, YA, Courses, DNA each occupy a heading row plus a value row).
 */
function attendanceUnder(ws: ExcelJS.Worksheet, heading: RegExp): number | null {
  const rn = findRow(ws, heading);
  if (rn === null) return null;
  for (let r = rn + 1; r <= Math.min(rn + 3, ws.rowCount); r++) {
    const label = asText(ws.getRow(r).getCell(1));
    if (label && /^Attendance$/i.test(label)) {
      return asNumber(ws.getRow(r).getCell(2));
    }
  }
  return null;
}

/**
 * Normalizes a service time read from row 2. Times in the 23:00 hour are an
 * AM/PM entry slip for the 11:30 service, present in every sheet from the
 * three-service launch onward.
 */
function normalizeServiceTime(d: Date): { time: string; corrected: boolean } {
  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  let corrected = false;
  if (h >= 22) {
    h -= 12;
    corrected = true;
  }
  return {
    time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
    corrected,
  };
}

const WEEK_METRIC_ROWS: Array<[string, RegExp]> = [
  ['lg_attendance', /^LG Attendance/i],
  ['ya_lg_attendance', /^YA LG Attendance/i],
  ['family_lg_attendance', /^Family LG Attendance/i],
  ['baptisms', /^Baptisms/i],
  ['first_time_guests', /^First Time Guest/i],
  ['dream_team_checkins', /^Dream Team check-?ins/i],
];

const MINISTRY_HEADINGS: Array<[string, RegExp]> = [
  ['yth_attendance', /^YTH$/i],
  ['ya_attendance', /^YA$/i],
  ['courses_attendance', /^Courses$/i],
  ['dna_attendance', /^DNA$/i],
];

function parseSheet(ws: ExcelJS.Worksheet): ParsedWeek | null {
  const serviceDate = isoFromCell(ws.getRow(1).getCell(3));
  if (!serviceDate) return null;

  const issues: ParsedIssue[] = [];

  // Title and date cells carry ad-hoc event notes ("Snow Storm", "SERVE DAY").
  const titleNote = (() => {
    const title = asText(ws.getRow(1).getCell(1));
    if (!title) return null;
    const m = title.match(/^QUEEN CITY CHURCH\s*[-–]\s*(.+)$/i);
    return m ? m[1].trim() : null;
  })();
  const note = [titleNote, annotation(ws.getRow(1).getCell(3))]
    .filter(Boolean)
    .join('; ') || null;

  const venue = asText(ws.getRow(2).getCell(1));

  // Service columns are those in row 2 holding a time value; column B is "Total".
  const serviceColumns: Array<{ col: number; time: string }> = [];
  for (let col = 3; col <= 10; col++) {
    const v = raw(ws.getRow(2).getCell(col));
    if (!(v instanceof Date)) continue;
    const { time, corrected } = normalizeServiceTime(v);
    if (corrected) {
      issues.push({
        scope: `service:${time}`,
        severity: 'corrected',
        note: `Service time recorded as ${String(v.getUTCHours()).padStart(2, '0')}:${String(
          v.getUTCMinutes()
        ).padStart(2, '0')} in the spreadsheet; interpreted as ${time}.`,
      });
    }
    serviceColumns.push({ col, time });
  }

  const adultRow = findRow(ws, /^Adult Attendance/i);
  const kidsRow = findRow(ws, /^Kids Attendance/i);
  const onlineRow = findRow(ws, /^Online Attendance/i);

  const services: ParsedService[] = serviceColumns.map((sc, idx) => {
    const adult = adultRow ? asNumber(ws.getRow(adultRow).getCell(sc.col)) : null;
    const kids = kidsRow ? asNumber(ws.getRow(kidsRow).getCell(sc.col)) : null;
    const online = onlineRow ? asNumber(ws.getRow(onlineRow).getCell(sc.col)) : null;

    // Classified from the data rather than the clock. The evening slot is
    // normally the online rebroadcast, but real evening services do happen
    // (the January conference, Christmas), and a lone kids count of 0 is not
    // evidence that anyone gathered in person.
    const hour = Number(sc.time.slice(0, 2));
    const gatheredInPerson = (adult ?? 0) > 0 || (kids ?? 0) > 0;
    const kind: ParsedService['kind'] = gatheredInPerson
      ? 'in_person'
      : hour >= 16
        ? 'online_rebroadcast'
        : 'in_person';

    return {
      service_time: sc.time,
      kind,
      sort_order: idx,
      adult_attendance: adult,
      kids_attendance: kids,
      online_attendance: online,
    };
  });

  // The spreadsheet's own row totals in column B were not extended when a third
  // service was added, so they understate those weeks. Totals are always
  // recomputed from the per-service cells; a mismatch is recorded so the
  // dashboard can show where imported figures differ from what was reported.
  for (const [label, rowNum, field] of [
    ['Adult attendance', adultRow, 'adult_attendance'],
    ['Kids attendance', kidsRow, 'kids_attendance'],
    ['Online attendance', onlineRow, 'online_attendance'],
  ] as Array<[string, number | null, keyof ParsedService]>) {
    if (rowNum === null) continue;
    const stated = asNumber(ws.getRow(rowNum).getCell(2));
    const parts = services.map((s) => s[field]).filter((v): v is number => typeof v === 'number');
    if (stated === null || parts.length === 0) continue;
    const sum = parts.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - stated) > 0.5) {
      issues.push({
        scope: field,
        severity: 'corrected',
        note: `${label} reported as ${stated} in the spreadsheet but the per-service figures total ${sum}; the spreadsheet formula omitted a service column. Imported as ${sum}.`,
      });
    }
  }

  const metrics: Record<string, number | null> = {};
  for (const [key, re] of WEEK_METRIC_ROWS) {
    const rn = findRow(ws, re);
    metrics[key] = rn === null ? null : asNumber(ws.getRow(rn).getCell(2));
  }
  for (const [key, re] of MINISTRY_HEADINGS) {
    metrics[key] = attendanceUnder(ws, re);
  }

  // "Decisions" in column B is a running cumulative total. The weekly figure is
  // on the following row whose label matches this sheet's own date.
  metrics.decisions = (() => {
    const rn = findRow(ws, /^Decisions$/i);
    if (rn === null) return null;
    for (let r = rn + 1; r <= Math.min(rn + 4, ws.rowCount); r++) {
      if (isoFromCell(ws.getRow(r).getCell(1)) === serviceDate) {
        return asNumber(ws.getRow(r).getCell(2));
      }
    }
    return null;
  })();

  // The giving block repeats the whole month on every sheet, with one column per
  // Sunday. Only the column matching this sheet's date is read here; conflicts
  // between sheets are resolved by the caller.
  const giving = (() => {
    const fundsRow = findRow(ws, /^FUNDS$/i);
    if (fundsRow === null) return null;
    let col: number | null = null;
    for (let c = 2; c <= 10; c++) {
      if (isoFromCell(ws.getRow(fundsRow).getCell(c)) === serviceDate) {
        col = c;
        break;
      }
    }
    if (col === null) return null;

    const valueAt = (re: RegExp) => {
      const rn = findRow(ws, re);
      return rn === null ? null : asNumber(ws.getRow(rn).getCell(col as number));
    };

    return {
      tithes_offerings: valueAt(/^Tithes & Offerings$/i),
      first_time_givers: valueAt(/^First Time Givers$/i),
      first_time_givers_amount: valueAt(/^First Time Givers Amount$/i),
      donors_giving: valueAt(/^Number of donors giving$/i),
      tap_form_completions: valueAt(/^Tap Form Completions$/i),
      source_sheet: ws.name,
    } satisfies ParsedGiving;
  })();

  const week: ParsedWeek = {
    service_date: serviceDate,
    sheet_name: ws.name,
    venue,
    note,
    status: 'held',
    services,
    metrics,
    giving,
    issues,
  };

  applySourceCorrection(week);
  return week;
}

function applySourceCorrection(week: ParsedWeek) {
  const correction = SOURCE_CORRECTIONS[week.service_date];
  if (!correction) return;

  if (correction.status === 'no_service') {
    week.status = 'no_service';
    // A week with no gathering still has giving, which stays on the record.
    week.services = [];
  }

  if (correction.clearOnlineFor) {
    for (const s of week.services) {
      if (correction.clearOnlineFor.includes(s.service_time)) {
        s.online_attendance = null;
      }
    }
  }

  week.issues.push({
    scope: correction.status === 'no_service' ? 'status' : 'online_attendance',
    severity: 'warning',
    note: correction.reason,
  });
}

export type GivingConflict = {
  date: string;
  chosen: { value: number; sheet: string };
  rejected: Array<{ value: number; sheet: string }>;
};

export type ParseResult = {
  weeks: ParsedWeek[];
  skippedSheets: string[];
  givingConflicts: GivingConflict[];
};

/**
 * Every giving column on a sheet, keyed by the Sunday it belongs to. Each sheet
 * repeats its whole month, so one date appears on several sheets.
 */
function givingColumnsOf(ws: ExcelJS.Worksheet): Map<string, ParsedGiving> {
  const out = new Map<string, ParsedGiving>();
  const fundsRow = findRow(ws, /^FUNDS$/i);
  if (fundsRow === null) return out;

  const rowOf = (re: RegExp) => findRow(ws, re);
  const rows = {
    tithes: rowOf(/^Tithes & Offerings$/i),
    ftg: rowOf(/^First Time Givers$/i),
    ftgAmount: rowOf(/^First Time Givers Amount$/i),
    donors: rowOf(/^Number of donors giving$/i),
    tap: rowOf(/^Tap Form Completions$/i),
  };

  const at = (rn: number | null, col: number) =>
    rn === null ? null : asNumber(ws.getRow(rn).getCell(col));

  for (let col = 2; col <= 10; col++) {
    const date = isoFromCell(ws.getRow(fundsRow).getCell(col));
    if (!date) continue;
    out.set(date, {
      tithes_offerings: at(rows.tithes, col),
      first_time_givers: at(rows.ftg, col),
      first_time_givers_amount: at(rows.ftgAmount, col),
      donors_giving: at(rows.donors, col),
      tap_form_completions: at(rows.tap, col),
      source_sheet: ws.name,
    });
  }
  return out;
}

export async function parseWorkbook(filePath: string): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const weeks: ParsedWeek[] = [];
  const skippedSheets: string[] = [];

  // date -> every reported giving figure, in sheet order
  const givingIndex = new Map<string, Array<{ giving: ParsedGiving; sheetIndex: number }>>();

  wb.worksheets.forEach((ws, sheetIndex) => {
    const parsed = parseSheet(ws);
    if (parsed) weeks.push(parsed);
    else skippedSheets.push(ws.name);

    for (const [date, giving] of givingColumnsOf(ws)) {
      if (giving.tithes_offerings == null) continue;
      if (!givingIndex.has(date)) givingIndex.set(date, []);
      givingIndex.get(date)!.push({ giving, sheetIndex });
    }
  });

  weeks.sort((a, b) => a.service_date.localeCompare(b.service_date));

  // Where copies of the same Sunday disagree, the latest sheet wins: later
  // sheets reflect corrections made after the original entry.
  const givingConflicts: GivingConflict[] = [];
  for (const week of weeks) {
    const reported = givingIndex.get(week.service_date);
    if (!reported || reported.length === 0) continue;

    const newest = reported.reduce((a, b) => (b.sheetIndex > a.sheetIndex ? b : a));
    const distinct = new Set(reported.map((r) => r.giving.tithes_offerings));
    if (distinct.size > 1) {
      givingConflicts.push({
        date: week.service_date,
        chosen: {
          value: newest.giving.tithes_offerings as number,
          sheet: newest.giving.source_sheet,
        },
        rejected: reported
          .filter((r) => r.giving.tithes_offerings !== newest.giving.tithes_offerings)
          .map((r) => ({
            value: r.giving.tithes_offerings as number,
            sheet: r.giving.source_sheet,
          })),
      });
    }
    week.giving = newest.giving;
  }

  return { weeks, skippedSheets, givingConflicts };
}
