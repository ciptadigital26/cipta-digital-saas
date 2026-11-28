-- =====================================================================
-- OPR SMASID EXPRESS — Skema Cloudflare D1 (SQLite)
-- Jalankan SEKALI: Cloudflare Dashboard → Storage & Databases → D1 →
--   pangkalan data anda → Console → tampal semua → Execute
-- atau:  npx wrangler d1 execute opr-smasid-db --remote --file=schema.sql
-- =====================================================================

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name      TEXT NOT NULL DEFAULT '',
  pass_hash      TEXT NOT NULL,                 -- PBKDF2-SHA256, 100k pusingan
  pass_salt      TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'guru' CHECK (role IN ('guru','admin')),
  can_manage_all INTEGER NOT NULL DEFAULT 0 CHECK (can_manage_all IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Sesi log masuk: hanya HASH token disimpan (token asal hanya di pelayar)
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

-- Sekatan cubaan log masuk gagal
CREATE TABLE IF NOT EXISTS login_fail (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  count INTEGER NOT NULL DEFAULT 0,
  until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oprs (
  id         TEXT PRIMARY KEY,
  author_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kategori   TEXT CHECK (kategori IS NULL OR kategori IN ('akademik','hem','koku','ulul')),
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','confirmed','sent')),
  nama       TEXT,
  data       TEXT NOT NULL DEFAULT '{}',        -- JSON penuh OPR
  tg_status  TEXT, tg_sent_at TEXT, tg_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS oprs_author_idx ON oprs(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS oprs_kat_idx ON oprs(kategori, status);

CREATE TABLE IF NOT EXISTS settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  school_name TEXT,
  slogan      TEXT,
  logo_path   TEXT,
  tg_group    TEXT,
  updated_at  TEXT
);
INSERT OR IGNORE INTO settings(id, school_name) VALUES (1, 'SMASID');

-- Pengguna PERTAMA yang mendaftar akan menjadi admin secara automatik.
