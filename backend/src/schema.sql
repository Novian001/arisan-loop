-- ArisenLoop schema. WHY: every invariant the build spec says the DB must own (R3/R10/R11/R12)
-- lives here, not in JS, so an app bug cannot rewrite history or accept float money.
-- Money: integer rupiah > 0 (R11); IDR has no subdivision worth a float.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  amount INTEGER NOT NULL CHECK (amount > 0),
  frequency TEXT NOT NULL CHECK (frequency IN ('monthly','weekly')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  secret_commit TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  status TEXT NOT NULL CHECK (status IN ('active','left','defaulted')),
  is_organizer INTEGER NOT NULL DEFAULT 0 CHECK (is_organizer IN (0,1)),
  joined_seq INTEGER,
  left_seq INTEGER,
  UNIQUE(group_id, display_name),
  UNIQUE(group_id, sort_order)
);

CREATE TABLE IF NOT EXISTS periods (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  status TEXT NOT NULL CHECK (status IN ('open','collecting','ready','drawn','settled','resolved')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  scheduled_recipient INTEGER REFERENCES members(id),
  drawn_recipient INTEGER REFERENCES members(id),
  UNIQUE(group_id, seq)
);

CREATE TABLE IF NOT EXISTS contributions (
  id INTEGER PRIMARY KEY,
  period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE RESTRICT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL CHECK (status IN ('due','partial','paid','waived')),
  paid_at TEXT,
  proof_note TEXT,
  UNIQUE(period_id, member_id)
);

-- Append-only (R12): the re-verifiable draw record.
CREATE TABLE IF NOT EXISTS draw_events (
  id INTEGER PRIMARY KEY,
  period_id INTEGER NOT NULL UNIQUE REFERENCES periods(id) ON DELETE RESTRICT,
  seed TEXT NOT NULL,
  algo TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  drawn_at TEXT NOT NULL DEFAULT (datetime('now')),
  actor_id INTEGER REFERENCES members(id)
);

-- Append-only (R12): corrections are compensating rows, never edits.
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  period_id INTEGER REFERENCES periods(id) ON DELETE RESTRICT,
  member_id INTEGER REFERENCES members(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('contribution','payout','adjustment')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  sign INTEGER NOT NULL CHECK (sign IN (1,-1)),
  actor_id INTEGER REFERENCES members(id),
  reason TEXT,
  ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS advances (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  from_period INTEGER REFERENCES periods(id),
  target_period INTEGER REFERENCES periods(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL CHECK (status IN ('outstanding','recovered')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  recovered_at TEXT
);

CREATE TABLE IF NOT EXISTS membership_changes (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('join','leave')),
  effective_seq INTEGER NOT NULL,
  delta_json TEXT,
  preview_token_hash TEXT,
  confirmed_at TEXT,
  actor_id INTEGER REFERENCES members(id)
);

CREATE TABLE IF NOT EXISTS default_cases (
  id INTEGER PRIMARY KEY,
  period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE RESTRICT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolution TEXT CHECK (resolution IN ('early_payout','redistribute')),
  reason TEXT,
  actor_id INTEGER REFERENCES members(id),
  resolved_at TEXT
);

-- Append-only (R12): reason NOT NULL (7 in build spec §5.7).
CREATE TABLE IF NOT EXISTS overrides (
  id INTEGER PRIMARY KEY,
  period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE RESTRICT,
  recipient_member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  actor_id INTEGER REFERENCES members(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only (R12): every mutating action, actor + timestamp attribution.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_id INTEGER REFERENCES members(id),
  reason TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- INV-1 (R3): conservation across a mutable schedule. Money in (paid contribution ledger
-- legs) minus money out (payout legs), minus money parked in not-yet-drawn periods, plus
-- outstanding advances funded later — exactly 0 in every state. Views read only from here.
CREATE VIEW IF NOT EXISTS v_group_inv1 AS
SELECT
  g.id AS group_id,
  COALESCE((SELECT SUM(l.amount) FROM ledger l WHERE l.group_id = g.id AND l.sign = 1), 0)
  - COALESCE((SELECT SUM(l.amount) FROM ledger l WHERE l.group_id = g.id AND l.sign = -1), 0)
  - COALESCE((
      SELECT SUM(c.amount) FROM contributions c
      JOIN periods p ON p.id = c.period_id
      WHERE p.group_id = g.id AND c.status = 'paid' AND p.status NOT IN ('drawn','settled')
    ), 0)
  + COALESCE((SELECT SUM(a.amount) FROM advances a WHERE a.group_id = g.id AND a.status = 'outstanding'), 0)
  AS balance
FROM groups g;

-- INV-2 (R10): closure form — everything drawn, no parked collections.
CREATE VIEW IF NOT EXISTS v_closure AS
SELECT
  g.id AS group_id,
  COALESCE((SELECT SUM(l.amount) FROM ledger l WHERE l.group_id = g.id AND l.sign = 1), 0)
  - COALESCE((SELECT SUM(l.amount) FROM ledger l WHERE l.group_id = g.id AND l.sign = -1), 0)
  + COALESCE((SELECT SUM(a.amount) FROM advances a WHERE a.group_id = g.id AND a.status = 'outstanding'), 0)
  AS balance
FROM groups g;

CREATE VIEW IF NOT EXISTS v_member_statement AS
SELECT
  m.group_id AS group_id,
  m.id AS member_id,
  COALESCE((SELECT SUM(l.amount) FROM ledger l
            WHERE l.member_id = m.id AND l.kind = 'contribution' AND l.sign = 1), 0) AS paid,
  COALESCE((SELECT SUM(l.amount) FROM ledger l
            WHERE l.member_id = m.id AND l.kind = 'payout' AND l.sign = -1), 0) AS received
FROM members m;

-- R12 append-only: corrections are compensating rows, never edits.
CREATE TRIGGER IF NOT EXISTS trg_draw_events_no_update BEFORE UPDATE ON draw_events
BEGIN
  SELECT RAISE(ABORT, 'append-only table: draw_events cannot be updated');
END;
CREATE TRIGGER IF NOT EXISTS trg_draw_events_no_delete BEFORE DELETE ON draw_events
BEGIN
  SELECT RAISE(ABORT, 'append-only table: draw_events cannot be deleted');
END;
CREATE TRIGGER IF NOT EXISTS trg_ledger_no_update BEFORE UPDATE ON ledger
BEGIN
  SELECT RAISE(ABORT, 'append-only table: ledger cannot be updated');
END;
CREATE TRIGGER IF NOT EXISTS trg_ledger_no_delete BEFORE DELETE ON ledger
BEGIN
  SELECT RAISE(ABORT, 'append-only table: ledger cannot be deleted');
END;
CREATE TRIGGER IF NOT EXISTS trg_overrides_no_update BEFORE UPDATE ON overrides
BEGIN
  SELECT RAISE(ABORT, 'append-only table: overrides cannot be updated');
END;
CREATE TRIGGER IF NOT EXISTS trg_overrides_no_delete BEFORE DELETE ON overrides
BEGIN
  SELECT RAISE(ABORT, 'append-only table: overrides cannot be deleted');
END;
CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'append-only table: audit_log cannot be updated');
END;
CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'append-only table: audit_log cannot be deleted');
END;

-- R8 defence in depth: drawn history is immutable (settled/resolved are leaves).
CREATE TRIGGER IF NOT EXISTS trg_periods_no_undraw BEFORE UPDATE OF status ON periods
WHEN OLD.status IN ('drawn','settled')
BEGIN
  SELECT RAISE(ABORT, 'illegal transition: drawn/settled periods are immutable');
END;
