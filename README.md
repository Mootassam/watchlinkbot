# LinkWatch: Telegram bot that watches clients' links

Clients send their links to the bot. Every 5 minutes the bot opens each link. If a link goes down,
the client gets a message right away (with your contact), and so do you. When it's back, they get a "back up" message.

**Free:** it runs on Vercel (free) with a Neon database (free). A free cron-job.org account opens `/api/cron` every 5 minutes.

## What clients can do
- Send a link, or several at once (one per line), to start watching them.
- `/list` shows their links: 🟢 up / 🔴 down, with the reason and how long it has been down.
- `/check` checks everything now. `/remove` stops watching a link. `/lang` switches between English and 中文.

## What you (the admin) can do
- `/all`: every client and their links 🟢/🔴, with problems first.
- `/down`: only the links that are down now.
- `/clients`, `/client ID`, `/status` (is the timer running?).
- `/contact @you`: the contact shown in "down" alerts.
- You get a copy of every change (who, which link, why), a message for every new client, and a daily report at 08:00 UTC.
- If the 5-minute timer stops, the daily run warns you.

## How a check works
- The bot opens the link like a browser, waits up to 15 s, and follows redirects.
- **Up:** the server answered with 2xx/3xx, or 401/403/405/406/429 (the server is running but asks for a login or says "slow down").
- **Down:** timeout, domain not found, connection refused or dropped, an SSL problem or expired certificate, or HTTP 4xx/5xx (404, 500, 502, 503, Cloudflare 52x…).
- A failure is re-checked 4 s later before anyone is told, so a 1-second blip never alerts.
- Messages go out only when the status **changes**, never repeated every 5 minutes.
- The same link watched by several clients is opened once per run.
- Links to private or local networks are refused (127.x, 10.x, 192.168.x, 169.254.x, localhost…).

## Setup (once)
1. In Telegram, open **@BotFather**, send `/newbot`, and copy the token.
2. On Vercel, create a project from this folder and add a **Neon** database (Storage tab, free). That sets `DATABASE_URL`.
3. Add these Vercel environment variables:
   - `BOT_TOKEN`: from BotFather
   - `CRON_SECRET`: a long random text, the key for `/api/cron`, `/api/daily` and `/api/setup`
   - `ADMIN_CODE`: a long random text. Send `/admin <code>` to the bot once to become admin (the message is deleted).
   - optional: `ADMIN_IDS` (Telegram IDs, comma separated; `/myid` shows yours), `MAX_LINKS` (default 20 per client)
4. Deploy, then open once: `https://<your-site>/api/setup?key=<CRON_SECRET>`. This connects the bot and sets its menu.
5. On **cron-job.org**, create a job: URL `https://<your-site>/api/cron?key=<CRON_SECRET>`, every 5 minutes.
6. In Telegram, send `/admin <ADMIN_CODE>` to your bot, then `/contact @yourname`.

## Tests
`npm test` runs the whole bot against a fake Telegram, real test websites and a real Postgres (PGlite) in memory.
