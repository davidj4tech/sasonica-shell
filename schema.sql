-- Sasonica Shell schema. Two tables. Applied by install.mjs; safe to re-run.
CREATE TABLE IF NOT EXISTS commands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  command    TEXT    NOT NULL,
  status     TEXT    NOT NULL,          -- pending | running | done | error | rejected | timeout | cancelled
  output     TEXT,
  exit_code  INTEGER,
  sig        TEXT    NOT NULL,          -- HMAC-SHA256 hex over nonce "\n" command
  background INTEGER NOT NULL DEFAULT 0, -- 1: may run alongside the queue
  cancel     INTEGER NOT NULL DEFAULT 0, -- 1: stop it (the runner kills it)
  runner     TEXT,                       -- which runner claimed it (hostname)
  client     TEXT,                       -- which connector URL queued it (clients.label, or 'default')
  name       TEXT,                       -- the name that URL carried (/<secret>/<name>/mcp or ?as=), if any
  agent      TEXT,                       -- what the assistant says it is (clientInfo.name, or ua:<User-Agent>)
  kind       TEXT    NOT NULL DEFAULT 'shell', -- shell (a bash string) | tool (a typed call)
  nonce      TEXT    NOT NULL UNIQUE,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commands_pending ON commands (id) WHERE status = 'pending';

-- Added later: a row the runner may start alongside the queue rather than in
-- turn (run_command background=true). install.sh adds this column to a
-- database created before it existed; ALTER TABLE is not idempotent in
-- SQLite, so it is not repeated here.
-- ALTER TABLE commands ADD COLUMN background INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE commands ADD COLUMN cancel INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE commands ADD COLUMN runner TEXT;
-- ALTER TABLE commands ADD COLUMN client TEXT;
-- ALTER TABLE commands ADD COLUMN agent TEXT;
-- ALTER TABLE commands ADD COLUMN name TEXT;

-- One connector URL per assistant, so one can be revoked without rotating
-- the URL every other assistant holds. Only the sha256 of each path secret
-- is stored: reading this table does not give anyone a working URL.
-- The shared URL in SASONICA_URL_SECRET is the client 'default' and needs no
-- row here; a 'default' row exists only to revoke it, and carries the hash of
-- the secret it revoked, so rotating SASONICA_URL_SECRET brings a fresh
-- shared URL back. Written by `sasonica client`, read by the Worker.
CREATE TABLE IF NOT EXISTS clients (
  label         TEXT PRIMARY KEY,          -- [a-z0-9._-]{1,32}
  secret_sha256 TEXT NOT NULL UNIQUE,      -- hex sha256 of the path secret
  created_at    TEXT NOT NULL,
  revoked_at    TEXT                       -- NULL while the URL works
);

-- Typed tools (docs/tools-and-approvals.md §1): what each runner publishes.
-- The argv template is NOT here and never leaves the runner -- that is the
-- security property. This table holds only what the Worker needs to list a
-- tool and check a call's arguments before queueing it: the name, the
-- description, the JSON Schema, and the sha256 of the runner's own manifest
-- entry, which is copied onto the row so the runner can refuse a call made
-- against a manifest it has since changed.
CREATE TABLE IF NOT EXISTS tools (
  runner      TEXT NOT NULL,
  name        TEXT NOT NULL,            -- on the wire: <skill>__<tool>
  description TEXT NOT NULL,
  input       TEXT NOT NULL,            -- JSON Schema, as JSON text
  sha256      TEXT NOT NULL,            -- of the runner's manifest entry
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (runner, name)
);

-- Added later: which kind of row this is -- 'shell' (run_command, a bash
-- string) or 'tool' (a typed call: command is canonical JSON naming the
-- tool, its arguments and the manifest it was made against). ALTER TABLE is
-- not idempotent in SQLite, so install.sh adds it to an older database:
-- ALTER TABLE commands ADD COLUMN kind TEXT NOT NULL DEFAULT 'shell';

-- Sign-in approved in the Sasonica app (docs/tools-and-approvals.md §6,
-- SASONICA_SIGNIN=app): a connector's sign-in waits here, with a short code
-- the page shows, until the owner approves or denies it on the phone. The
-- runner sees the pending count on every claim; red5's server asks for the
-- list and signs the decision with relay.key. `state` is the OAuth state the
-- page's own browser holds, so an approval completes only that sign-in.
CREATE TABLE IF NOT EXISTS signins (
  id          TEXT PRIMARY KEY,           -- 32 hex, unguessable: the page polls by it
  code        TEXT NOT NULL,              -- 6 letters/digits, shown on the page and in the app
  client_name TEXT,                       -- what the assistant calls itself (unverified)
  client_host TEXT,                       -- where its access goes (the redirect's host)
  state       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied
  created_at  TEXT NOT NULL,
  decided_at  TEXT
);
