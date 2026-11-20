/* One Vercel function for every route (vercel.json rewrites /api/* here).
 *   POST /api/telegram   Telegram webhook (secret header checked)
 *   GET  /api/cron       the 5-minute timer (cron-job.org)      ?key=CRON_SECRET  or  Authorization: Bearer CRON_SECRET
 *   GET  /api/daily      Vercel Cron once a day: timer watchdog + daily report to admins
 *   GET  /api/setup      ?key=CRON_SECRET  creates the tables, connects the bot to this site, sets the command menu
 *   GET  /api/health
 */
import crypto from 'node:crypto';
import { cfg } from '../lib/config.js';
import { db } from '../lib/db.js';
import { tg } from '../lib/tg.js';
import { handleUpdate, setCommands } from '../lib/bot.js';
import { runCycle } from '../lib/monitor.js';

function reply(res, code, obj) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(obj));
}

function same(a, b) {
  if (!a || !b) return false;
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/* the secret Telegram sends with every update (made from CRON_SECRET, so there is one secret to keep) */
export const webhookSecret = () => crypto.createHmac('sha256', cfg.secret()).update('telegram-webhook').digest('hex').slice(0, 48);

function keyOk(req, url) {
  if (!cfg.secret()) return false;
  const auth = String(req.headers.authorization || '');
  return same(url.searchParams.get('key'), cfg.secret()) || same(auth.replace(/^Bearer\s+/i, ''), cfg.secret());
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 1e6) throw new Error('too big'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export default async function handler(req, res) {
  const url = new URL(req.url || '/', 'http://local');
  const path = url.pathname.replace(/\/+$/, '');
  try {
    if (path === '/api/health') return reply(res, 200, { ok: true, time: new Date().toISOString() });

    if (path === '/api/telegram') {
      if (req.method !== 'POST') return reply(res, 405, { ok: false });
      if (!cfg.secret() || !same(req.headers['x-telegram-bot-api-secret-token'], webhookSecret())) return reply(res, 401, { ok: false });
      let body;
      try { body = await readJson(req); } catch (e) { return reply(res, 400, { ok: false }); }
      try { await handleUpdate(body); } catch (e) { console.error('update failed', e); }   // always 200: a broken update is not re-sent forever
      return reply(res, 200, { ok: true });
    }

    if (path === '/api/cron' || path === '/api/daily') {
      if (!keyOk(req, url)) return reply(res, 401, { ok: false, error: 'bad key' });
      const r = await runCycle({ daily: path === '/api/daily' });
      return reply(res, 200, r);
    }

    if (path === '/api/setup') {
      if (!keyOk(req, url)) return reply(res, 401, { ok: false, error: 'bad key' });
      const problems = [];
      if (!cfg.token()) problems.push('BOT_TOKEN is not set');
      try { await db(); } catch (e) { problems.push('database: ' + e.message); }
      if (problems.length) return reply(res, 500, { ok: false, problems });
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      const me = await tg('getMe', {});
      if (!me.ok) return reply(res, 500, { ok: false, problems: ['BOT_TOKEN rejected by Telegram: ' + (me.description || '')] });
      const hook = await tg('setWebhook', {
        url: `https://${host}/api/telegram`, secret_token: webhookSecret(),
        allowed_updates: ['message', 'callback_query'], max_connections: 20,
      });
      const cmds = await setCommands();
      return reply(res, hook.ok ? 200 : 500, {
        ok: hook.ok && cmds, bot: '@' + me.result.username, webhook: hook.ok ? `https://${host}/api/telegram` : hook.description,
        commands: cmds ? 'set' : 'failed', timerUrl: `https://${host}/api/cron?key=<CRON_SECRET>`,
      });
    }

    return reply(res, 404, { ok: false });
  } catch (e) {
    console.error(e);
    return reply(res, 500, { ok: false, error: 'server error' });
  }
}
