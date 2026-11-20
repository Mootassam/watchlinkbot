/* Is a link up? Open it like a browser would; on failure try once more a few seconds later
   (so a 1-second blip never sends an alert). */
import dns from 'node:dns/promises';
import net from 'node:net';
import { cfg } from './config.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 LinkWatch/1.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* what the client typed -> a clean link, or an error code: empty | long | bad | scheme */
export function normalize(input) {
  let s = String(input || '').trim().replace(/^[<(\["']+|[>)\]"',.;]+$/g, '');
  if (!s) return { error: 'empty' };
  if (s.length > 500) return { error: 'long' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:/]+:\d+([/?#]|$)/.test(s)) return { error: 'scheme' };   // mailto:, ftp: … (host:port is fine)
    s = 'https://' + s;
  }
  let u;
  try { u = new URL(s); } catch (e) { return { error: 'bad' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'scheme' };
  if (u.username || u.password) return { error: 'bad' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || (!host.includes('.') && !net.isIP(host) && host !== 'localhost')) return { error: 'bad' };
  if (/[^a-z0-9.\-:]/i.test(host)) return { error: 'bad' };
  u.hash = '';
  let url = u.toString();
  if (u.pathname === '/' && !u.search) url = url.replace(/\/$/, '');
  return { url, host };
}

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return privateIp(x.slice(7));
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}

/* links to the server's own private network are refused (nobody can use the bot to poke inside Vercel) */
export async function isPrivateHost(host) {
  if (cfg.allowPrivate()) return false;
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIP(h)) return privateIp(h);
  try {
    const all = await dns.lookup(h, { all: true });
    return all.some((a) => privateIp(a.address));
  } catch (e) { return false; }                                       // unknown domain: the check reports "domain not found"
}

function why(e) {
  const cause = (e && e.cause) || {};
  const code = String(cause.code || (e && e.code) || '');
  const msg = `${(e && e.message) || ''} ${cause.message || ''}`;
  const name = (e && e.name) || '';
  if (name === 'TimeoutError' || name === 'AbortError' || /TIMEOUT|ETIMEDOUT/.test(code)) return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME' || code === 'EAI_NODATA') return 'dns';
  if (code === 'CERT_HAS_EXPIRED' || /certificate has expired/i.test(msg)) return 'ssl_expired';
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/i.test(code) || /certificate|ssl|tls/i.test(msg)) return 'ssl';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET' || /other side closed|socket hang up/i.test(msg)) return 'reset';
  if (/redirect/i.test(msg)) return 'redirects';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'unreachable';
  return 'error';
}

/* the server answered: 2xx/3xx, or "you need to log in / slow down" = it is running */
const ANSWERED = new Set([401, 403, 405, 406, 429]);

export async function probe(url, timeoutMs = cfg.timeout()) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en,zh;q=0.8', 'cache-control': 'no-cache' },
    });
    const ms = Date.now() - t0;
    try { if (r.body) await r.body.cancel(); } catch (e) { /* ignore */ }
    const up = r.status < 400 || ANSWERED.has(r.status);
    return { up, code: r.status, ms, reason: up ? '' : 'http' };
  } catch (e) {
    return { up: false, code: null, ms: Date.now() - t0, reason: why(e) };
  }
}

export async function checkUrl(url, { retry = true } = {}) {
  let host = '';
  try { host = new URL(url).hostname; } catch (e) { return { up: false, code: null, ms: 0, reason: 'error' }; }
  if (await isPrivateHost(host)) return { up: false, code: null, ms: 0, reason: 'blocked' };
  const first = await probe(url);
  if (first.up || !retry) return first;
  await sleep(cfg.retryGap());
  return probe(url);
}
