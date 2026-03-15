CREATE TABLE IF NOT EXISTS module_status (
  module             TEXT PRIMARY KEY,
  last_run           INTEGER,
  last_success       INTEGER,
  last_error         TEXT,
  run_count          INTEGER NOT NULL DEFAULT 0,
  error_count        INTEGER NOT NULL DEFAULT 0,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  alert_sent_at      INTEGER
);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  module  TEXT NOT NULL,
  action  TEXT NOT NULL,
  detail  TEXT,
  success INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS error_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  module  TEXT NOT NULL,
  message TEXT NOT NULL,
  stack   TEXT
);

CREATE TABLE IF NOT EXISTS preferences (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS token_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  module        TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL
);

-- data column extends spec's definition: stores JSON {callbackModule, callbackAction, callbackParams}
-- needed by callback-handler.js to execute the confirmed action
CREATE TABLE IF NOT EXISTS pending_confirmations (
  action_id   TEXT PRIMARY KEY,
  module      TEXT NOT NULL,
  description TEXT NOT NULL,
  data        TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_mapping (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  caldav_name   TEXT NOT NULL,
  caldav_id     TEXT NOT NULL UNIQUE,
  display_label TEXT NOT NULL,
  emoji         TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  owner_label   TEXT
);
