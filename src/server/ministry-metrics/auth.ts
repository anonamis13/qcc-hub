import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Shared-password protection for Ministry Metrics.
 *
 * This is the only authenticated area of QCC Hub. It exists because the section
 * holds giving figures; the rest of the Hub remains open.
 *
 * The password is never stored, only a scrypt hash held in the
 * METRICS_PASSWORD_HASH environment variable. scrypt is used rather than bcrypt
 * because it ships with Node and avoids adding a second native dependency.
 */

const COOKIE_NAME = 'qcc_mm_session';
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000; // 12 hours

// scrypt parameters. N is the work factor; 2^15 keeps a single verification in
// the tens of milliseconds, which is ample for a login that happens rarely.
const SCRYPT_N = 32768;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LENGTH = 32;

function scryptHash(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    // scrypt's default maxmem is below what this work factor needs.
    maxmem: 128 * SCRYPT_N * SCRYPT_r * 2,
  });
}

/** Produces the value to store in METRICS_PASSWORD_HASH. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = scryptHash(password, salt);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const actual = scryptHash(password, salt);
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function configuredHash(): string | null {
  const value = process.env.METRICS_PASSWORD_HASH;
  return value && value.trim() !== '' ? value.trim() : null;
}

export function isConfigured(): boolean {
  return configuredHash() !== null;
}

/**
 * Key used to sign session cookies. Derived from the password hash so that
 * changing the password invalidates every existing session, and so the feature
 * needs only one environment variable.
 */
function signingKey(): Buffer {
  const hash = configuredHash() ?? '';
  return crypto.createHmac('sha256', hash).update('qcc-ministry-metrics-session-v1').digest();
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

function createSessionValue(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_DURATION_MS })).toString(
    'base64url'
  );
  return `${payload}.${sign(payload)}`;
}

function isValidSession(value: string | undefined): boolean {
  if (!value) return false;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return false;

  const payload = value.slice(0, dot);
  const signature = value.slice(dot + 1);

  const expected = Buffer.from(sign(payload));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length) return false;
  if (!crypto.timingSafeEqual(expected, provided)) return false;

  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

/** Express does not parse cookies and the app has no cookie middleware. */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

export function setSessionCookie(res: Response) {
  const secure = process.env.NODE_ENV === 'production';
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=${createSessionValue()}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}`,
    ...(secure ? ['Secure'] : []),
  ].join('; '));
}

export function clearSessionCookie(res: Response) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function isAuthenticated(req: Request): boolean {
  return isValidSession(readCookie(req, COOKIE_NAME));
}

// ---------------------------------------------------------------------------
// Login throttling
//
// A single shared password is the whole protection, so repeated guesses are
// rate limited per client address.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; firstAt: number }>();

function clientKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export function isThrottled(req: Request): boolean {
  const record = attempts.get(clientKey(req));
  if (!record) return false;
  if (Date.now() - record.firstAt > ATTEMPT_WINDOW_MS) {
    attempts.delete(clientKey(req));
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

export function recordFailedAttempt(req: Request) {
  const key = clientKey(req);
  const record = attempts.get(key);
  if (!record || Date.now() - record.firstAt > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: Date.now() });
  } else {
    record.count++;
  }
}

export function clearAttempts(req: Request) {
  attempts.delete(clientKey(req));
}

/**
 * Gate for every Ministry Metrics route. Fails closed when no password is
 * configured: the alternative would leave giving figures publicly readable.
 */
export function requireMetricsAuth(req: Request, res: Response, next: NextFunction) {
  // Mounted with a path prefix, so req.path is relative to the mount point;
  // originalUrl is what distinguishes an API call from a page request.
  const wantsJson = req.originalUrl.startsWith('/api/');

  if (!isConfigured()) {
    if (wantsJson) {
      return res.status(503).json({
        error: 'Ministry Metrics is not configured. METRICS_PASSWORD_HASH is not set.',
      });
    }
    return res.status(503).send(renderSetupPage());
  }

  if (isAuthenticated(req)) return next();

  if (wantsJson) {
    return res.status(401).json({ error: 'Not signed in' });
  }
  return res.redirect('/ministry-metrics/login');
}

const PAGE_SHELL = (title: string, body: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QCC Hub - ${title}</title>
  <link rel="icon" type="image/x-icon" href="https://www.queencitypeople.com/favicon.ico">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #f8f9fa; color: #333; padding: 20px; box-sizing: border-box;
    }
    body.dark-mode { background: #1a1a1a; color: #e8e8e8; }
    .card {
      background: #fff; padding: 36px; border-radius: 12px; max-width: 420px; width: 100%;
      box-shadow: 0 4px 16px rgba(0,0,0,0.1); box-sizing: border-box;
    }
    body.dark-mode .card { background: #2d2d2d; }
    h1 { margin: 0 0 6px; font-size: 1.5em; }
    p.sub { margin: 0 0 24px; opacity: 0.7; font-size: 0.92em; line-height: 1.5; }
    label { display: block; font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; opacity: 0.7; margin-bottom: 6px; }
    input {
      width: 100%; padding: 11px 12px; font-size: 1em; font-family: inherit;
      border: 1px solid #ced4da; border-radius: 6px; box-sizing: border-box; background: #fff; color: #333;
    }
    body.dark-mode input { background: #363636; color: #e8e8e8; border-color: #495057; }

    .password-field { position: relative; }
    /* Leaves room for the reveal button so typed text never runs underneath it. */
    .password-field input { padding-right: 46px; }
    .reveal {
      position: absolute; top: 0; right: 0; height: 100%; width: 42px;
      display: flex; align-items: center; justify-content: center;
      margin: 0; padding: 0;
      background: none; border: none; border-radius: 0 6px 6px 0;
      color: #6c757d; cursor: pointer;
    }
    .reveal:hover { background: rgba(127,127,127,0.12); color: #333; }
    body.dark-mode .reveal:hover { color: #e8e8e8; }
    .reveal:focus-visible { outline: 2px solid #0d6efd; outline-offset: -2px; }
    .reveal svg { width: 20px; height: 20px; display: block; }
    button {
      width: 100%; margin-top: 18px; padding: 12px; font-size: 1em; font-family: inherit; font-weight: 600;
      background: #0d6efd; color: #fff; border: none; border-radius: 6px; cursor: pointer;
    }
    button:hover { background: #0a58ca; }
    .error { margin-top: 18px; padding: 12px; border-radius: 6px; background: #f8d7da; color: #842029; font-size: 0.9em; }
    body.dark-mode .error { background: #4a1d24; color: #f5c2c7; }
    code { background: rgba(127,127,127,0.18); padding: 2px 6px; border-radius: 4px; font-size: 0.88em; word-break: break-all; }
    pre { background: rgba(127,127,127,0.12); padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 0.85em; }
    a { color: #0d6efd; }
    body.dark-mode a { color: #6ea8fe; }
  </style>
</head>
<body>
  <div class="card">${body}</div>
  <script>
    if (localStorage.getItem('darkMode') === 'true') document.body.classList.add('dark-mode');
  </script>
</body>
</html>`;

export function renderLoginPage(error?: string): string {
  return PAGE_SHELL(
    'Ministry Metrics',
    `
    <h1>Ministry Metrics</h1>
    <p class="sub">This section contains giving figures and is password protected.</p>
    <form method="POST" action="/ministry-metrics/login">
      <label for="password">Password</label>
      <div class="password-field">
        <input type="password" id="password" name="password" autocomplete="current-password" autofocus required>
        <button type="button" class="reveal" id="revealBtn" aria-label="Show password" aria-pressed="false">
          <svg id="eyeOpen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
          <svg id="eyeClosed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:none">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path>
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path>
            <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"></path>
            <line x1="1" y1="1" x2="23" y2="23"></line>
          </svg>
        </button>
      </div>
      <button type="submit">Sign in</button>
    </form>
    <script>
      (function () {
        var input = document.getElementById('password');
        var btn = document.getElementById('revealBtn');
        var eyeOpen = document.getElementById('eyeOpen');
        var eyeClosed = document.getElementById('eyeClosed');

        btn.addEventListener('click', function () {
          var reveal = input.type === 'password';
          input.type = reveal ? 'text' : 'password';
          eyeOpen.style.display = reveal ? 'none' : 'block';
          eyeClosed.style.display = reveal ? 'block' : 'none';
          btn.setAttribute('aria-pressed', String(reveal));
          btn.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
          // Keep the caret where it was rather than jumping to the start.
          var end = input.value.length;
          input.focus();
          input.setSelectionRange(end, end);
        });
      })();
    </script>
    ${error ? `<div class="error">${error}</div>` : ''}
    <p class="sub" style="margin-top:24px;margin-bottom:0">
      <a href="/home-page">&larr; Back to QCC Hub</a>
    </p>
  `
  );
}

function renderSetupPage(): string {
  return PAGE_SHELL(
    'Setup required',
    `
    <h1>Setup required</h1>
    <p class="sub">
      Ministry Metrics holds giving figures, so it stays closed until a password
      is configured. Generate a hash and set it as an environment variable:
    </p>
    <pre>npm run build
node dist/server/ministry-metrics/cli-hash-password.js "your password"</pre>
    <p class="sub">
      Put the output in <code>METRICS_PASSWORD_HASH</code> in your <code>.env</code>
      file locally, and in the environment settings on Render, then restart.
    </p>
    <p class="sub" style="margin-bottom:0">
      <a href="/home-page">&larr; Back to QCC Hub</a>
    </p>
  `
  );
}
