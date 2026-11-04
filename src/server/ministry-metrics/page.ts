/**
 * Ministry Metrics dashboard. Follows the existing QCC Hub page convention:
 * a full HTML document returned from an Express route, with inline styles and
 * vanilla JavaScript fetching the JSON API, Chart.js loaded from the CDN and
 * dark mode driven by the shared `darkMode` localStorage key.
 */
export function renderDashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QCC Hub - Ministry Metrics</title>
  <link rel="icon" type="image/x-icon" href="https://www.queencitypeople.com/favicon.ico">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0; padding: 20px;
      background-color: #f8f9fa; color: #333;
      transition: background-color 0.3s ease;
    }
    body.dark-mode { background-color: #1a1a1a; color: #e8e8e8; }

    .header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
    .header h1 { margin: 0; font-size: 1.8em; }
    body.dark-mode .header h1 { color: #fff; }
    .header-actions { display: flex; gap: 10px; align-items: center; }

    a.back-link { color: #0d6efd; text-decoration: none; font-size: 0.95em; }
    body.dark-mode a.back-link { color: #6ea8fe; }

    button, select {
      font-family: inherit; font-size: 0.9em; padding: 8px 14px;
      border-radius: 6px; border: 1px solid #ced4da; background: #fff; color: #333; cursor: pointer;
    }
    body.dark-mode button, body.dark-mode select { background: #2d2d2d; color: #e8e8e8; border-color: #495057; }
    button.primary { background: #0d6efd; color: #fff; border-color: #0d6efd; }

    .card {
      background: #fff; border-radius: 12px; padding: 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 20px;
    }
    body.dark-mode .card { background: #2d2d2d; box-shadow: 0 2px 8px rgba(0,0,0,0.4); }

    .controls { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
    .control-group { display: flex; flex-direction: column; gap: 6px; }
    .control-group > label { font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; font-weight: 600; }

    .year-toggles { display: flex; flex-wrap: wrap; gap: 8px; }
    .year-toggle {
      padding: 7px 14px; border-radius: 20px; border: 2px solid #ced4da;
      background: #fff; cursor: pointer; font-size: 0.9em; font-weight: 600;
    }
    body.dark-mode .year-toggle { background: #2d2d2d; color: #e8e8e8; border-color: #495057; }
    .year-toggle.active { color: #fff; }

    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; }
    .stat { padding: 14px; border-radius: 10px; background: #f8f9fa; border-left: 4px solid #0d6efd; }
    body.dark-mode .stat { background: #363636; }
    .stat .label { font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
    .stat .value { font-size: 1.5em; font-weight: 700; margin-top: 4px; }
    .stat .sub { font-size: 0.78em; opacity: 0.65; margin-top: 2px; }

    .chart-wrap { position: relative; height: 420px; }
    .chart-title { margin: 0 0 4px; font-size: 1.1em; }
    .chart-note { margin: 0 0 16px; font-size: 0.85em; opacity: 0.7; }

    table { width: 100%; border-collapse: collapse; font-size: 0.88em; }
    th, td { padding: 8px 10px; text-align: right; border-bottom: 1px solid #e9ecef; white-space: nowrap; }
    th:first-child, td:first-child { text-align: left; }
    th { font-weight: 600; font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.03em; opacity: 0.7; }
    body.dark-mode th, body.dark-mode td { border-bottom-color: #444; }
    tr.no-service td { opacity: 0.5; font-style: italic; }
    .table-scroll { overflow-x: auto; max-height: 520px; overflow-y: auto; }

    .pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75em; font-weight: 600; color: #fff; margin-left: 6px; }
    .flag { color: #d63384; cursor: help; font-weight: 700; margin-left: 4px; }
    body.dark-mode .flag { color: #f783ac; }

    .loading, .empty { padding: 40px; text-align: center; opacity: 0.6; }
    .error { padding: 16px; border-radius: 8px; background: #f8d7da; color: #842029; }
    body.dark-mode .error { background: #4a1d24; color: #f5c2c7; }

    .import-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    input[type=file] { font-family: inherit; font-size: 0.9em; }
    .notice { padding: 12px 14px; border-radius: 8px; font-size: 0.9em; margin-top: 14px; }
    .notice.ok { background: #d1e7dd; color: #0f5132; }
    .notice.warn { background: #fff3cd; color: #664d03; }
    .notice.bad { background: #f8d7da; color: #842029; }
    body.dark-mode .notice.ok { background: #0f3c2b; color: #a3cfbb; }
    body.dark-mode .notice.warn { background: #4a3c08; color: #ffe69c; }
    body.dark-mode .notice.bad { background: #4a1d24; color: #f5c2c7; }
    .report { margin-top: 16px; font-size: 0.88em; }
    .report h4 { margin: 16px 0 6px; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
    .report ul { margin: 0; padding-left: 20px; line-height: 1.6; }
    .report .muted { opacity: 0.65; }
    .spin { opacity: 0.6; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Ministry Metrics</h1>
      <a href="/home-page" class="back-link">&larr; Back to QCC Hub</a>
    </div>
    <div class="header-actions">
      <button id="importToggle">Import spreadsheet</button>
      <button id="exportBtn">Export CSV</button>
      <button id="darkModeToggle">🌙 Dark Mode</button>
      <form method="POST" action="/ministry-metrics/logout" style="margin:0">
        <button type="submit">Sign out</button>
      </form>
    </div>
  </div>

  <div id="error" class="error" style="display:none"></div>

  <div class="card">
    <div class="controls">
      <div class="control-group">
        <label>Years</label>
        <div class="year-toggles" id="yearToggles"></div>
      </div>
      <div class="control-group">
        <label for="metricSelect">Metric</label>
        <select id="metricSelect"></select>
      </div>
      <div class="control-group">
        <label for="alignSelect">Compare by</label>
        <select id="alignSelect">
          <option value="calendar">Calendar week</option>
        </select>
      </div>
    </div>
  </div>

  <div class="card" id="importCard" style="display:none">
    <h3 class="chart-title">Import a spreadsheet</h3>
    <p class="chart-note">
      Upload a weekly numbers workbook (.xlsx). Nothing is saved until you review the summary and confirm.
      Importing a year that is already loaded updates it rather than duplicating it.
    </p>
    <div class="import-row">
      <input type="file" id="fileInput" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
      <button id="checkBtn">Check file</button>
      <button id="commitBtn" class="primary" style="display:none">Import</button>
    </div>
    <div id="importStatus"></div>
    <div id="importReport" class="report"></div>
  </div>

  <div class="card">
    <div class="summary-grid" id="summary"><div class="loading">Loading…</div></div>
  </div>

  <div class="card">
    <h3 class="chart-title" id="mainChartTitle">Attendance</h3>
    <p class="chart-note" id="mainChartNote"></p>
    <div class="chart-wrap"><canvas id="mainChart"></canvas></div>
  </div>

  <div class="card">
    <h3 class="chart-title">Tithes &amp; Offerings</h3>
    <p class="chart-note">Giving is charted separately from attendance.</p>
    <div class="chart-wrap"><canvas id="givingChart"></canvas></div>
  </div>

  <div class="card">
    <h3 class="chart-title">Weekly detail</h3>
    <p class="chart-note" id="tableNote"></p>
    <div class="table-scroll"><table id="weekTable"></table></div>
  </div>

<script>
const YEAR_COLORS = ['#0d6efd', '#dc3545', '#198754', '#fd7e14', '#6f42c1', '#20c997', '#d63384'];

const state = {
  years: [],
  selectedYears: [],
  metric: 'in_person',
  align: 'calendar',
  weeks: [],
  summaries: [],
  metricDefs: [],
  highlightDefs: [],
};

// Metrics derived from the service rows, offered alongside the stored ones.
const DERIVED_METRICS = [
  { key: 'in_person', label: 'Total in-person attendance' },
  { key: 'adults', label: 'Adults (in person)' },
  { key: 'kids', label: 'Kids (in person)' },
  { key: 'online', label: 'Online attendance' },
];

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

/** Sends the browser back to the login form when the session has expired. */
async function getJson(url) {
  const res = await fetch(url);
  if (res.status === 401) {
    window.location.href = '/ministry-metrics/login';
    throw new Error('Session expired');
  }
  if (!res.ok) throw new Error('Request failed with status ' + res.status);
  return res.json();
}

function valueFor(week, metric) {
  // "No service" applies to the Sunday gathering only. Life Groups, youth and
  // courses still met on those weeks, so their metrics are still plotted.
  const isServiceMetric = DERIVED_METRICS.some(function (m) { return m.key === metric; });
  if (isServiceMetric) {
    if (week.status !== 'held') return null;
    if (metric === 'in_person') return week.in_person;
    if (metric === 'adults') return week.adults;
    if (metric === 'kids') return week.kids;
    return week.online;
  }
  const v = week.metrics[metric];
  return typeof v === 'number' ? v : null;
}

function metricLabel(key) {
  const derived = DERIVED_METRICS.find(function (m) { return m.key === key; });
  if (derived) return derived.label;
  const def = state.metricDefs.find(function (m) { return m.key === key; });
  return def ? def.label : key;
}

const DAY_MS = 86400000;

/**
 * X position for a week. With calendar alignment this is the ordinal Sunday of
 * the year; with an anchor it is the number of weeks before or after that
 * year's anchor Sunday, so the same event lines up across years even though it
 * falls on a different calendar date each year.
 */
function xFor(week, anchorDates) {
  const date = new Date(week.service_date + 'T00:00:00Z');
  if (state.align === 'calendar') {
    const jan1 = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.round((date - jan1) / DAY_MS / 7);
  }
  const anchor = anchorDates[date.getUTCFullYear()];
  if (!anchor) return null;
  return Math.round((date - new Date(anchor + 'T00:00:00Z')) / DAY_MS / 7);
}

/** The date of the selected anchor highlight, per year. */
function anchorDatesFor(align) {
  const out = {};
  if (align === 'calendar') return out;
  for (const w of state.weeks) {
    if (w.highlights.some(function (h) { return h.key === align; })) {
      out[Number(w.service_date.slice(0, 4))] = w.service_date;
    }
  }
  return out;
}

let mainChart = null;
let givingChart = null;

function isDark() { return document.body.classList.contains('dark-mode'); }

function chartOptions(yLabel, formatter) {
  const grid = isDark() ? '#444' : '#e9ecef';
  const text = isDark() ? '#e8e8e8' : '#333';
  const anchorName = state.align === 'calendar' ? null : metricLabelForAnchor(state.align);
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    plugins: {
      legend: { labels: { color: text } },
      tooltip: {
        callbacks: {
          title: function (items) {
            const p = items[0];
            const d = p.dataset.dates ? p.dataset.dates[p.dataIndex] : null;
            return d ? d.date + (d.labels.length ? '  •  ' + d.labels.join(', ') : '') : '';
          },
          label: function (ctx) {
            return ctx.dataset.label + ': ' + formatter(ctx.parsed.y);
          },
        },
      },
    },
    scales: {
      x: {
        title: {
          display: true,
          color: text,
          text: anchorName ? 'Weeks relative to ' + anchorName : 'Week of year',
        },
        grid: { color: grid },
        ticks: { color: text },
      },
      y: {
        title: { display: true, text: yLabel, color: text },
        grid: { color: grid },
        ticks: { color: text, callback: function (v) { return formatter(v); } },
        beginAtZero: true,
      },
    },
  };
}

function metricLabelForAnchor(key) {
  const h = state.highlightDefs.find(function (d) { return d.key === key; });
  return h ? h.name : key;
}

/** Builds one dataset per selected year on a shared x axis. */
function buildDatasets(metric, formatterKey) {
  const anchorDates = anchorDatesFor(state.align);
  const byYear = new Map();

  for (const w of state.weeks) {
    const year = Number(w.service_date.slice(0, 4));
    if (!state.selectedYears.includes(year)) continue;
    const x = xFor(w, anchorDates);
    if (x === null) continue;
    const value = formatterKey === 'giving'
      ? (w.giving ? w.giving.tithes_offerings : null)
      : valueFor(w, metric);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push({
      x: x,
      y: value,
      date: w.service_date,
      labels: w.highlights.map(function (h) { return h.label || h.name; }),
      flagged: w.issues.length > 0,
    });
  }

  const allX = [];
  for (const points of byYear.values()) for (const p of points) allX.push(p.x);
  if (allX.length === 0) return { labels: [], datasets: [] };

  const min = Math.min.apply(null, allX);
  const max = Math.max.apply(null, allX);
  const labels = [];
  for (let i = min; i <= max; i++) labels.push(i);

  const datasets = [];
  const sortedYears = [...byYear.keys()].sort();
  sortedYears.forEach(function (year) {
    const points = byYear.get(year);
    const index = new Map(points.map(function (p) { return [p.x, p]; }));
    const color = YEAR_COLORS[state.years.indexOf(year) % YEAR_COLORS.length];
    datasets.push({
      label: String(year),
      data: labels.map(function (x) { const p = index.get(x); return p ? p.y : null; }),
      dates: labels.map(function (x) {
        const p = index.get(x);
        return p ? { date: p.date, labels: p.labels } : null;
      }),
      borderColor: color,
      backgroundColor: color,
      pointRadius: labels.map(function (x) {
        const p = index.get(x);
        return p && p.labels.length ? 6 : 2.5;
      }),
      pointStyle: labels.map(function (x) {
        const p = index.get(x);
        return p && p.labels.length ? 'rectRot' : 'circle';
      }),
      spanGaps: true,
      tension: 0.25,
      borderWidth: 2,
    });
  });

  return { labels: labels, datasets: datasets };
}

const numberFmt = function (v) { return v == null ? '' : Number(v).toLocaleString('en-US'); };
const moneyFmt = function (v) {
  return v == null ? '' : '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
};

function renderCharts() {
  const main = buildDatasets(state.metric, 'count');
  document.getElementById('mainChartTitle').textContent = metricLabel(state.metric);
  document.getElementById('mainChartNote').textContent =
    state.align === 'calendar'
      ? 'Diamond markers are highlighted Sundays. Weeks with no service are left as gaps.'
      : 'Years are aligned so ' + metricLabelForAnchor(state.align) + ' falls at week 0 in every year.';

  if (mainChart) mainChart.destroy();
  mainChart = new Chart(document.getElementById('mainChart'), {
    type: 'line',
    data: main,
    options: chartOptions(metricLabel(state.metric), numberFmt),
  });

  const giving = buildDatasets('giving', 'giving');
  if (givingChart) givingChart.destroy();
  givingChart = new Chart(document.getElementById('givingChart'), {
    type: 'line',
    data: giving,
    options: chartOptions('Tithes & Offerings', moneyFmt),
  });
}

function renderSummary() {
  const el = document.getElementById('summary');
  const shown = state.summaries.filter(function (s) { return state.selectedYears.includes(s.year); });
  if (!shown.length) { el.innerHTML = '<div class="empty">Select a year to see totals.</div>'; return; }

  el.innerHTML = shown.map(function (s) {
    const color = YEAR_COLORS[state.years.indexOf(s.year) % YEAR_COLORS.length];
    return [
      '<div class="stat" style="border-left-color:' + color + '">',
      '<div class="label">' + s.year + ' average attendance</div>',
      '<div class="value">' + numberFmt(s.avg_in_person) + '</div>',
      '<div class="sub">' + s.weeks_held + ' weeks held' +
        (s.weeks_no_service ? ', ' + s.weeks_no_service + ' without service' : '') + '</div>',
      '</div>',
      '<div class="stat" style="border-left-color:' + color + '">',
      '<div class="label">' + s.year + ' peak Sunday</div>',
      '<div class="value">' + (s.peak_in_person ? numberFmt(s.peak_in_person.value) : '—') + '</div>',
      '<div class="sub">' + (s.peak_in_person ? s.peak_in_person.date : '') + '</div>',
      '</div>',
      '<div class="stat" style="border-left-color:' + color + '">',
      '<div class="label">' + s.year + ' tithes &amp; offerings</div>',
      '<div class="value">' + moneyFmt(s.total_giving) + '</div>',
      '<div class="sub">first-time guests: ' + numberFmt(s.total_first_time_guests) + '</div>',
      '</div>',
    ].join('');
  }).join('');
}

function renderTable() {
  const rows = state.weeks
    .filter(function (w) { return state.selectedYears.includes(Number(w.service_date.slice(0, 4))); })
    .sort(function (a, b) { return b.service_date.localeCompare(a.service_date); });

  const flagged = rows.filter(function (w) { return w.issues.length; }).length;
  document.getElementById('tableNote').textContent =
    rows.length + ' weeks' + (flagged ? '  •  ' + flagged + ' carry a note about the source data (hover the ⚑)' : '');

  const head = '<thead><tr>' +
    ['Date', 'Services', 'Adults', 'Kids', 'In person', 'Online', 'Guests', 'Giving', 'Venue']
      .map(function (h) { return '<th>' + h + '</th>'; }).join('') +
    '</tr></thead>';

  const body = rows.map(function (w) {
    const pills = w.highlights.map(function (h) {
      return '<span class="pill" style="background:' + (h.color || '#6c757d') + '">' + (h.label || h.name) + '</span>';
    }).join('');
    const flag = w.issues.length
      ? '<span class="flag" title="' + w.issues.map(function (i) { return i.note.replace(/"/g, '&quot;'); }).join(' | ') + '">⚑</span>'
      : '';
    if (w.status !== 'held') {
      // Giving and guest figures still exist for weeks with no gathering.
      return '<tr class="no-service">' +
        '<td>' + w.service_date + pills + flag + '</td>' +
        '<td colspan="5">no service held</td>' +
        '<td>' + numberFmt(w.metrics.first_time_guests) + '</td>' +
        '<td>' + (w.giving ? moneyFmt(w.giving.tithes_offerings) : '') + '</td>' +
        '<td>' + (w.venue || '') + '</td>' +
        '</tr>';
    }
    return '<tr>' +
      '<td>' + w.service_date + pills + flag + '</td>' +
      '<td>' + w.services.filter(function (s) { return s.kind === 'in_person'; }).length + '</td>' +
      '<td>' + numberFmt(w.adults) + '</td>' +
      '<td>' + numberFmt(w.kids) + '</td>' +
      '<td>' + numberFmt(w.in_person) + '</td>' +
      '<td>' + numberFmt(w.online) + '</td>' +
      '<td>' + numberFmt(w.metrics.first_time_guests) + '</td>' +
      '<td>' + (w.giving ? moneyFmt(w.giving.tithes_offerings) : '') + '</td>' +
      '<td>' + (w.venue || '') + '</td>' +
      '</tr>';
  }).join('');

  document.getElementById('weekTable').innerHTML = head + '<tbody>' + body + '</tbody>';
}

function renderAll() { renderSummary(); renderCharts(); renderTable(); }

// --- Spreadsheet import ----------------------------------------------------

function setImportStatus(kind, message) {
  const el = document.getElementById('importStatus');
  el.innerHTML = message ? '<div class="notice ' + kind + '">' + message + '</div>' : '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function renderImportReport(report) {
  const el = document.getElementById('importReport');
  const parts = [];
  const list = function (items) {
    return '<ul>' + items.map(function (i) { return '<li>' + i + '</li>'; }).join('') + '</ul>';
  };

  parts.push('<h4>What was found</h4>');
  parts.push(list([
    report.weekCount + ' weeks' +
      (report.dateRange ? ', ' + report.dateRange.first + ' to ' + report.dateRange.last : ''),
    numberFmt(report.totals.adults) + ' adults and ' + numberFmt(report.totals.kids) + ' kids in total',
    moneyFmt(report.totals.giving) + ' in tithes and offerings',
    report.totals.weeksNoService + ' weeks with no service held',
  ]));

  if (report.coverage.length) {
    parts.push('<h4>Coverage</h4>');
    parts.push(list(report.coverage.map(function (c) {
      let s = c.year + ': ' + c.present + ' of ' + c.expected + ' Sundays';
      if (c.missingInside.length) s += ' — gaps recorded as no service: ' + c.missingInside.join(', ');
      if (c.missingOutside.length) s += ' <span class="muted">(outside the covered range, not recorded: ' + c.missingOutside.join(', ') + ')</span>';
      return s;
    })));
  }

  if (report.schedules.length) {
    parts.push('<h4>Service schedules</h4>');
    parts.push(list(report.schedules.map(function (s) {
      return s.weeks + ' week(s) — ' + escapeHtml(s.schedule) +
        ' <span class="muted">(' + s.first + ' to ' + s.last + ')</span>';
    })));
  }

  const matchedHighlights = report.highlights.filter(function (h) { return h.matched; });
  if (matchedHighlights.length) {
    parts.push('<h4>Highlighted Sundays</h4>');
    parts.push(list(matchedHighlights.map(function (h) {
      return h.year + ' ' + escapeHtml(h.name) + ': ' + h.date +
        (h.note ? ' <span class="muted">(' + escapeHtml(h.note) + ')</span>' : '');
    })));
  }

  if (report.corrections.length) {
    parts.push('<h4>' + report.corrections.length + ' corrections will be applied</h4>');
    parts.push(list(report.corrections.map(function (c) {
      return c.date + ': ' + escapeHtml(c.note);
    })));
  }

  if (report.givingConflicts.length) {
    parts.push('<h4>Giving conflicts</h4>');
    parts.push(list(report.givingConflicts.map(function (c) {
      return c.date + ': using ' + moneyFmt(c.chosen.value) + ' from the newest sheet, ignoring ' +
        c.rejected.map(function (r) { return moneyFmt(r.value); }).join(', ');
    })));
  }

  if (report.skippedSheets.length) {
    parts.push('<h4>Skipped sheets</h4>');
    parts.push(list(report.skippedSheets.map(function (s) {
      return escapeHtml(s) + ' <span class="muted">(no readable date in cell C1)</span>';
    })));
  }

  if (report.problems.length) {
    parts.push('<h4>Needs a look</h4>');
    parts.push(list(report.problems.map(function (p) { return escapeHtml(p); })));
  }

  el.innerHTML = parts.join('');
}

async function uploadWorkbook(file, dryRun) {
  const res = await fetch('/api/ministry-metrics/import?dryRun=' + (dryRun ? 'true' : 'false'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (res.status === 401) {
    window.location.href = '/ministry-metrics/login';
    throw new Error('Session expired');
  }
  const data = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    if (data.report) renderImportReport(data.report);
    throw new Error(data.error || 'Upload failed with status ' + res.status);
  }
  return data;
}

function wireImport() {
  const card = document.getElementById('importCard');
  const fileInput = document.getElementById('fileInput');
  const checkBtn = document.getElementById('checkBtn');
  const commitBtn = document.getElementById('commitBtn');

  document.getElementById('importToggle').addEventListener('click', function () {
    card.style.display = card.style.display === 'none' ? 'block' : 'none';
    if (card.style.display === 'block') card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // A new file selection invalidates any previously reviewed report.
  fileInput.addEventListener('change', function () {
    commitBtn.style.display = 'none';
    setImportStatus('', '');
    document.getElementById('importReport').innerHTML = '';
  });

  checkBtn.addEventListener('click', async function () {
    const file = fileInput.files[0];
    if (!file) { setImportStatus('warn', 'Choose a .xlsx file first.'); return; }

    checkBtn.disabled = true;
    setImportStatus('', '<span class="spin">Reading ' + escapeHtml(file.name) + '…</span>');
    try {
      const data = await uploadWorkbook(file, true);
      renderImportReport(data.report);
      const problems = data.report.problems.length;
      setImportStatus(
        problems ? 'warn' : 'ok',
        'Read ' + data.report.weekCount + ' weeks. Nothing has been saved yet.' +
          (problems ? ' ' + problems + ' item(s) need a look below — you can still import.' : '')
      );
      commitBtn.textContent = 'Import ' + data.report.weekCount + ' weeks';
      commitBtn.style.display = 'inline-block';
    } catch (err) {
      setImportStatus('bad', escapeHtml(err.message));
      commitBtn.style.display = 'none';
    } finally {
      checkBtn.disabled = false;
    }
  });

  commitBtn.addEventListener('click', async function () {
    const file = fileInput.files[0];
    if (!file) return;

    commitBtn.disabled = true;
    setImportStatus('', '<span class="spin">Importing…</span>');
    try {
      const data = await uploadWorkbook(file, false);
      const s = data.summary;
      setImportStatus(
        'ok',
        'Imported. ' + s.weeksInserted + ' weeks added, ' + s.weeksUpdated + ' updated, ' +
          s.servicesWritten + ' services, ' + s.givingWritten + ' giving rows.'
      );
      commitBtn.style.display = 'none';
      fileInput.value = '';
      await reloadAfterImport();
    } catch (err) {
      setImportStatus('bad', escapeHtml(err.message));
    } finally {
      commitBtn.disabled = false;
    }
  });
}

/** Picks up years that did not exist before the import. */
async function reloadAfterImport() {
  const meta = await getJson('/api/ministry-metrics/meta');
  const hadNoData = state.years.length === 0;
  state.years = meta.years;
  state.metricDefs = meta.metrics;
  state.highlightDefs = meta.highlights;
  if (hadNoData || state.selectedYears.length === 0) {
    state.selectedYears = meta.years.slice(-2);
  }
  showError('');
  populateSelectors();
  renderYearToggles();
  await loadWeeks();
}

function renderYearToggles() {
  const el = document.getElementById('yearToggles');
  el.innerHTML = state.years.map(function (y) {
    const color = YEAR_COLORS[state.years.indexOf(y) % YEAR_COLORS.length];
    const active = state.selectedYears.includes(y);
    return '<button class="year-toggle' + (active ? ' active' : '') + '" data-year="' + y + '"' +
      (active ? ' style="background:' + color + ';border-color:' + color + '"' : '') + '>' + y + '</button>';
  }).join('');

  el.querySelectorAll('.year-toggle').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const year = Number(btn.dataset.year);
      if (state.selectedYears.includes(year)) {
        if (state.selectedYears.length === 1) return; // keep at least one year shown
        state.selectedYears = state.selectedYears.filter(function (y) { return y !== year; });
      } else {
        state.selectedYears.push(year);
      }
      renderYearToggles();
      loadWeeks();
    });
  });
}

async function loadWeeks() {
  try {
    const qs = state.selectedYears.join(',');
    const data = await getJson('/api/ministry-metrics/weeks?years=' + qs);
    state.weeks = data.weeks;
    state.summaries = data.summaries;
    showError('');
    renderAll();
  } catch (err) {
    showError('Could not load metrics: ' + err.message);
  }
}

async function init() {
  // Dark mode, shared with the rest of the Hub.
  const toggle = document.getElementById('darkModeToggle');
  if (localStorage.getItem('darkMode') === 'true') {
    document.body.classList.add('dark-mode');
    toggle.innerHTML = '☀️ Light Mode';
  }
  toggle.addEventListener('click', function () {
    document.body.classList.toggle('dark-mode');
    const dark = document.body.classList.contains('dark-mode');
    toggle.innerHTML = dark ? '☀️ Light Mode' : '🌙 Dark Mode';
    localStorage.setItem('darkMode', String(dark));
    renderCharts();
  });

  document.getElementById('exportBtn').addEventListener('click', function () {
    window.location.href = '/api/ministry-metrics/export.csv?years=' + state.selectedYears.join(',');
  });

  wireImport();

  const metricSelect = document.getElementById('metricSelect');
  metricSelect.addEventListener('change', function () {
    state.metric = metricSelect.value;
    renderCharts();
  });

  const alignSelect = document.getElementById('alignSelect');
  alignSelect.addEventListener('change', function () {
    state.align = alignSelect.value;
    renderCharts();
  });

  try {
    const meta = await getJson('/api/ministry-metrics/meta');
    state.years = meta.years;
    state.metricDefs = meta.metrics;
    state.highlightDefs = meta.highlights;
    state.selectedYears = meta.years.slice(-2);

    // With nothing imported, lead with the importer rather than empty charts.
    if (!state.years.length) {
      document.getElementById('importCard').style.display = 'block';
      setImportStatus('warn', 'No metrics have been imported yet. Upload a weekly numbers spreadsheet to get started.');
      return;
    }

    populateSelectors();
    renderYearToggles();
    await loadWeeks();
  } catch (err) {
    showError('Could not load metrics: ' + err.message);
  }
}

/** Fills the metric and alignment menus. Listeners are wired once, in init. */
function populateSelectors() {
  const metricSelect = document.getElementById('metricSelect');
  metricSelect.innerHTML =
    '<optgroup label="Attendance">' +
    DERIVED_METRICS.map(function (m) { return '<option value="' + m.key + '">' + m.label + '</option>'; }).join('') +
    '</optgroup>' +
    '<optgroup label="Ministries &amp; response">' +
    state.metricDefs.map(function (m) { return '<option value="' + m.key + '">' + m.label + '</option>'; }).join('') +
    '</optgroup>';
  metricSelect.value = state.metric;

  const alignSelect = document.getElementById('alignSelect');
  alignSelect.innerHTML =
    '<option value="calendar">Calendar week</option>' +
    state.highlightDefs
      .filter(function (h) { return h.is_anchor; })
      .map(function (h) { return '<option value="' + h.key + '">Aligned on ' + h.name + '</option>'; })
      .join('');
  alignSelect.value = state.align;
}

init();
</script>
</body>
</html>`;
}
