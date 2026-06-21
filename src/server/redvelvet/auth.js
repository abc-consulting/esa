'use strict';

const { extractHiddenFields } = require('../utils/html');
const { REQUEST_TIMEOUT_MS } = require('../constants');

const LOGIN_URL = 'https://redvelvet.co.za/userlogin/login';

let sessionCookie = null;
let loginInProgress = null;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function doLogin() {
  const email    = process.env.RV_EMAIL    || '';
  const password = process.env.RV_PASSWORD || '';

  if (!email || !password) return null;

  // Step 1: GET the login page to capture ASP.NET state fields + any Set-Cookie
  const getRes = await fetchWithTimeout(LOGIN_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    redirect: 'follow',
  });
  if (!getRes.ok) throw new Error(`Login page fetch failed: HTTP ${getRes.status}`);

  const getCookies = getRes.headers.get('set-cookie') || '';
  const html = await getRes.text();
  const fields = extractHiddenFields(html);

  // Step 2: POST credentials
  const params = new URLSearchParams(fields);
  params.set('ctl00$ContentPlaceHolder1$txtLoginEmail',    email);
  params.set('ctl00$ContentPlaceHolder1$txtLoginPassword', password);
  params.set('ctl00$ContentPlaceHolder1$Button1',          'Login to VIP Access');

  const postRes = await fetchWithTimeout(LOGIN_URL, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': LOGIN_URL,
      ...(getCookies ? { Cookie: parseCookieHeader(getCookies) } : {}),
    },
    body: params.toString(),
    redirect: 'manual',
  });

  console.log(`[RV Auth] POST status: ${postRes.status}, location: ${postRes.headers.get('location') || '(none)'}`);

  // A successful login results in a redirect; collect the session cookie from POST response
  // (falls back to GET cookie if POST set no new cookie)
  const setCookie = postRes.headers.get('set-cookie') || '';
  const cookie = parseCookieHeader(setCookie) || parseCookieHeader(getCookies);

  if (!cookie) {
    console.warn('[RV Auth] Login did not yield a session cookie');
    return null;
  }

  console.log('[RV Auth] Logged in successfully, cookie:', cookie.slice(0, 60));
  return cookie;
}

function parseCookieHeader(raw) {
  // Extract name=value pairs, strip directives like Path, HttpOnly, Expires
  return raw
    .split(/,(?=[^;]+=)/)
    .map(part => part.trim().split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function getSessionCookie() {
  if (sessionCookie) return sessionCookie;

  // Deduplicate concurrent login attempts
  if (!loginInProgress) {
    loginInProgress = doLogin()
      .then(cookie => { sessionCookie = cookie; return cookie; })
      .catch(err => { console.error('[RV Auth] Login failed:', err.message); return null; })
      .finally(() => { loginInProgress = null; });
  }

  return loginInProgress;
}

function clearSessionCookie() {
  sessionCookie = null;
}

module.exports = { getSessionCookie, clearSessionCookie };
