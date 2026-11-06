CREATE TABLE IF NOT EXISTS merit_accounts (
  iss TEXT NOT NULL,
  sub TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (iss, sub)
);

CREATE TABLE IF NOT EXISTS merit_batches (
  iss TEXT NOT NULL,
  sub TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  day TEXT NOT NULL,
  delta INTEGER NOT NULL CHECK (delta BETWEEN 1 AND 2000),
  wish_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (iss, sub, batch_id)
);

CREATE TABLE IF NOT EXISTS merit_days (
  iss TEXT NOT NULL,
  sub TEXT NOT NULL,
  day TEXT NOT NULL,
  merit INTEGER NOT NULL DEFAULT 0 CHECK (merit >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (iss, sub, day)
);

CREATE TABLE IF NOT EXISTS wishes (
  id TEXT NOT NULL PRIMARY KEY,
  iss TEXT NOT NULL,
  sub TEXT NOT NULL,
  content TEXT NOT NULL,
  target INTEGER NOT NULL CHECK (target IN (108, 1008, 10080)),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= target),
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS wishes_one_active_per_user
  ON wishes (iss, sub)
  WHERE completed_at IS NULL;

CREATE INDEX IF NOT EXISTS wishes_recent_completed
  ON wishes (iss, sub, completed_at DESC)
  WHERE completed_at IS NOT NULL;
