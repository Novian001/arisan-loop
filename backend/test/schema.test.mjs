// M1 proof: migration idempotent (memory + file), append-only tables reject UPDATE/DELETE
// at the DB level (R12), invariant views exist and baseline to 0 (R3/R10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, get, all, run } from '../src/db.js';

test('migration is idempotent in memory', () => {
  const db = openDb(':memory:');
  migrate(db);
  migrate(db); // second run must not throw
  const tables = all(db, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map((r) => r.name);
  for (const t of ['groups','members','periods','contributions','draw_events','ledger',
                   'advances','membership_changes','default_cases','overrides','audit_log']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  db.close();
});

test('migration is idempotent on a file DB across connections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arisan-mig-'));
  const file = join(dir, 'arisan.db');
  try {
    const db1 = openDb(file);
    migrate(db1);
    db1.close();
    const db2 = openDb(file);
    migrate(db2); // reopen + re-run must not throw
    assert.equal(get(db2, 'SELECT COUNT(*) AS n FROM sqlite_master').n > 0, true);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fixture: one group, one member, one period, one ledger row — enough to probe triggers.
function fixture() {
  const db = openDb(':memory:');
  migrate(db);
  run(db, "INSERT INTO groups (name, amount, frequency) VALUES ('Test', 100000, 'monthly')");
  const gid = get(db, 'SELECT id FROM groups').id;
  run(db, "INSERT INTO members (group_id, display_name, sort_order, status, is_organizer) VALUES (?,?,?,?,1)",
    gid, 'Ana', 0, 'active');
  const mid = get(db, 'SELECT id FROM members').id;
  run(db, "INSERT INTO periods (group_id, seq, status, scheduled_recipient) VALUES (?,1,'open',?)", gid, mid);
  const pid = get(db, 'SELECT id FROM periods').id;
  run(db, `INSERT INTO contributions (period_id, member_id, amount, status) VALUES (?,?,?, 'paid')`,
    pid, mid, 100000);
  run(db, `INSERT INTO ledger (group_id, period_id, member_id, kind, amount, sign, reason)
           VALUES (?,?,?,'contribution',100000,1,'initial')`, gid, pid, mid);
  run(db, `INSERT INTO overrides (period_id, recipient_member_id, reason, actor_id)
           VALUES (?,?, 'organizer reassign', ?)`, pid, mid, mid);
  run(db, `INSERT INTO audit_log (group_id, entity, entity_id, action, actor_id)
           VALUES (?, 'group', ?, 'create', ?)`, gid, gid, mid);
  run(db, `INSERT INTO draw_events (period_id, seed, algo, inputs_json, actor_id)
           VALUES (?, 'abc', 'sha256-index-v1', '[1]', ?)`, pid, mid);
  return { db, gid, mid, pid };
}

test('append-only tables reject UPDATE and DELETE (R12)', () => {
  const { db } = fixture();
  const probes = [
    ['UPDATE ledger SET amount = 1', 'ledger'],
    ['DELETE FROM ledger', 'ledger'],
    ['UPDATE draw_events SET seed = ?', 'draw_events'],
    ['DELETE FROM draw_events', 'draw_events'],
    ['UPDATE overrides SET reason = ?', 'overrides'],
    ['DELETE FROM overrides', 'overrides'],
    ['UPDATE audit_log SET action = ?', 'audit_log'],
    ['DELETE FROM audit_log', 'audit_log'],
  ];
  for (const [sql, table] of probes) {
    assert.throws(
      () => db.prepare(sql).run(...(sql.includes('?') ? ['x'] : [])),
      (e) => /append-only/.test(e.message),
      `${table}: ${sql} must be refused by trigger`,
    );
  }
  db.close();
});

test('INV views baseline to 0 for a group with no money moved', () => {
  const { db, gid, mid } = fixture();
  const inv1 = get(db, 'SELECT balance FROM v_group_inv1 WHERE group_id = ?', gid);
  const closure = get(db, 'SELECT balance FROM v_closure WHERE group_id = ?', gid);
  // paid contribution parked in an undrawn period cancels itself (R3)
  assert.equal(inv1.balance, 0, 'INV-1 must hold while money is parked in an undrawn period');
  assert.equal(closure.balance, 100000, 'INV-2 is the closure form: parked money counts as in');
  const stmt = get(db, 'SELECT * FROM v_member_statement WHERE member_id = ?', mid);
  assert.equal(stmt.paid, 100000);
  assert.equal(stmt.received, 0);
  db.close();
});

test('INV-1 stays 0 as money moves: draw payout cancels the parked collection', () => {
  const { db, gid, mid, pid } = fixture();
  // simulate the draw payout: period walks the legal edges out of collection
  run(db, "UPDATE periods SET status='collecting' WHERE id = ?", pid);
  run(db, "UPDATE periods SET status='ready' WHERE id = ?", pid);
  run(db, "UPDATE periods SET status='drawn' WHERE id = ?", pid);
  run(db, `INSERT INTO ledger (group_id, period_id, member_id, kind, amount, sign, reason)
           VALUES (?,?,?,'payout',100000,-1,'drawn pot')`, gid, pid, mid);
  assert.equal(get(db, 'SELECT balance FROM v_group_inv1 WHERE group_id = ?', gid).balance, 0);
  assert.equal(get(db, 'SELECT balance FROM v_closure WHERE group_id = ?', gid).balance, 0);
  db.close();
});
