// Period state machine (build spec §5.4): open → collecting → ready → drawn → settled
// (+ resolved after default handling). This module is the app-level guard: it refuses
// illegal edges with a human-readable 409 and serialises writes with the optimistic
// version column (R8). schema.sql carries the SAME edge matrix as a BEFORE UPDATE trigger,
// so a raw-SQL writer hits RAISE(ABORT) — keep the two lists in sync (M2 test drives both).
import { get, run, conflict, notFound } from './db.js';

export const PERIOD_EDGES = Object.freeze({
  open: ['collecting'],
  collecting: ['ready', 'resolved'],
  ready: ['drawn', 'collecting', 'resolved'], // collecting = cancel (audited, later route)
  resolved: ['collecting', 'ready', 'drawn', 'settled'],
  drawn: ['settled', 'resolved'],
  settled: [], // leaf: closure state, never moves again
});

export const PERIOD_STATUSES = Object.freeze(Object.keys(PERIOD_EDGES));

export function canTransition(from, to) {
  return Array.isArray(PERIOD_EDGES[from]) && PERIOD_EDGES[from].includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw conflict(`illegal transition: ${from} -> ${to}`);
  }
}

// Single writer path: validate edge, then UPDATE guarded by id+status+version. 0 rows
// changed = someone else moved the period between read and write → 409, never a silent
// second draw (R8). Bumps version on every transition (optimistic lock for M4's draw).
export function transition(db, periodId, to) {
  const p = get(db, 'SELECT * FROM periods WHERE id = ?', periodId);
  if (!p) throw notFound(`period ${periodId} not found`);
  assertTransition(p.status, to);
  const res = run(
    db,
    'UPDATE periods SET status = ?, version = version + 1 WHERE id = ? AND status = ? AND version = ?',
    to, p.id, p.status, p.version,
  );
  if (Number(res.changes) !== 1) {
    throw conflict('period was modified concurrently (stale version)');
  }
  return get(db, 'SELECT * FROM periods WHERE id = ?', periodId);
}
