// ═══════════════════════════════════════════════════════════════════
// ElaksInsights site Worker — static assets + push-notification cron
// - fetch: passes every request through to the static assets (the app)
// - scheduled (*/10 min): during US market hours, checks manual price
//   alerts + big watchlist moves (±5% / ±10%) and sends web push.
// Secrets required (Worker → Settings → Variables and Secrets):
//   VAPID_PRIVATE_JWK = the private JWK JSON (provided separately)
// ═══════════════════════════════════════════════════════════════════

const FB_PID = 'stockr-app-65c0e';
const FB_KEY = 'AIzaSyBOgX2B9euy64XMO7gBfHWvWctN74Wt2Tc';
const VAPID_PUBLIC = 'BBNxXzgIrc3nd5X76uEz8AfLd6k_kdjh1y6YV3oX-hPJ_22MKyZdhwIyjRLOvqSJudU05gk1oF9ImKEWo5iAFQk';
const VAPID_SUB = 'mailto:darko.savevski@gmail.com';

export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlertCheck(env).catch(e => console.log('cron error:', e.message)));
  },
};

// ── Firestore helpers (same {fields:{d:{stringValue}}} convention as the app) ──
async function fbRead(path) {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${FB_PID}/databases/(default)/documents/${path}?key=${FB_KEY}`);
  if (!r.ok) return null;
  const doc = await r.json();
  const raw = doc?.fields?.d?.stringValue;
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function fbWrite(path, obj) {
  await fetch(`https://firestore.googleapis.com/v1/projects/${FB_PID}/databases/(default)/documents/${path}?key=${FB_KEY}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { d: { stringValue: JSON.stringify(obj) } } }),
  });
}

// ── Quotes (Yahoo, no key needed server-side) ──
async function quote(t) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const d = await r.json();
    const m = d?.chart?.result?.[0]?.meta;
    if (!m?.regularMarketPrice) return null;
    const c = m.regularMarketPrice, pc = m.chartPreviousClose || m.previousClose;
    return { c, dp: pc ? (c / pc - 1) * 100 : 0 };
  } catch { return null; }
}

// ── The cron job ──
async function runAlertCheck(env) {
  // Guard: US market hours-ish, Mon–Fri 13:00–21:30 UTC
  const now = new Date();
  const day = now.getUTCDay(), hr = now.getUTCHours(), min = now.getUTCMinutes();
  if (day === 0 || day === 6) return;
  if (hr < 13 || hr > 21 || (hr === 21 && min > 30)) return;

  const registry = await fbRead('stockr_push/registry');
  if (!registry?.users) return;
  const dateKey = now.toISOString().split('T')[0];
  const fired = (await fbRead('stockr_push/fired')) || {};
  if (fired._date !== dateKey) { for (const k of Object.keys(fired)) delete fired[k]; fired._date = dateKey; }

  const allMessages = [];
  let firedChanged = false;

  for (const [uid, u] of Object.entries(registry.users)) {
    if (!u?.subs?.length) continue;
    const base = uid === 'guest' ? 'stockr_guest/data' : `stockr_users/${uid}/data`;

    // tolerant extraction of stored shapes
    const alertsDoc = await fbRead(`${base}/alerts`);
    const watchDoc  = await fbRead(`${base}/watch`);
    const alerts = Array.isArray(alertsDoc) ? alertsDoc : (alertsDoc?.alerts || alertsDoc?.priceAlerts || []);
    const watch  = (Array.isArray(watchDoc) ? watchDoc : (watchDoc?.watch || watchDoc?.items || []))
                   .map(w => (typeof w === 'string' ? w : w?.ticker)).filter(Boolean);

    const tickers = [...new Set([...alerts.map(a => a.ticker), ...watch])];
    if (!tickers.length) continue;

    const quotes = {};
    for (const t of tickers.slice(0, 30)) quotes[t] = await quote(t);

    const userMsgs = [];

    // 1) manual price alerts (fire once per level per day)
    for (const a of alerts) {
      const q = quotes[a.ticker]; if (!q) continue;
      const hit = a.direction === 'below' ? q.c <= a.targetPrice : q.c >= a.targetPrice;
      const key = `m:${uid}:${a.ticker}:${a.direction}:${a.targetPrice}`;
      if (hit && !fired[key]) {
        fired[key] = 1; firedChanged = true;
        userMsgs.push({ title: `🎯 ${a.ticker} alert`, body: `${a.ticker} is $${q.c.toFixed(2)} — crossed your ${a.direction || 'above'} $${a.targetPrice} alert.` });
      }
    }

    // 2) automatic big-move alerts for watchlist (±5% then ±10%, each once per day)
    if (u.moveAlerts !== false) {
      for (const t of watch) {
        const q = quotes[t]; if (!q) continue;
        for (const lvl of [10, 5]) { // check 10 first so a huge move sends the bigger headline
          const key = `v:${uid}:${t}:${lvl}`;
          if (Math.abs(q.dp) >= lvl && !fired[key]) {
            fired[key] = 1; firedChanged = true;
            userMsgs.push({ title: `${q.dp >= 0 ? '🚀' : '📉'} ${t} ${q.dp >= 0 ? '+' : ''}${q.dp.toFixed(1)}% today`, body: `${t} moved ${q.dp >= 0 ? 'up' : 'down'} more than ${lvl}% — now $${q.c.toFixed(2)}.` });
            break; // one move-notification per ticker per run
          }
        }
      }
    }

    if (!userMsgs.length) continue;
    allMessages.push(...userMsgs);

    // write messages for the service worker to fetch, then push (empty payload)
    await fbWrite('stockr_push/latest', { ts: Date.now(), messages: allMessages });
    const jwtCache = {};
    const deadEndpoints = [];
    for (const sub of u.subs) {
      const status = await sendPush(sub, env, jwtCache);
      if (status === 404 || status === 410) deadEndpoints.push(sub.endpoint);
    }
    if (deadEndpoints.length) {
      u.subs = u.subs.filter(s => !deadEndpoints.includes(s.endpoint));
      await fbWrite('stockr_push/registry', registry);
    }
  }

  if (firedChanged) await fbWrite('stockr_push/fired', fired);
}

// ── Web push with VAPID (empty payload → no RFC8291 encryption needed) ──
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function vapidJwt(audience, env) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64u(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(new TextEncoder().encode(JSON.stringify({
    aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUB,
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64u(sig)}`;
}

async function sendPush(sub, env, jwtCache) {
  try {
    const aud = new URL(sub.endpoint).origin;
    if (!jwtCache[aud]) jwtCache[aud] = await vapidJwt(aud, env);
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `vapid t=${jwtCache[aud]}, k=${VAPID_PUBLIC}`,
        'TTL': '300',
        'Content-Length': '0',
      },
    });
    console.log('push →', sub.endpoint.slice(0, 50), r.status);
    return r.status;
  } catch (e) { console.log('push failed:', e.message); return 0; }
}
