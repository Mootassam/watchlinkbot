/* Settings from Vercel environment variables (read each time, so tests can change them). */
const num = (name, def, min = 0) => {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v >= min ? v : def;
};

export const cfg = {
  token: () => process.env.BOT_TOKEN || '',
  secret: () => process.env.CRON_SECRET || '',                      // protects /api/cron, /api/daily, /api/setup
  adminCode: () => process.env.ADMIN_CODE || '',                     // "/admin <code>" in Telegram makes you admin
  adminIds: () => String(process.env.ADMIN_IDS || '').split(/[\s,]+/).filter((x) => /^-?\d+$/.test(x)),
  tgApi: () => (process.env.TG_API || 'https://api.telegram.org').replace(/\/+$/, ''),
  maxLinks: () => num('MAX_LINKS', 20, 1),                           // per client (admins: no limit)
  timeout: () => num('CHECK_TIMEOUT_MS', 15000, 100),                // one attempt
  retryGap: () => num('RETRY_DELAY_MS', 4000, 0),                    // wait before the second attempt
  parallel: () => num('CHECK_PARALLEL', 16, 1),
  startWindow: () => num('START_WINDOW_MS', 20000, 0),               // start new checks only this long into a run (Vercel stops at 60 s)
  staleMin: () => num('STALE_MINUTES', 20, 1),                       // no run for this long = the 5-minute timer stopped
  allowPrivate: () => process.env.ALLOW_PRIVATE === '1',             // tests only: allow localhost links
};
