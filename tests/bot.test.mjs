/* The whole bot through its real HTTP entry: fake Telegram server + real test websites + real Postgres (PGlite, in memory). */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PGlite } from '@electric-sql/pglite';

/* ---------- fake Telegram ---------- */
const calls = [];
let nextMsg = 1000;
const GONE = new Set(['999']);                                         // this person blocked the bot
const tgServer = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const method = req.url.split('/').pop();
  const data = body ? JSON.parse(body) : {};
  calls.push({ method, data });
  res.setHeader('content-type', 'application/json');
  if (data.chat_id != null && GONE.has(String(data.chat_id))) return res.end(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }));
  if (method === 'getMe') return res.end(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, username: 'TestWatchBot' } }));
  if (method === 'sendMessage') return res.end(JSON.stringify({ ok: true, result: { message_id: nextMsg++ } }));
  res.end(JSON.stringify({ ok: true, result: true }));
});
await new Promise((r) => tgServer.listen(0, '127.0.0.1', r));

/* ---------- test websites ---------- */
let flip = 'up';                // /flip answers 200 or 503
let blipLeft = 0;               // /blip fails this many times, then works
const site = http.createServer((req, res) => {
  const p = req.url;
  if (p === '/ok') { res.statusCode = 200; return res.end('hello'); }
  if (p === '/err') { res.statusCode = 500; return res.end('boom'); }
  if (p === '/nf') { res.statusCode = 404; return res.end('nf'); }
  if (p === '/auth') { res.statusCode = 401; return res.end('login'); }
  if (p === '/redir') { res.statusCode = 302; res.setHeader('location', '/ok'); return res.end(); }
  if (p === '/slow') { setTimeout(() => { try { res.end('late'); } catch (e) { /* closed */ } }, 3000); return; }
  if (p === '/flip') { res.statusCode = flip === 'up' ? 200 : 503; return res.end(flip); }
  if (p === '/blip') { if (blipLeft > 0) { blipLeft--; res.statusCode = 502; return res.end('x'); } res.statusCode = 200; return res.end('ok'); }
  res.statusCode = 404; res.end();
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const S = `http://127.0.0.1:${site.address().port}`;

process.env.BOT_TOKEN = 'TEST:TOKEN';
process.env.TG_API = `http://127.0.0.1:${tgServer.address().port}`;
process.env.CRON_SECRET = 'test-cron-secret-1234567890';
process.env.ADMIN_CODE = 'admin-code-xyz';
process.env.ALLOW_PRIVATE = '1';
process.env.CHECK_TIMEOUT_MS = '800';
process.env.RETRY_DELAY_MS = '50';
process.env.MAX_LINKS = '6';
delete process.env.ADMIN_IDS;
delete process.env.DATABASE_URL;
const pg = new PGlite();
globalThis.__LW_TEST_DB = { query: async (t, p = []) => (await pg.query(t, p)).rows };

const { default: handler, webhookSecret } = await import('../api/index.js');
const app = http.createServer((req, res) => handler(req, res));
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${app.address().port}`;
test.after(() => { app.close(); site.close(); tgServer.close(); });

/* ---------- helpers ---------- */
let uid = 1;
const ADMIN = { id: 111, first_name: 'Boss', username: 'boss', language_code: 'en' };
const JOHN = { id: 222, first_name: 'John', last_name: 'Doe', username: 'john', language_code: 'en' };
const LI = { id: 333, first_name: '李', username: 'li', language_code: 'zh-hans' };
const GHOST = { id: 999, first_name: 'Ghost', language_code: 'en' };

async function post(update, secret = webhookSecret()) {
  const r = await fetch(BASE + '/api/telegram', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(update) });
  return r.status;
}
const say = (from, text, extra = {}) => post({ update_id: uid++, message: { message_id: uid + 5000, from, chat: { id: from.id, type: 'private' }, text, ...extra } });
const press = (from, data, message_id = 1) => post({ update_id: uid++, callback_query: { id: 'cb' + uid, from, data, message: { message_id, chat: { id: from.id, type: 'private' } } } });
const cron = (key = process.env.CRON_SECRET, path = '/api/cron') => fetch(`${BASE}${path}?key=${encodeURIComponent(key)}`).then(async (r) => ({ status: r.status, data: await r.json() }));
const mark = () => calls.length;
const sent = (from, who) => calls.slice(from).filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && String(c.data.chat_id) === String(who.id)).map((c) => c.data.text);
const joined = (from, who) => sent(from, who).join('\n---\n');
const links = (who) => pg.query('SELECT * FROM links WHERE chat_id = $1 ORDER BY id', [String(who.id)]).then((r) => r.rows);

/* ---------- tests ---------- */

test('webhook: only Telegram (with our secret) gets in', async () => {
  assert.equal(await post({ update_id: 1 }, 'wrong'), 401);
  assert.equal(await post({ update_id: 1 }, ''), 401);
  const r = await fetch(BASE + '/api/telegram');
  assert.equal(r.status, 405);
  assert.equal((await fetch(BASE + '/api/health')).status, 200);
});

test('timer and setup need the key', async () => {
  assert.equal((await cron('nope')).status, 401);
  assert.equal((await cron('')).status, 401);
  assert.equal((await fetch(BASE + '/api/setup?key=nope')).status, 401);
  const r = await fetch(BASE + '/api/cron', { headers: { authorization: 'Bearer ' + process.env.CRON_SECRET } });
  assert.equal(r.status, 200, 'Vercel Cron style header works too');
});

test('setup connects the webhook with the secret + sets the menu', async () => {
  const m = mark();
  const r = await fetch(BASE + '/api/setup?key=' + process.env.CRON_SECRET, { headers: { 'x-forwarded-host': 'watch.example.com' } });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.equal(d.bot, '@TestWatchBot');
  const hook = calls.slice(m).find((c) => c.method === 'setWebhook');
  assert.equal(hook.data.url, 'https://watch.example.com/api/telegram');
  assert.equal(hook.data.secret_token, webhookSecret());
  assert.ok(calls.slice(m).filter((c) => c.method === 'setMyCommands').length >= 2, 'english + chinese menu');
});

test('admin: wrong code counted, right code works, the code message is deleted', async () => {
  await say(ADMIN, '/start');
  let m = mark();
  await say(ADMIN, '/admin wrong');
  assert.match(joined(m, ADMIN), /Wrong code/);
  assert.ok(calls.slice(m).some((c) => c.method === 'deleteMessage'), 'code message removed from the chat');
  m = mark();
  await say(ADMIN, '/admin ' + process.env.ADMIN_CODE);
  assert.match(joined(m, ADMIN), /You are now an admin/);
  assert.ok(calls.slice(m).some((c) => c.method === 'setMyCommands' && c.data.scope && c.data.scope.chat_id === ADMIN.id), 'admin gets the admin menu');
  m = mark();
  await say(ADMIN, '/help');
  assert.match(joined(m, ADMIN), /\/all/);
});

test('admin code: locked after 5 wrong tries', async () => {
  const X = { id: 444, first_name: 'X', language_code: 'en' };
  for (let i = 0; i < 5; i++) await say(X, '/admin guess' + i);
  const m = mark();
  await say(X, '/admin ' + process.env.ADMIN_CODE);
  assert.match(joined(m, X), /Too many wrong codes/);
  await say(X, '/all');
  assert.doesNotMatch(joined(m, X), /All clients/, 'not admin');
  await pg.query(`DELETE FROM users WHERE chat_id = '444'`);
});

test('a new client: welcome (English / Chinese) and the admin is told', async () => {
  let m = mark();
  await say(JOHN, '/start');
  assert.match(joined(m, JOHN), /Hi John!/);
  assert.doesNotMatch(joined(m, JOHN), /Admin/, 'clients do not see admin commands');
  assert.match(joined(m, ADMIN), /New client: John Doe \(@john\)/);
  m = mark();
  await say(LI, '/start');
  assert.match(joined(m, LI), /您好/);
  m = mark();
  await say(JOHN, '/start');
  assert.doesNotMatch(joined(m, ADMIN), /New client/, 'only once');
});

test('adding links: plain message, several at once, first result right away', async () => {
  const m = mark();
  await say(JOHN, `${S}/ok\n${S}/err`);
  const out = joined(m, JOHN);
  assert.match(out, /Added: .*\/ok/);
  assert.match(out, /Added: .*\/err/);
  assert.match(out, /🟢 .*\/ok is <b>UP<\/b>/);
  assert.match(out, /🔴 .*\/err is <b>DOWN<\/b> — server error \(500\)/);
  const ls = await links(JOHN);
  assert.deepEqual(ls.map((l) => l.status), ['up', 'down']);
  assert.match(joined(m, ADMIN), /Status changes[\s\S]*John Doe[\s\S]*🔴 .*\/err — server error \(500\)/, 'admin hears about a link that is down from the start');
  assert.doesNotMatch(joined(m, ADMIN), /\/ok/, 'a new link that works is not news');
});

test('adding: duplicates, bad links, other schemes, /add with nothing', async () => {
  const m = mark();
  await say(JOHN, `/add ${S}/ok`);
  await say(JOHN, '/add mailto:a@b.com');
  await say(JOHN, '/add notalink');
  await say(JOHN, '/add');
  await say(JOHN, 'hello there');
  const out = joined(m, JOHN);
  assert.match(out, /Already watching/);
  assert.match(out, /Only http:\/\/ and https:\/\//);
  assert.match(out, /Not a valid link: notalink/);
  assert.match(out, /Send me the link to watch/);
  assert.match(out, /Send me a link to watch/);
  assert.equal((await links(JOHN)).length, 2);
});

test('links are cleaned: no scheme -> https, trailing slash, #part', () => import('../lib/check.js').then(({ normalize }) => {
  assert.equal(normalize('example.com').url, 'https://example.com');
  assert.equal(normalize('http://Example.com/').url, 'http://example.com');
  assert.equal(normalize('https://example.com/a/b?x=1#top').url, 'https://example.com/a/b?x=1');
  assert.equal(normalize('example.com:8443/panel').url, 'https://example.com:8443/panel');
  assert.equal(normalize('<https://example.com>').url, 'https://example.com');
  assert.equal(normalize('ftp://example.com').error, 'scheme');
  assert.equal(normalize('javascript:alert(1)').error, 'scheme');
  assert.equal(normalize('http://user:pw@example.com').error, 'bad');
  assert.equal(normalize('hello').error, 'bad');
  assert.equal(normalize('').error, 'empty');
  assert.equal(normalize('https://例子.中国').url, 'https://xn--fsqu00a.xn--fiqs8s');
}));

test('private addresses are refused (when not testing)', async () => {
  const { isPrivateHost } = await import('../lib/check.js');
  delete process.env.ALLOW_PRIVATE;
  try {
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '[::1]', 'fd00::1', 'printer.local'])
      assert.equal(await isPrivateHost(h), true, h);
    for (const h of ['8.8.8.8', '1.1.1.1']) assert.equal(await isPrivateHost(h), false, h);
    const m = mark();
    await say(JOHN, '/add http://169.254.169.254/latest');
    assert.match(joined(m, JOHN), /Private \/ local addresses/);
  } finally { process.env.ALLOW_PRIVATE = '1'; }
});

test('the limit per client', async () => {
  const m = mark();
  await say(JOHN, `${S}/nf ${S}/auth ${S}/redir ${S}/slow ${S}/ok?a=1`);
  const out = joined(m, JOHN);
  assert.match(out, /Limit reached \(6 links\)/);
  assert.equal((await links(JOHN)).length, 6);
  assert.match(out, /🔴 .*\/nf is <b>DOWN<\/b> — page not found \(404\)/);
  assert.match(out, /🟢 .*\/auth is <b>UP<\/b>/, '401 = the server is running');
  assert.match(out, /🟢 .*\/redir is <b>UP<\/b>/, 'redirect followed');
  assert.match(out, /🔴 .*\/slow is <b>DOWN<\/b> — no answer \(timeout\)/);
});

test('/list: a card per link, a summary line and buttons', async () => {
  const m = mark();
  await say(JOHN, '/list');
  const c = calls.slice(m).find((x) => x.method === 'sendMessage' && x.data.chat_id === '222');
  const host = S.replace('http://', '');
  assert.match(c.data.text, /📋 <b>Your links<\/b> · 6\n━+/);
  assert.ok(c.data.text.includes(`🟢 <b><a href="${S}/ok">${host}/ok</a></b>\n      <i>Online · `), c.data.text);
  assert.ok(c.data.text.includes(`🔴 <b><a href="${S}/err">${host}/err</a></b>\n      <i>server error (500) · down 1 min</i>`));
  assert.match(c.data.text, /⚠️ \d of 6 down  ·  ⏱ Checked just now/);
  assert.deepEqual(c.data.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['check', 'rmlist']);
});

test('remove: by number, by button; nobody can remove someone else\'s link', async () => {
  let ls = await links(JOHN);
  const slow = ls.find((l) => l.url.endsWith('/slow'));
  let m = mark();
  await press(LI, 'rm:' + slow.id);
  assert.equal((await links(JOHN)).length, 6, 'Li cannot remove John\'s link');
  m = mark();
  await press(JOHN, 'rm:' + slow.id);
  assert.match(joined(m, JOHN), /Stopped watching: .*\/slow/);
  ls = await links(JOHN);
  assert.equal(ls.length, 5);
  const nfIndex = ls.findIndex((l) => l.url.endsWith('/nf')) + 1;
  m = mark();
  await say(JOHN, '/remove ' + nfIndex);
  assert.match(joined(m, JOHN), /Stopped watching: .*\/nf/);
  m = mark();
  await say(JOHN, '/remove');
  const pick = calls.slice(m).find((c) => c.method === 'sendMessage');
  assert.equal(pick.data.reply_markup.inline_keyboard.length, 4);
  m = mark();
  await say(JOHN, '/remove https://never-added.example');
  assert.match(joined(m, JOHN), /not in your list/);
});

test('the timer: an alert only when the status CHANGES, back-up with how long it was down', async () => {
  flip = 'up';
  await say(LI, `${S}/flip`);
  await cron();
  let m = mark();
  await cron();
  assert.equal(sent(m, LI).length, 0, 'still up: nothing to say');

  await pg.query(`INSERT INTO meta (key, value) VALUES ('contact', '@support') ON CONFLICT (key) DO UPDATE SET value = '@support'`);
  flip = 'down';
  m = mark();
  const r = await cron();
  assert.ok(r.data.ok && r.data.checked >= 1);
  const out = joined(m, LI);
  assert.match(out, /🔴 <b>无法访问<\/b>\n.*\/flip\n↳ 服务不可用 \(503\)/, 'Chinese client, Chinese alert');
  assert.match(out, /需要帮助？请联系 @support/);
  assert.equal(sent(m, LI).length, 1, 'one message');
  assert.match(joined(m, ADMIN), /Status changes[\s\S]*李 \(@li\)[\s\S]*🔴 .*\/flip — service unavailable \(503\)/, 'admin copy in the admin\'s language');

  m = mark();
  await cron();
  assert.equal(sent(m, LI).length, 0, 'still down: no repeat');

  await pg.query(`UPDATE links SET since = now() - interval '14 minutes' WHERE url LIKE '%/flip'`);
  flip = 'up';
  m = mark();
  await cron();
  assert.match(joined(m, LI), /🟢 <b>已恢复正常<\/b>\n.*\/flip\n↳ 宕机时长 14 分钟/);
  assert.doesNotMatch(joined(m, LI), /请联系/, 'no contact line on good news');
  assert.match(joined(m, ADMIN), /🟢 .*\/flip — was down for 14 min/);
});

test('a short blip (fails once, works seconds later) never alerts', async () => {
  await say(LI, `${S}/blip`);
  blipLeft = 1;
  const m = mark();
  await cron();
  assert.equal(sent(m, LI).length, 0);
  const [l] = (await links(LI)).filter((x) => x.url.endsWith('/blip'));
  assert.equal(l.status, 'up');
});

test('the same link watched by two clients: both alerted, opened once', async () => {
  flip = 'up';
  await say(JOHN, '/remove 1');                                       // room under the limit
  await say(JOHN, `${S}/flip`);
  flip = 'down';
  const m = mark();
  await cron();
  assert.match(joined(m, JOHN), /DOWN/);
  assert.match(joined(m, LI), /无法访问/);
  const admin = joined(m, ADMIN);
  assert.match(admin, /John Doe[\s\S]*李|李[\s\S]*John Doe/, 'admin sees both clients in one message');
  assert.equal(sent(m, ADMIN).length, 1);
  flip = 'up';
  await cron();
});

test('two timer runs at the same moment: only one works (no double alerts)', async () => {
  const [a, b] = await Promise.all([cron(), cron()]);
  const skipped = [a.data, b.data].filter((d) => d.skipped).length;
  assert.equal(skipped, 1, JSON.stringify([a.data, b.data]));
});

test('/check rechecks now and edits the list in place; buttons too', async () => {
  let m = mark();
  await say(JOHN, '/check');
  assert.match(joined(m, JOHN), /Checking \d+ links/);
  assert.ok(calls.slice(m).some((c) => c.method === 'editMessageText' && /Your links/.test(c.data.text)));
  m = mark();
  await press(JOHN, 'check', 77);
  const ed = calls.slice(m).find((c) => c.method === 'editMessageText');
  assert.equal(ed.data.message_id, 77);
  assert.ok(calls.slice(m).some((c) => c.method === 'answerCallbackQuery'), 'the button stops spinning');
});

test('language switch', async () => {
  let m = mark();
  await say(JOHN, '/lang');
  const pick = calls.slice(m).find((c) => c.method === 'sendMessage');
  assert.deepEqual(pick.data.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['lang:en', 'lang:zh']);
  m = mark();
  await press(JOHN, 'lang:zh');
  assert.match(joined(m, JOHN), /语言：中文/);
  m = mark();
  await say(JOHN, '/list');
  assert.match(joined(m, JOHN), /您的链接/);
  await press(JOHN, 'lang:en');
  await press(JOHN, 'lang:xx');
  const [u] = (await pg.query(`SELECT lang FROM users WHERE chat_id = '222'`)).rows;
  assert.equal(u.lang, 'en');
});

test('admin views: dashboard, down, clients, one client, status, contact — with buttons', async () => {
  let m = mark();
  await say(ADMIN, '/all');
  let c = calls.slice(m).find((x) => x.method === 'sendMessage' && x.data.chat_id === '111');
  let out = c.data.text;
  assert.match(out, /📊 <b>Dashboard<\/b>\n━+\n👥 3 clients  ·  🔗 \d+ links\n🟢 \d+ online  ·  🔴 1 down\n⏱ Last check: /);
  assert.match(out, /🔴 <b>John Doe<\/b>  @john\n    🔴 <b><a href=".*\/err">/, 'a client with a problem: red, the bad link first');
  assert.match(out, /🟢 <b>李<\/b>  @li/);
  assert.match(out, /⚪ <i>No links yet:<\/i> Boss/);
  assert.ok(out.indexOf('John Doe') < out.indexOf('李'), 'problems first');
  assert.deepEqual(c.data.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['a:all', 'a:down', 'a:clients']);

  m = mark(); await press(ADMIN, 'a:down', 55);
  let ed = calls.slice(m).find((x) => x.method === 'editMessageText');
  assert.equal(ed.data.message_id, 55, 'buttons change the same message');
  assert.match(ed.data.text, /🔴 <b>Down right now<\/b> · 1[\s\S]*John Doe[\s\S]*\/err/);
  assert.doesNotMatch(ed.data.text, /\/ok"/);

  m = mark(); await press(ADMIN, 'a:clients', 55);
  ed = calls.slice(m).find((x) => x.method === 'editMessageText');
  assert.match(ed.data.text, /👥 <b>Clients<\/b> · 3/);
  assert.match(ed.data.text, /🔴 <b>John Doe<\/b>  @john\n      <i>🔴 1 of \d+ down · joined \d{4}-\d\d-\d\d<\/i>/);
  assert.match(ed.data.text, /⚪ <b>Boss<\/b>  @boss  👑\n      <i>no links yet/);
  const btns = ed.data.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(btns.includes('a:c:222') && btns.includes('a:c:333'), 'a button per client');

  m = mark(); await press(ADMIN, 'a:c:333', 55);
  ed = calls.slice(m).find((x) => x.method === 'editMessageText');
  assert.match(ed.data.text, /👤 <b>李<\/b>  @li\n🆔 <code>333<\/code> · joined .* · 中文/);
  assert.doesNotMatch(ed.data.text, /John/);

  m = mark(); await say(ADMIN, '/client 12345');
  assert.match(joined(m, ADMIN), /No client with that ID/);
  m = mark(); await say(ADMIN, '/client');
  assert.match(joined(m, ADMIN), /Clients<\/b> · 3/, 'no ID: the client list');

  m = mark(); await say(ADMIN, '/status');
  assert.match(joined(m, ADMIN), /System status[\s\S]*Timer: ✅ running \(every 5 min\)[\s\S]*👥 3 clients/);

  m = mark(); await say(ADMIN, '/contact @mootech');
  assert.match(joined(m, ADMIN), /Contact @mootech/);
  m = mark(); await say(ADMIN, '/contact off');
  assert.match(joined(m, ADMIN), /removed/);

  m = mark(); await say(JOHN, '/all');
  assert.doesNotMatch(joined(m, JOHN), /Dashboard/, 'clients cannot use admin commands');
  m = mark(); await press(JOHN, 'a:all', 9);
  assert.equal(calls.slice(m).filter((x) => x.method === 'editMessageText' || x.method === 'sendMessage').length, 0, 'nor admin buttons');
});

test('someone who blocked the bot: marked, not checked any more, unblocked when they write again', async () => {
  await say(GHOST, '/start');
  await pg.query(`INSERT INTO links (chat_id, url, status) VALUES ('999', $1, 'up')`, [`${S}/err`]);
  await cron();
  let [g] = (await pg.query(`SELECT blocked FROM users WHERE chat_id = '999'`)).rows;
  assert.equal(g.blocked, true);
  await pg.query(`UPDATE links SET last_check = NULL WHERE chat_id = '999'`);
  await cron();
  const [l] = (await pg.query(`SELECT last_check FROM links WHERE chat_id = '999'`)).rows;
  assert.equal(l.last_check, null, 'skipped');
  GONE.delete('999');
  await say(GHOST, '/list');
  [g] = (await pg.query(`SELECT blocked FROM users WHERE chat_id = '999'`)).rows;
  assert.equal(g.blocked, false);
});

test('the same Telegram update twice is handled once; groups are ignored', async () => {
  let m = mark();
  const u = { update_id: 777777, message: { message_id: 1, from: JOHN, chat: { id: JOHN.id, type: 'private' }, text: '/help' } };
  await post(u); await post(u);
  assert.equal(sent(m, JOHN).length, 1);
  m = mark();
  await post({ update_id: uid++, message: { message_id: 2, from: JOHN, chat: { id: -100, type: 'group' }, text: '/list' } });
  assert.equal(calls.length, m);
  assert.equal(await post({ update_id: uid++, edited_message: {} }), 200, 'other update kinds are fine');
  assert.equal(await post({ update_id: uid++, message: { chat: { id: 1, type: 'private' } } }), 200, 'odd message, no crash');
});

test('daily: report to admins + warning when the 5-minute timer stopped', async () => {
  let m = mark();
  let r = await cron(undefined, '/api/daily');
  assert.equal(r.status, 200);
  let out = joined(m, ADMIN);
  assert.match(out, /Daily report/);
  assert.doesNotMatch(out, /timer has stopped/);
  await pg.query(`UPDATE meta SET value = $1 WHERE key = 'last_run'`, [new Date(Date.now() - 3 * 3600e3).toISOString()]);
  m = mark();
  r = await cron(undefined, '/api/daily');
  out = joined(m, ADMIN);
  assert.match(out, /timer has stopped[\s\S]*3 h ago/);
  m = mark(); await say(ADMIN, '/status');
  assert.match(joined(m, ADMIN), /Timer: ✅ running/, 'the daily run itself counts as a fresh check');
});
