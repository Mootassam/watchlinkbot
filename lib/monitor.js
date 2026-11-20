/* The watcher: check links, record up/down, tell the client (and the admins) only when something CHANGES. */
import { q, getMeta, setMeta } from './db.js';
import { cfg } from './config.js';
import { checkUrl } from './check.js';
import { send, sendLong, isGone, esc } from './tg.js';
import { t, reasonText, dur, ago, who, ICON } from './text.js';

export const EVERY_MIN = 5;

export async function admins() {
  const ids = cfg.adminIds();
  const rows = await q(`SELECT * FROM users WHERE (is_admin OR chat_id = ANY($1::text[])) AND NOT blocked`, [ids]);
  return rows;
}

export async function markGone(chatId) {
  await q('UPDATE users SET blocked = true WHERE chat_id = $1', [String(chatId)]);
}

/* send, and remember people who blocked the bot (no more checks / messages for them) */
export async function notify(chatId, html, extra) {
  const r = await send(chatId, html, extra);
  if (isGone(r)) await markGone(chatId);
  return r;
}

async function pool(items, n, fn, canStart) {
  let i = 0;
  const worker = async () => { while (i < items.length && canStart()) { const it = items[i++]; await fn(it); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/* Check these link rows (from the links table). The same URL watched by many clients is opened once.
   Writes each result; a status change is written with "WHERE status <> new" so two runs at once can't both alert.
   Returns { changes: [{ link, from, to, result }], checked, results: Map url -> result } */
export async function checkLinks(rows, { budgetStart = Infinity } = {}) {
  const byUrl = new Map();
  for (const r of rows) { if (!byUrl.has(r.url)) byUrl.set(r.url, []); byUrl.get(r.url).push(r); }
  const urls = [...byUrl.keys()];
  const results = new Map();
  const changes = [];
  const t0 = Date.now();
  await pool(urls, cfg.parallel(), async (url) => {
    const res = await checkUrl(url);
    results.set(url, res);
    const to = res.up ? 'up' : 'down';
    for (const link of byUrl.get(url)) {
      const moved = await q(
        `UPDATE links SET status = $2, reason = $3, code = $4, ms = $5, last_check = now(), since = now()
           WHERE id = $1 AND status <> $2 RETURNING id`, [link.id, to, res.reason, res.code, res.ms]);
      if (moved.length) changes.push({ link, from: link.status, to, result: res });
      else await q(`UPDATE links SET reason = $2, code = $3, ms = $4, last_check = now() WHERE id = $1`, [link.id, res.reason, res.code, res.ms]);
    }
  }, () => Date.now() - t0 < budgetStart);
  return { changes, checked: results.size, results };
}

/* Tell people about changes. New link -> up is not news. One message per person per run.
   ownerToo=false: the client is looking at the result already (/check, adding a link). */
export async function announce(changes, { ownerToo = true } = {}) {
  const real = changes.filter((c) => !(c.from === 'new' && c.to === 'up'));
  if (!real.length) return;
  const chats = [...new Set(real.map((c) => c.link.chat_id))];
  const users = new Map((await q('SELECT * FROM users WHERE chat_id = ANY($1::text[])', [chats])).map((u) => [u.chat_id, u]));
  const contact = await getMeta('contact');

  const textFor = (c, lang) => {
    const L = t(lang);
    if (c.to === 'down') return `${L.alertDown}\n${esc(c.link.url)}\n↳ ${esc(reasonText(c.result.reason, c.result.code, lang))}`;
    const was = c.link.since && c.from === 'down' ? `\n↳ ${L.wasDown(dur((Date.now() - new Date(c.link.since).getTime()) / 1000, lang))}` : '';
    return `${L.alertUp}\n${esc(c.link.url)}${was}`;
  };

  const adminList = await admins();
  const adminIds = new Set(adminList.map((a) => a.chat_id));

  if (ownerToo) {
    for (const chat of chats) {
      const u = users.get(chat);
      if (!u || u.blocked) continue;
      const mine = real.filter((c) => c.link.chat_id === chat).sort((a, b) => (a.to === b.to ? 0 : a.to === 'down' ? -1 : 1));
      const parts = mine.map((c) => textFor(c, u.lang));
      if (contact && mine.some((c) => c.to === 'down') && !adminIds.has(chat)) parts.push(t(u.lang).contact(contact));
      const r = await sendLong(chat, parts.join('\n\n').split('\n'));
      if (isGone(r)) await markGone(chat);
    }
  }

  for (const a of adminList) {
    const others = real.filter((c) => c.link.chat_id !== a.chat_id);
    if (!others.length) continue;
    const L = t(a.lang);
    const lines = [L.changes];
    for (const chat of [...new Set(others.map((c) => c.link.chat_id))]) {
      const u = users.get(chat) || { name: chat };
      lines.push('', `👤 ${who(u)}`);
      for (const c of others.filter((x) => x.link.chat_id === chat)) {
        const extra = c.to === 'down'
          ? reasonText(c.result.reason, c.result.code, a.lang)
          : (c.link.since && c.from === 'down' ? L.wasDown(dur((Date.now() - new Date(c.link.since).getTime()) / 1000, a.lang)) : '');
        lines.push(`${ICON[c.to]} ${esc(c.link.url)}${extra ? ' — ' + esc(extra) : ''}`);
      }
    }
    const r = await sendLong(a.chat_id, lines);
    if (isGone(r)) await markGone(a.chat_id);
  }
}

/* One timer run (every 5 minutes from cron-job.org, once a day from Vercel). Only one run at a time. */
export async function runCycle({ daily = false } = {}) {
  const lock = await q(
    `INSERT INTO meta (key, value, until) VALUES ('lock', '', now() + interval '2 minutes')
       ON CONFLICT (key) DO UPDATE SET until = EXCLUDED.until WHERE meta.until IS NULL OR meta.until < now() RETURNING key`);
  if (!lock.length) return { ok: true, skipped: 'another run is busy' };
  const t0 = Date.now();
  try {
    const prev = await getMeta('last_run');
    const staleMs = cfg.staleMin() * 60000;
    // the daily run notices a dead 5-minute timer (cron-job.org off) and tells the admins
    if (daily && prev && Date.now() - new Date(prev).getTime() > staleMs) {
      for (const a of await admins()) await notify(a.chat_id, t(a.lang).stale(ago(prev, a.lang)));
    }
    const rows = await q(
      `SELECT l.* FROM links l JOIN users u ON u.chat_id = l.chat_id WHERE NOT u.blocked ORDER BY l.last_check ASC NULLS FIRST, l.id`);
    const { changes, checked } = await checkLinks(rows, { budgetStart: cfg.startWindow() });
    await announce(changes);
    const took = Math.round((Date.now() - t0) / 1000);
    await setMeta('last_run', new Date().toISOString());
    await setMeta('last_stats', JSON.stringify({ took, checked }));
    if (daily) {
      await q(`DELETE FROM seen_updates WHERE at < now() - interval '3 days'`);
      const s = await totals();
      for (const a of await admins()) {
        const L = t(a.lang);
        const down = await q(`SELECT l.*, u.name, u.username FROM links l JOIN users u ON u.chat_id = l.chat_id WHERE l.status = 'down' ORDER BY l.since`);
        const lines = [L.daily(s.clients, s.links, s.up, s.down)];
        for (const l of down) lines.push(`🔴 ${esc(l.url)} — ${who(l)}`);
        await sendLong(a.chat_id, lines);
      }
    }
    return { ok: true, checked, changes: changes.length, took };
  } finally {
    await q(`UPDATE meta SET until = now() WHERE key = 'lock'`);
  }
}

export async function totals() {
  const [c] = await q(`SELECT COUNT(*)::int AS n FROM users`);
  const [l] = await q(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE status = 'up')::int AS up, COUNT(*) FILTER (WHERE status = 'down')::int AS down FROM links`);
  return { clients: c.n, links: l.n, up: l.up, down: l.down };
}
