/* Telegram Bot API: a few retries, waits on "too many requests", never throws. */
import { cfg } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function tg(method, body) {
  let last = { ok: false, error_code: 0, description: 'not sent' };
  for (let i = 0; i < 3; i++) {
    let d;
    try {
      const r = await fetch(`${cfg.tgApi()}/bot${cfg.token()}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
      });
      d = await r.json().catch(() => ({ ok: false, error_code: r.status, description: 'bad answer' }));
    } catch (e) {
      last = { ok: false, error_code: 0, description: String((e && e.message) || e) };
      if (i < 2) await sleep(700);
      continue;
    }
    if (d.ok) return d;
    last = d;
    if (d.error_code === 429 && i < 2) { await sleep(Math.min(5, (d.parameters && d.parameters.retry_after) || 1) * 1000); continue; }
    if (d.error_code >= 500 && i < 2) { await sleep(700); continue; }
    return d;                                                         // 400 / 403: retrying won't help
  }
  return last;
}

/* the person blocked the bot or deleted their account */
export const isGone = (r) => !r.ok && (r.error_code === 403 || /chat not found|user is deactivated|bot was blocked/i.test(r.description || ''));

export function send(chatId, html, extra = {}) {
  return tg('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
}

/* long lists: split at line ends into Telegram-sized messages (limit 4096) */
export function chunks(lines, max = 3800) {
  const out = [];
  let cur = '';
  for (const raw of lines) {
    const line = raw.length > max ? raw.slice(0, max) : raw;
    if (cur && cur.length + 1 + line.length > max) { out.push(cur); cur = line; } else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

export async function sendLong(chatId, lines, extraOnLast = {}) {
  const parts = chunks(lines);
  let r = { ok: true };
  for (let i = 0; i < parts.length; i++) r = await send(chatId, parts[i], i === parts.length - 1 ? extraOnLast : {});
  return r;
}

export const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
