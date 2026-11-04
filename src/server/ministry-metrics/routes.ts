import { Router, urlencoded, raw } from 'express';
import { parseWorkbook } from './parse-workbook.js';
import { buildImportReport } from './import-report.js';
import { importWorkbook } from './import-workbook.js';
import {
  getAvailableYears,
  getHighlightDefinitions,
  getMetricDefinitions,
  getWeeks,
  getYearSummaries,
} from './repository.js';
import { renderDashboardPage } from './page.js';
import {
  clearAttempts,
  clearSessionCookie,
  isAuthenticated,
  isThrottled,
  recordFailedAttempt,
  renderLoginPage,
  requireMetricsAuth,
  setSessionCookie,
  verifyPassword,
} from './auth.js';

/**
 * Ministry Metrics routes. Mounted at the application root so the page lives at
 * /ministry-metrics and the JSON API under /api/ministry-metrics.
 */
export function createMinistryMetricsRouter(): Router {
  const router = Router();

  /** Parses a comma-separated `years` query parameter, defaulting to all years. */
  function requestedYears(raw: unknown): number[] {
    const available = getAvailableYears();
    if (typeof raw !== 'string' || raw.trim() === '') return available;
    const asked = raw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n));
    const allowed = asked.filter((y) => available.includes(y));
    return allowed.length ? allowed : available;
  }

  // --- Sign in -------------------------------------------------------------
  // Registered before the gate so the login form itself stays reachable.

  router.get('/ministry-metrics/login', (req, res) => {
    if (isAuthenticated(req)) return res.redirect('/ministry-metrics');
    res.send(renderLoginPage());
  });

  router.post(
    '/ministry-metrics/login',
    urlencoded({ extended: false }),
    (req, res) => {
      if (isThrottled(req)) {
        return res
          .status(429)
          .send(renderLoginPage('Too many attempts. Wait a few minutes and try again.'));
      }

      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const stored = process.env.METRICS_PASSWORD_HASH ?? '';

      if (!password || !verifyPassword(password, stored)) {
        recordFailedAttempt(req);
        return res.status(401).send(renderLoginPage('Incorrect password.'));
      }

      clearAttempts(req);
      setSessionCookie(res);
      res.redirect('/ministry-metrics');
    }
  );

  router.post('/ministry-metrics/logout', (_req, res) => {
    clearSessionCookie(res);
    res.redirect('/ministry-metrics/login');
  });

  // --- Everything below requires a session ----------------------------------
  router.use(['/ministry-metrics', '/api/ministry-metrics'], requireMetricsAuth);

  router.get('/ministry-metrics', (_req, res) => {
    res.send(renderDashboardPage());
  });

  router.get('/api/ministry-metrics/meta', (_req, res) => {
    try {
      res.json({
        years: getAvailableYears(),
        metrics: getMetricDefinitions(),
        highlights: getHighlightDefinitions(),
      });
    } catch (error) {
      console.error('Error fetching ministry metrics metadata:', error);
      res.status(500).json({ error: 'Failed to fetch ministry metrics metadata' });
    }
  });

  router.get('/api/ministry-metrics/weeks', (req, res) => {
    try {
      const years = requestedYears(req.query.years);
      res.json({
        years,
        weeks: getWeeks(years),
        summaries: getYearSummaries(years),
      });
    } catch (error) {
      console.error('Error fetching ministry metrics weeks:', error);
      res.status(500).json({ error: 'Failed to fetch ministry metrics' });
    }
  });

  /**
   * Workbook upload. The file is sent as the raw request body rather than as
   * multipart form data, which keeps this dependency-free - ExcelJS reads
   * directly from the buffer.
   *
   * With ?dryRun=true nothing is written; the parsed report comes back so the
   * upload can be reviewed before committing it.
   */
  router.post(
    '/api/ministry-metrics/import',
    raw({ type: () => true, limit: '25mb' }),
    async (req, res) => {
      try {
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return res.status(400).json({ error: 'No file received.' });
        }

        // .xlsx files are zip archives and always start with "PK".
        if (body[0] !== 0x50 || body[1] !== 0x4b) {
          return res.status(400).json({
            error: 'That does not look like an .xlsx file. Export the sheet as Excel and try again.',
          });
        }

        const dryRun = req.query.dryRun === 'true';

        let parsed;
        try {
          parsed = await parseWorkbook(body);
        } catch (err) {
          return res.status(400).json({
            error: 'Could not read that workbook: ' + (err instanceof Error ? err.message : 'unknown error'),
          });
        }

        const report = buildImportReport(parsed);

        if (parsed.weeks.length === 0) {
          return res.status(400).json({
            error: 'No worksheets with a readable date in cell C1 were found in that workbook.',
            report,
          });
        }

        if (dryRun) {
          return res.json({ dryRun: true, report });
        }

        const importedBy =
          typeof req.query.by === 'string' && req.query.by.trim() !== ''
            ? req.query.by.trim()
            : 'web upload';
        const summary = await importWorkbook(body, { importedBy });

        res.json({ dryRun: false, report, summary });
      } catch (error) {
        console.error('Error importing ministry metrics workbook:', error);
        res.status(500).json({ error: 'Failed to import workbook' });
      }
    }
  );

  // A plain-spreadsheet escape hatch, so the data is never locked inside this app.
  router.get('/api/ministry-metrics/export.csv', (req, res) => {
    try {
      const years = requestedYears(req.query.years);
      const weeks = getWeeks(years);
      const metricKeys = getMetricDefinitions().map((m) => m.key);

      const header = [
        'service_date',
        'status',
        'venue',
        'note',
        'services_in_person',
        'adults',
        'kids',
        'in_person_total',
        'online',
        ...metricKeys,
        'tithes_offerings',
        'first_time_givers',
        'first_time_givers_amount',
        'donors_giving',
        'tap_form_completions',
        'highlights',
        'data_notes',
      ];

      const escape = (v: unknown) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };

      const lines = [header.join(',')];
      for (const w of weeks) {
        lines.push(
          [
            w.service_date,
            w.status,
            w.venue,
            w.note,
            w.services.filter((s) => s.kind === 'in_person').length,
            w.adults,
            w.kids,
            w.in_person,
            w.online,
            ...metricKeys.map((k) => w.metrics[k] ?? ''),
            w.giving?.tithes_offerings ?? '',
            w.giving?.first_time_givers ?? '',
            w.giving?.first_time_givers_amount ?? '',
            w.giving?.donors_giving ?? '',
            w.giving?.tap_form_completions ?? '',
            w.highlights.map((h) => h.label || h.name).join('; '),
            w.issues.map((i) => i.note).join(' | '),
          ]
            .map(escape)
            .join(',')
        );
      }

      const filename = `ministry-metrics-${years.join('-')}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(lines.join('\n'));
    } catch (error) {
      console.error('Error exporting ministry metrics:', error);
      res.status(500).json({ error: 'Failed to export ministry metrics' });
    }
  });

  return router;
}
