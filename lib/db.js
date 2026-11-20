/* Database: Neon Postgres on Vercel (DATABASE_URL / POSTGRES_URL). Tests inject PGlite (real Postgres, in memory).
   Tables are created on first use. */

let connPromise = null;
let ready = null;

async function open() {
  if (globalThis.__LW_TEST_DB) return globalThis.__LW_TEST_DB;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error('DATABASE_URL is not set');
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(url);
  return { query: async (text, params = []) => sql.query(text, params) };
}

const SCHEMA = [
  /* everyone who pressed Start (chat_id as text: Telegram ids are bigger than 32 bits) */
  `CREATE TABLE IF NOT EXISTS users (
     chat_id      TEXT PRIMARY KEY,
     name         TEXT NOT NULL DEFAULT '',
     username     TEXT NOT NULL DEFAULT '',
     lang         TEXT NOT NULL DEFAULT 'en',               -- en | zh
     is_admin     BOOLEAN NOT NULL DEFAULT false,
     admin_tries  INTEGER NOT NULL DEFAULT 0,               -- wrong /admin codes (locked after 5)
     blocked      BOOLEAN NOT NULL DEFAULT false,           -- the person blocked the bot: no alerts, no checks
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_active  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  /* the links each client watches */
  `CREATE TABLE IF NOT EXISTS links (
     id          SERIAL PRIMARY KEY,
     chat_id     TEXT NOT NULL REFERENCES users(chat_id) ON DELETE CASCADE,
     url         TEXT NOT NULL,
     status      TEXT NOT NULL DEFAULT 'new',               -- new | up | down
     reason      TEXT NOT NULL DEFAULT '',                  -- why it is down (timeout, dns, http…)
     code        INTEGER,                                   -- last HTTP status
     ms          INTEGER,                                   -- last answer time
     last_check  TIMESTAMPTZ,
     since       TIMESTAMPTZ,                               -- when the status last changed
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (chat_id, url)
   )`,
  `CREATE INDEX IF NOT EXISTS links_last_check ON links (last_check NULLS FIRST)`,
  /* small key/value store: the run lock, last run, support contact */
  `CREATE TABLE IF NOT EXISTS meta (
     key    TEXT PRIMARY KEY,
     value  TEXT NOT NULL DEFAULT '',
     until  TIMESTAMPTZ
   )`,
  /* Telegram may send the same update twice: each is handled once */
  `CREATE TABLE IF NOT EXISTS seen_updates (
     id  BIGINT PRIMARY KEY,
     at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

export async function db() {
  if (!connPromise) connPromise = open().catch((e) => { connPromise = null; throw e; });
  const conn = await connPromise;
  if (!ready) ready = (async () => { for (const s of SCHEMA) await conn.query(s); })().catch((e) => { ready = null; throw e; });
  await ready;
  return conn;
}

export async function q(text, params) { return (await db()).query(text, params); }

export async function getMeta(key) {
  const r = await q('SELECT value FROM meta WHERE key = $1', [key]);
  return r.length ? r[0].value : '';
}

export async function setMeta(key, value) {
  await q(`INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, String(value)]);
}

export function resetForTests() { connPromise = null; ready = null; }
