/* Every message the bot writes, in English and Chinese. */
import { esc } from './tg.js';

export const LANGS = ['en', 'zh'];
export const langOf = (code) => (/^zh/i.test(String(code || '')) ? 'zh' : 'en');

const REASON = {
  en: {
    timeout: 'no answer (timeout)', dns: 'domain not found', refused: 'connection refused (server off?)', reset: 'connection dropped',
    ssl: 'SSL certificate problem', ssl_expired: 'SSL certificate expired', redirects: 'too many redirects', unreachable: 'server unreachable',
    blocked: 'private address (not allowed)', error: 'could not connect',
  },
  zh: {
    timeout: '无响应（超时）', dns: '域名无法解析', refused: '连接被拒绝（服务器可能已关闭）', reset: '连接中断',
    ssl: 'SSL 证书有问题', ssl_expired: 'SSL 证书已过期', redirects: '重定向次数过多', unreachable: '服务器无法访问',
    blocked: '内网地址（不允许）', error: '无法连接',
  },
};
const HTTP = {
  en: {
    400: 'bad request', 404: 'page not found', 410: 'page removed', 500: 'server error', 502: 'bad gateway', 503: 'service unavailable',
    504: 'gateway timeout', 520: 'Cloudflare: server error', 521: 'Cloudflare: server is offline', 522: 'Cloudflare: server not responding',
    523: 'Cloudflare: server unreachable', 524: 'Cloudflare: server timeout', 525: 'Cloudflare: SSL handshake failed',
    526: 'Cloudflare: invalid SSL certificate', 530: 'Cloudflare: server unreachable',
  },
  zh: {
    400: '请求错误', 404: '页面不存在', 410: '页面已删除', 500: '服务器错误', 502: '网关错误', 503: '服务不可用',
    504: '网关超时', 520: 'Cloudflare：服务器错误', 521: 'Cloudflare：服务器已离线', 522: 'Cloudflare：服务器无响应',
    523: 'Cloudflare：服务器无法访问', 524: 'Cloudflare：服务器超时', 525: 'Cloudflare：SSL 握手失败',
    526: 'Cloudflare：SSL 证书无效', 530: 'Cloudflare：服务器无法访问',
  },
};

export function reasonText(reason, code, lang) {
  const L = LANGS.includes(lang) ? lang : 'en';
  if (reason === 'http' && code) {
    const n = HTTP[L][code];
    if (n) return `${n} (${code})`;
    return L === 'zh' ? `错误代码 ${code}` : `error ${code}`;
  }
  return REASON[L][reason] || REASON[L].error;
}

/* 75 -> "1 min", 7300 -> "2 h 1 min", 90000 -> "1 d 1 h" */
export function dur(sec, lang) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.max(1, Math.round(s / 60));
  const zh = lang === 'zh';
  if (m < 60) return zh ? `${m} 分钟` : `${m} min`;
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return zh ? `${h} 小时${mm ? ` ${mm} 分钟` : ''}` : `${h} h${mm ? ` ${mm} min` : ''}`;
  const d = Math.floor(h / 24), hh = h % 24;
  return zh ? `${d} 天${hh ? ` ${hh} 小时` : ''}` : `${d} d${hh ? ` ${hh} h` : ''}`;
}

export function ago(date, lang) {
  if (!date) return lang === 'zh' ? '从未' : 'never';
  const s = (Date.now() - new Date(date).getTime()) / 1000;
  if (s < 60) return lang === 'zh' ? '刚刚' : 'just now';
  return lang === 'zh' ? `${dur(s, lang)}前` : `${dur(s, lang)} ago`;
}

export const ICON = { up: '🟢', down: '🔴', new: '⚪' };

/* one line about a link: "🔴 https://x.com — bad gateway (502) · down for 14 min" */
export function linkLine(l, lang, n) {
  const zh = lang === 'zh';
  const head = `${n != null ? n + '. ' : ''}${ICON[l.status] || '⚪'} ${esc(l.url)}`;
  if (l.status === 'down') {
    const since = l.since ? ` · ${zh ? '已宕机' : 'down for'} ${dur((Date.now() - new Date(l.since).getTime()) / 1000, lang)}` : '';
    return `${head} — ${esc(reasonText(l.reason, l.code, lang))}${since}`;
  }
  if (l.status === 'up') return `${head}${l.ms != null ? ` — ${l.ms} ms` : ''}`;
  return `${head} — ${zh ? '检查中…' : 'checking…'}`;
}

export const who = (u) => `${esc(u.name || 'No name')}${u.username ? ` (@${esc(u.username)})` : ''}`;

const T = {
  en: {
    welcome: (name, every) => `👋 <b>Hi ${esc(name || 'there')}!</b>
I watch your websites 24/7 and message you the moment one goes down, so you know before your customers do.

<b>Add a link:</b> just send it to me, for example:
<code>https://yoursite.com</code>
(several at once is fine: one per line)

<b>Commands</b>
/list – your links and their status 🟢/🔴
/check – check all your links now
/remove – stop watching a link
/lang – language / 语言
/help – this message

⏱ I check every ${every} minutes.`,
    adminHelp: `

<b>🔑 Admin</b>
/all – every client and their links
/down – links that are down right now
/clients – the client list
/client ID – one client's links
/status – is the 5-minute timer running?
/contact @you – contact shown in "down" alerts`,
    added: (u) => `✅ Added: ${esc(u)}`,
    exists: (u) => `ℹ️ Already watching: ${esc(u)}`,
    bad: (x) => `❌ Not a valid link: ${esc(x)}`,
    scheme: (x) => `❌ Only http:// and https:// links: ${esc(x)}`,
    priv: (x) => `❌ Private / local addresses can't be watched: ${esc(x)}`,
    limit: (n) => `❌ Limit reached (${n} links). Remove one with /remove first.`,
    tooMany: (n) => `⚠️ Only the first ${n} links of this message were read.`,
    addHow: `Send me the link to watch, for example:\n<code>https://yoursite.com</code>`,
    nowUp: (l) => `🟢 ${esc(l.url)} is <b>UP</b>${l.ms != null ? ` (${l.ms} ms)` : ''}`,
    nowDown: (l, why) => `🔴 ${esc(l.url)} is <b>DOWN</b> — ${esc(why)}`,
    watching: `👀 I'll message you as soon as anything changes. See all: /list`,
    none: `You have no links yet.\nSend me one, for example:\n<code>https://yoursite.com</code>`,
    listHead: (n) => `📋 <b>Your links (${n})</b>`,
    lastRun: (a) => `⏱ Last check: ${a}`,
    btnCheck: '🔄 Check now', btnRemove: '❌ Remove a link',
    pickRemove: 'Which link should I stop watching?',
    removed: (u) => `🗑 Stopped watching: ${esc(u)}`,
    notFound: `That link is not in your list. See /list`,
    checking: (n) => `🔄 Checking ${n} link${n === 1 ? '' : 's'}…`,
    unknown: `Send me a link to watch (like <code>https://yoursite.com</code>), or /help.`,
    langPick: 'Choose your language / 选择语言:', langSet: '✅ Language: English',
    yourId: (id) => `Your Telegram ID: <code>${esc(id)}</code>`,
    alertDown: '🔴 <b>DOWN</b>', alertUp: '🟢 <b>Back UP</b>',
    wasDown: (d) => `was down for ${d}`, contact: (c) => `📞 Need help? Contact ${esc(c)}`,
    // admin
    adminOk: `🔑 You are now an admin. Send /help to see the admin commands.`,
    adminBad: `❌ Wrong code.`, adminLocked: `❌ Too many wrong codes. Ask the owner to add your ID instead.`,
    changes: '🚨 <b>Status changes</b>',
    allHead: (c, up, down) => `👥 <b>All clients (${c})</b> · 🟢 ${up} · 🔴 ${down}`,
    noLinks: '   (no links)', noClients: 'No clients yet.',
    downHead: (n) => `🔴 <b>Down right now (${n})</b>`, allUp: '✅ All links are up.',
    clientsHead: (n) => `👥 <b>Clients (${n})</b>`,
    clientLine: (u, up, down, total) => `• ${who(u)} · id <code>${esc(u.chat_id)}</code>\n   ${total} links · 🟢 ${up} · 🔴 ${down}${u.blocked ? ' · ⛔ blocked the bot' : ''}`,
    noClient: 'No client with that ID. See /clients',
    clientHow: 'Send: /client ID  (IDs are in /clients)',
    newClient: (u) => `🆕 New client: ${who(u)} · id <code>${esc(u.chat_id)}</code>`,
    status: (s) => `⚙️ <b>Status</b>
Timer: ${s.ok ? '✅ running' : '⚠️ NOT running — check cron-job.org'}
Last check: ${s.last}${s.took ? ` (took ${s.took}s, ${s.checked} links)` : ''}
Clients: ${s.clients} · Links: ${s.links} · 🟢 ${s.up} · 🔴 ${s.down}
Contact in alerts: ${s.contact ? esc(s.contact) : '(none — set with /contact @you)'}`,
    contactSet: (c) => (c ? `✅ Alerts now say: "Need help? Contact ${esc(c)}"` : '✅ Contact line removed from alerts.'),
    contactHow: 'Send: /contact @yourname   (or /contact off)',
    stale: (a) => `⚠️ <b>The 5-minute timer has stopped.</b>\nLast check: ${a}.\nOpen cron-job.org and make sure the job is enabled.`,
    daily: (c, l, up, down) => `☀️ <b>Daily report</b>\nClients: ${c} · Links: ${l} · 🟢 ${up} · 🔴 ${down}`,
  },
  zh: {
    welcome: (name, every) => `👋 <b>${esc(name || '')}，您好！</b>
我会 24 小时监控您的网站，一旦无法访问会立即通知您，让您比客户更早发现问题。

<b>添加链接：</b>直接发送给我，例如：
<code>https://yoursite.com</code>
（可一次发送多个，每行一个）

<b>命令</b>
/list – 查看您的链接及状态 🟢/🔴
/check – 立即检查所有链接
/remove – 停止监控某个链接
/lang – 语言 / language
/help – 显示本帮助

⏱ 每 ${every} 分钟检查一次。`,
    adminHelp: `

<b>🔑 管理员</b>
/all – 所有客户及其链接
/down – 当前宕机的链接
/clients – 客户列表
/client ID – 某个客户的链接
/status – 5 分钟定时器是否正常？
/contact @您 – 宕机通知中显示的联系方式`,
    added: (u) => `✅ 已添加：${esc(u)}`,
    exists: (u) => `ℹ️ 已在监控中：${esc(u)}`,
    bad: (x) => `❌ 无效链接：${esc(x)}`,
    scheme: (x) => `❌ 仅支持 http:// 和 https:// 链接：${esc(x)}`,
    priv: (x) => `❌ 无法监控内网 / 本地地址：${esc(x)}`,
    limit: (n) => `❌ 已达上限（${n} 个链接）。请先用 /remove 删除一个。`,
    tooMany: (n) => `⚠️ 本条消息只读取了前 ${n} 个链接。`,
    addHow: `请发送要监控的链接，例如：\n<code>https://yoursite.com</code>`,
    nowUp: (l) => `🟢 ${esc(l.url)} <b>正常</b>${l.ms != null ? `（${l.ms} ms）` : ''}`,
    nowDown: (l, why) => `🔴 ${esc(l.url)} <b>无法访问</b> — ${esc(why)}`,
    watching: `👀 状态一有变化我会立即通知您。查看全部：/list`,
    none: `您还没有添加链接。\n请发送一个，例如：\n<code>https://yoursite.com</code>`,
    listHead: (n) => `📋 <b>您的链接（${n}）</b>`,
    lastRun: (a) => `⏱ 上次检查：${a}`,
    btnCheck: '🔄 立即检查', btnRemove: '❌ 删除链接',
    pickRemove: '要停止监控哪个链接？',
    removed: (u) => `🗑 已停止监控：${esc(u)}`,
    notFound: `您的列表中没有这个链接。查看 /list`,
    checking: (n) => `🔄 正在检查 ${n} 个链接…`,
    unknown: `请发送要监控的链接（例如 <code>https://yoursite.com</code>），或发送 /help。`,
    langPick: '选择语言 / Choose your language:', langSet: '✅ 语言：中文',
    yourId: (id) => `您的 Telegram ID：<code>${esc(id)}</code>`,
    alertDown: '🔴 <b>无法访问</b>', alertUp: '🟢 <b>已恢复正常</b>',
    wasDown: (d) => `宕机时长 ${d}`, contact: (c) => `📞 需要帮助？请联系 ${esc(c)}`,
    adminOk: `🔑 您已成为管理员。发送 /help 查看管理员命令。`,
    adminBad: `❌ 代码错误。`, adminLocked: `❌ 错误次数过多。请让所有者直接添加您的 ID。`,
    changes: '🚨 <b>状态变化</b>',
    allHead: (c, up, down) => `👥 <b>所有客户（${c}）</b> · 🟢 ${up} · 🔴 ${down}`,
    noLinks: '   （没有链接）', noClients: '还没有客户。',
    downHead: (n) => `🔴 <b>当前宕机（${n}）</b>`, allUp: '✅ 所有链接都正常。',
    clientsHead: (n) => `👥 <b>客户（${n}）</b>`,
    clientLine: (u, up, down, total) => `• ${who(u)} · id <code>${esc(u.chat_id)}</code>\n   ${total} 个链接 · 🟢 ${up} · 🔴 ${down}${u.blocked ? ' · ⛔ 已屏蔽机器人' : ''}`,
    noClient: '没有这个 ID 的客户。查看 /clients',
    clientHow: '发送：/client ID（ID 见 /clients）',
    newClient: (u) => `🆕 新客户：${who(u)} · id <code>${esc(u.chat_id)}</code>`,
    status: (s) => `⚙️ <b>状态</b>
定时器：${s.ok ? '✅ 正常运行' : '⚠️ 未运行 — 请检查 cron-job.org'}
上次检查：${s.last}${s.took ? `（用时 ${s.took} 秒，${s.checked} 个链接）` : ''}
客户：${s.clients} · 链接：${s.links} · 🟢 ${s.up} · 🔴 ${s.down}
通知中的联系方式：${s.contact ? esc(s.contact) : '（无 — 用 /contact @您 设置）'}`,
    contactSet: (c) => (c ? `✅ 通知中将显示："需要帮助？请联系 ${esc(c)}"` : '✅ 已从通知中移除联系方式。'),
    contactHow: '发送：/contact @您的用户名（或 /contact off）',
    stale: (a) => `⚠️ <b>5 分钟定时器已停止。</b>\n上次检查：${a}。\n请打开 cron-job.org 确认任务已启用。`,
    daily: (c, l, up, down) => `☀️ <b>每日报告</b>\n客户：${c} · 链接：${l} · 🟢 ${up} · 🔴 ${down}`,
  },
};

export const t = (lang) => T[LANGS.includes(lang) ? lang : 'en'];
