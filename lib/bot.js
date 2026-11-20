/* Telegram messages and button presses. Private chats only. */
import crypto from 'node:crypto';
import { q, getMeta, setMeta } from './db.js';
import { cfg } from './config.js';
import { normalize, isPrivateHost } from './check.js';
import { tg, send, sendLong, esc } from './tg.js';
import { t, langOf, linkCard, short, LINE, ago, day, LANGS, reasonText } from './text.js';
import { checkLinks, announce, admins, notify, totals, EVERY_MIN } from './monitor.js';

const MAX_PER_MESSAGE = 20;
const CLIENT_CMDS = { en: [['list', 'Your links 🟢/🔴'], ['check', 'Check all links now'], ['remove', 'Stop watching a link'], ['lang', 'Language / 语言'], ['help', 'How to use']],
  zh: [['list', '我的链接 🟢/🔴'], ['check', '立即检查所有链接'], ['remove', '停止监控链接'], ['lang', '语言 / Language'], ['help', '使用帮助']] };
const ADMIN_CMDS = { en: [['all', 'All clients + links'], ['down', 'Links down now'], ['clients', 'Client list'], ['status', 'Timer + totals'], ['contact', 'Contact in alerts']],
  zh: [['all', '所有客户和链接'], ['down', '当前宕机链接'], ['clients', '客户列表'], ['status', '定时器和统计'], ['contact', '通知中的联系方式']] };
const cmdList = (lang, admin) => [...CLIENT_CMDS[lang], ...(admin ? ADMIN_CMDS[lang] : [])].map(([command, description]) => ({ command, description }));

export async function setCommands() {
  const out = [];
  out.push(await tg('setMyCommands', { commands: cmdList('en', false) }));
  out.push(await tg('setMyCommands', { commands: cmdList('zh', false), language_code: 'zh' }));
  for (const a of await admins()) await adminMenu(a);
  return out.every((r) => r.ok);
}
const adminMenu = (u) => tg('setMyCommands', { commands: cmdList(u.lang, true), scope: { type: 'chat', chat_id: Number(u.chat_id) } });

function isAdmin(u) { return u.is_admin || cfg.adminIds().includes(u.chat_id); }

async function upsertUser(from, chatId) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 100);
  const rows = await q(
    `INSERT INTO users (chat_id, name, username, lang) VALUES ($1, $2, $3, $4)
       ON CONFLICT (chat_id) DO UPDATE SET name = EXCLUDED.name, username = EXCLUDED.username, blocked = false, last_active = now()
       RETURNING *, (xmax = 0) AS inserted`,
    [String(chatId), name, String(from.username || '').slice(0, 64), langOf(from.language_code)]);
  return rows[0];
}

const myLinks = (chat) => q('SELECT * FROM links WHERE chat_id = $1 ORDER BY id', [chat]);

/* show a view: edit the message the button was on (if it fits), else send it new */
async function show(chatId, lines, kb, edit) {
  const extra = kb ? { reply_markup: { inline_keyboard: kb } } : {};
  const text = lines.join('\n');
  if (edit && text.length < 3900) {
    const r = await tg('editMessageText', { chat_id: Number(chatId), message_id: edit, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
    if (r.ok || /not modified/i.test(r.description || '')) return r;
  }
  return sendLong(chatId, lines, extra);
}

/* ---------- the client side ---------- */

async function help(u) {
  return send(u.chat_id, t(u.lang).welcome(u.name.split(' ')[0], EVERY_MIN) + (isAdmin(u) ? t(u.lang).adminHelp : ''));
}

async function addLinks(u, words) {
  const L = t(u.lang);
  if (!words.length) return send(u.chat_id, L.addHow);
  const out = [];
  if (words.length > MAX_PER_MESSAGE) { out.push(L.tooMany(MAX_PER_MESSAGE)); words = words.slice(0, MAX_PER_MESSAGE); }
  const fresh = [];
  for (const w of words) {
    const n = normalize(w);
    if (n.error) { out.push(n.error === 'scheme' ? L.scheme(w) : L.bad(w.slice(0, 80))); continue; }
    if (await isPrivateHost(n.host)) { out.push(L.priv(n.url)); continue; }
    if (!isAdmin(u)) {
      const [c] = await q('SELECT COUNT(*)::int AS n FROM links WHERE chat_id = $1', [u.chat_id]);
      if (c.n >= cfg.maxLinks()) {
        const dup = await q('SELECT 1 FROM links WHERE chat_id = $1 AND url = $2', [u.chat_id, n.url]);
        out.push(dup.length ? L.exists(n.url) : L.limit(cfg.maxLinks()));
        continue;
      }
    }
    const ins = await q(`INSERT INTO links (chat_id, url) VALUES ($1, $2) ON CONFLICT (chat_id, url) DO NOTHING RETURNING *`, [u.chat_id, n.url]);
    if (ins.length) { fresh.push(ins[0]); out.push(L.added(n.url)); } else out.push(L.exists(n.url));
  }
  await sendLong(u.chat_id, out);
  if (!fresh.length) return;
  // first check right away, so the client sees 🟢/🔴 immediately
  await tg('sendChatAction', { chat_id: Number(u.chat_id), action: 'typing' });
  const { changes, results } = await checkLinks(fresh);
  await announce(changes, { ownerToo: false });                      // admins hear about a new link that is already down
  const lines = fresh.map((l) => { const r = results.get(l.url); return r && r.up ? L.nowUp({ url: l.url, ms: r.ms }) : L.nowDown(l, r ? reasonTextFor(r, u.lang) : '?'); });
  lines.push('', L.watching);
  await sendLong(u.chat_id, lines);
}

const reasonTextFor = (r, lang) => reasonText(r.reason, r.code, lang);

async function list(u, { edit } = {}) {
  const L = t(u.lang);
  const links = await myLinks(u.chat_id);
  if (!links.length) return show(u.chat_id, [L.none], null, edit);
  const down = links.filter((l) => l.status === 'down').length;
  const lines = [L.listTitle(links.length), LINE];
  links.forEach((l, i) => { if (i) lines.push(''); lines.push(linkCard(l, u.lang)); });
  const last = links.map((l) => l.last_check).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0];
  lines.push(LINE, `${down ? L.someDown(down, links.length) : L.allOk}  ·  ${L.checkedAgo(ago(last, u.lang))}`);
  return show(u.chat_id, lines, [[{ text: L.btnCheck, callback_data: 'check' }, { text: L.btnRemove, callback_data: 'rmlist' }]], edit);
}

async function checkNow(u, msgId) {
  const L = t(u.lang);
  const links = await myLinks(u.chat_id);
  if (!links.length) return send(u.chat_id, L.none);
  let edit = msgId;
  if (!edit) { const m = await send(u.chat_id, L.checking(links.length)); edit = m.ok ? m.result.message_id : null; }
  const { changes } = await checkLinks(links);
  await announce(changes, { ownerToo: false });
  return list(u, { edit });
}

async function removePicker(u) {
  const L = t(u.lang);
  const links = await myLinks(u.chat_id);
  if (!links.length) return send(u.chat_id, L.none);
  const rows = links.slice(0, 90).map((l) => [{ text: `❌ ${short(l.url)}`, callback_data: `rm:${l.id}` }]);
  return send(u.chat_id, L.pickRemove, { reply_markup: { inline_keyboard: rows } });
}

async function remove(u, arg) {
  const L = t(u.lang);
  if (!arg) return removePicker(u);
  const links = await myLinks(u.chat_id);
  let target = null;
  if (/^\d+$/.test(arg)) target = links[parseInt(arg, 10) - 1];
  if (!target) { const n = normalize(arg); target = links.find((l) => l.url === n.url || l.url === arg); }
  if (!target) return send(u.chat_id, L.notFound);
  await q('DELETE FROM links WHERE id = $1 AND chat_id = $2', [target.id, u.chat_id]);
  return send(u.chat_id, L.removed(target.url));
}

async function langPicker(u) {
  return send(u.chat_id, t(u.lang).langPick, { reply_markup: { inline_keyboard: [[{ text: 'English', callback_data: 'lang:en' }, { text: '中文', callback_data: 'lang:zh' }]] } });
}

/* ---------- the admin side ---------- */

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

async function claimAdmin(u, code, msgId) {
  const L = t(u.lang);
  if (msgId) await tg('deleteMessage', { chat_id: Number(u.chat_id), message_id: msgId });   // the code doesn't stay in the chat
  if (isAdmin(u)) return send(u.chat_id, L.adminOk);
  if (!cfg.adminCode() || u.admin_tries >= 5) return send(u.chat_id, cfg.adminCode() ? L.adminLocked : L.unknown);
  if (!code || !safeEqual(code, cfg.adminCode())) {
    await q('UPDATE users SET admin_tries = admin_tries + 1 WHERE chat_id = $1', [u.chat_id]);
    return send(u.chat_id, L.adminBad);
  }
  await q('UPDATE users SET is_admin = true, admin_tries = 0 WHERE chat_id = $1', [u.chat_id]);
  await adminMenu(u);
  return send(u.chat_id, L.adminOk);
}

const adminKb = (L) => [[{ text: L.btnRefresh, callback_data: 'a:all' }, { text: L.btnDown, callback_data: 'a:down' }, { text: L.btnClients, callback_data: 'a:clients' }]];

async function everything() {
  const users = await q('SELECT * FROM users ORDER BY created_at');
  const links = await q('SELECT * FROM links ORDER BY id');
  const by = new Map(users.map((x) => [x.chat_id, []]));
  for (const l of links) if (by.has(l.chat_id)) by.get(l.chat_id).push(l);
  return { users, links, by };
}
const clientIcon = (mine) => (!mine.length ? '⚪' : mine.some((l) => l.status === 'down') ? '🔴' : '🟢');
const clientHead = (x, mine) => `${clientIcon(mine)} <b>${esc(x.name || 'No name')}</b>${x.username ? `  @${esc(x.username)}` : ''}${x.is_admin ? '  👑' : ''}`;

/* the dashboard: totals on top, then each client with their links (problems first) */
async function allClients(u, { edit } = {}) {
  const L = t(u.lang);
  const { users, links, by } = await everything();
  if (!users.length) return show(u.chat_id, [L.noClients], null, edit);
  const up = links.filter((l) => l.status === 'up').length, down = links.filter((l) => l.status === 'down').length;
  const lines = [L.dash, LINE, L.dashCounts(users.length, links.length), L.dashStatus(up, down), L.lastRun(ago(await getMeta('last_run'), u.lang)), LINE];
  const downN = (x) => by.get(x.chat_id).filter((l) => l.status === 'down').length;
  const withLinks = users.filter((x) => by.get(x.chat_id).length).sort((a, b) => downN(b) - downN(a));
  for (const x of withLinks) {
    const mine = [...by.get(x.chat_id)].sort((a, b) => (a.status === 'down' ? 0 : 1) - (b.status === 'down' ? 0 : 1));
    lines.push('', [clientHead(x, mine), ...mine.map((l) => linkCard(l, u.lang, '    '))].join('\n'));
  }
  const empty = users.filter((x) => !by.get(x.chat_id).length);
  if (empty.length) lines.push('', L.noLinksYet(empty.map((x) => esc(x.name || x.chat_id)).join(', ')));
  return show(u.chat_id, lines, adminKb(L), edit);
}

/* one client, from /client ID or a button */
async function oneClient(u, chatId, { edit } = {}) {
  const L = t(u.lang);
  const [x] = await q('SELECT * FROM users WHERE chat_id = $1', [String(chatId)]);
  if (!x) return show(u.chat_id, [L.noClient], null, edit);
  const mine = await myLinks(x.chat_id);
  const down = mine.filter((l) => l.status === 'down').length;
  const lines = [L.clientTitle(x), L.clientMeta(x), LINE];
  if (!mine.length) lines.push(`<i>${L.clientSub(0, 0)}</i>`);
  mine.forEach((l, i) => { if (i) lines.push(''); lines.push(linkCard(l, u.lang)); });
  if (mine.length) lines.push(LINE, down ? L.someDown(down, mine.length) : L.allOk);
  return show(u.chat_id, lines, [[{ text: L.btnRefresh, callback_data: 'a:c:' + x.chat_id }, { text: L.btnClients, callback_data: 'a:clients' }, { text: L.btnDash, callback_data: 'a:all' }]], edit);
}

async function downList(u, { edit } = {}) {
  const L = t(u.lang);
  const { users, links, by } = await everything();
  const down = links.filter((l) => l.status === 'down');
  if (!down.length) {
    const up = links.filter((l) => l.status === 'up').length;
    return show(u.chat_id, [L.allUpTitle, LINE, L.dashStatus(up, 0)], adminKb(L), edit);
  }
  const lines = [L.downTitle(down.length), LINE];
  for (const x of users) {
    const mine = by.get(x.chat_id).filter((l) => l.status === 'down');
    if (!mine.length) continue;
    lines.push('', [clientHead(x, mine), ...mine.map((l) => linkCard(l, u.lang, '    '))].join('\n'));
  }
  return show(u.chat_id, lines, adminKb(L), edit);
}

/* the client list: one card each + a button per client */
async function clientList(u, { edit } = {}) {
  const L = t(u.lang);
  const { users, by } = await everything();
  if (!users.length) return show(u.chat_id, [L.noClients], null, edit);
  const lines = [L.clientsTitle(users.length), LINE];
  users.forEach((x, i) => {
    const mine = by.get(x.chat_id);
    const d = mine.filter((l) => l.status === 'down').length;
    if (i) lines.push('');
    lines.push(`${clientHead(x, mine)}${x.blocked ? '  ⛔' : ''}\n      <i>${L.clientSub(mine.length, d)} · ${L.joined(day(x.created_at))}</i>`);
  });
  lines.push(LINE, L.tapClient);
  const buttons = users.slice(0, 60).map((x) => ({ text: `${clientIcon(by.get(x.chat_id))} ${(x.name || x.chat_id).slice(0, 24)}`, callback_data: 'a:c:' + x.chat_id }));
  const kb = [];
  for (let i = 0; i < buttons.length; i += 2) kb.push(buttons.slice(i, i + 2));
  kb.push([{ text: L.btnDash, callback_data: 'a:all' }, { text: L.btnDown, callback_data: 'a:down' }]);
  return show(u.chat_id, lines, kb, edit);
}

async function status(u, { edit } = {}) {
  const L = t(u.lang);
  const last = await getMeta('last_run');
  let st = {}; try { st = JSON.parse((await getMeta('last_stats')) || '{}'); } catch (e) { st = {}; }
  const s = await totals();
  const ok = !!last && Date.now() - new Date(last).getTime() < cfg.staleMin() * 60000;
  return show(u.chat_id, [L.statusCard({ ok, last: ago(last, u.lang), took: st.took, checked: st.checked, ...s, contact: await getMeta('contact') })],
    [[{ text: L.btnRefresh, callback_data: 'a:status' }, { text: L.btnDash, callback_data: 'a:all' }]], edit);
}

async function setContact(u, arg) {
  const L = t(u.lang);
  if (!arg) return send(u.chat_id, L.contactHow);
  const c = /^(off|none|-|关闭)$/i.test(arg) ? '' : arg.slice(0, 80);
  await setMeta('contact', c);
  return send(u.chat_id, L.contactSet(c));
}

/* ---------- entry ---------- */

const URLISH = /^(https?:\/\/\S+|[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?)$/i;

export async function handleUpdate(up) {
  if (!up || typeof up !== 'object') return;
  if (up.update_id != null) {
    const fresh = await q('INSERT INTO seen_updates (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING id', [up.update_id]);
    if (!fresh.length) return;                                       // already handled
  }
  if (up.callback_query) return onButton(up.callback_query);
  const m = up.message;
  if (!m || !m.chat || m.chat.type !== 'private' || !m.from || m.from.is_bot) return;
  const u = await upsertUser(m.from, m.chat.id);
  if (u.inserted) for (const a of await admins()) if (a.chat_id !== u.chat_id) await notify(a.chat_id, t(a.lang).newClient(u));
  const text = String(m.text || m.caption || '').trim();
  const L = t(u.lang);
  if (!text) return send(u.chat_id, L.unknown);

  const [first, ...rest] = text.split(/\s+/);
  const cmd = first.startsWith('/') ? first.slice(1).split('@')[0].toLowerCase() : '';
  const arg = rest.join(' ').trim();
  const words = (s) => s.split(/[\s,，;；]+/).map((x) => x.trim()).filter(Boolean);
  const admin = isAdmin(u);

  if (!cmd) {
    const ws = words(text);
    if (ws.some((w) => URLISH.test(w.replace(/^[<(\["']+|[>)\]"',.;]+$/g, '')))) return addLinks(u, ws.filter((w) => URLISH.test(w.replace(/^[<(\["']+|[>)\]"',.;]+$/g, ''))));
    return send(u.chat_id, L.unknown);
  }
  switch (cmd) {
    case 'start': case 'help': return help(u);
    case 'add': return addLinks(u, words(arg));
    case 'list': case 'links': return list(u);
    case 'check': return checkNow(u);
    case 'remove': case 'delete': case 'del': return remove(u, arg);
    case 'lang': case 'language': return langPicker(u);
    case 'myid': case 'id': return send(u.chat_id, L.yourId(u.chat_id));
    case 'admin': return claimAdmin(u, arg, m.message_id);
  }
  if (admin) {
    switch (cmd) {
      case 'all': return allClients(u);
      case 'down': return downList(u);
      case 'clients': return clientList(u);
      case 'client': return /^-?\d+$/.test(arg) ? oneClient(u, arg) : clientList(u);
      case 'status': return status(u);
      case 'contact': return setContact(u, arg);
    }
  }
  return send(u.chat_id, L.unknown);
}

async function onButton(cb) {
  const answer = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text } : {}) });
  const chat = cb.message && cb.message.chat;
  if (!chat || chat.type !== 'private' || !cb.from) return answer();
  const [u] = await q('SELECT * FROM users WHERE chat_id = $1', [String(chat.id)]);
  if (!u) { await answer(); return; }
  const L = t(u.lang);
  const data = String(cb.data || '');
  if (data === 'check') { await answer(); return checkNow(u, cb.message.message_id); }
  if (data === 'rmlist') { await answer(); return removePicker(u); }
  if (data.startsWith('rm:')) {
    const id = parseInt(data.slice(3), 10);
    const del = Number.isFinite(id) ? await q('DELETE FROM links WHERE id = $1 AND chat_id = $2 RETURNING url', [id, u.chat_id]) : [];
    await answer();
    if (!del.length) return send(u.chat_id, L.notFound);
    await tg('editMessageReplyMarkup', { chat_id: Number(u.chat_id), message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
    return send(u.chat_id, L.removed(del[0].url));
  }
  if (data.startsWith('a:')) {
    await answer();
    if (!isAdmin(u)) return;
    const mid = cb.message.message_id;
    if (data === 'a:all') return allClients(u, { edit: mid });
    if (data === 'a:down') return downList(u, { edit: mid });
    if (data === 'a:clients') return clientList(u, { edit: mid });
    if (data === 'a:status') return status(u, { edit: mid });
    if (data.startsWith('a:c:') && /^-?\d+$/.test(data.slice(4))) return oneClient(u, data.slice(4), { edit: mid });
    return;
  }
  if (data.startsWith('lang:')) {
    const lang = data.slice(5);
    if (!LANGS.includes(lang)) return answer();
    await q('UPDATE users SET lang = $2 WHERE chat_id = $1', [u.chat_id, lang]);
    u.lang = lang;
    await answer();
    if (isAdmin(u)) await adminMenu(u);
    await send(u.chat_id, t(lang).langSet);
    return help(u);
  }
  return answer();
}
