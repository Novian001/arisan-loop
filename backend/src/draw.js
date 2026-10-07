// draw.js — the auditable draw (M4, build spec §5.6 R1/R2/R8, §5.8 challenge 1).
// Not Math.random, not a PRNG: winner = sha256 sampling over persisted {seed, algo,
// ordered inputs} so ANY participant re-runs verify() with stdlib hashing, no server trust.
// The raw secret never leaves secret.js — only the derived seed is persisted/served.
import { createHash } from 'node:crypto';
import { tx, get, all, run, bad, conflict, notFound, unprocessable } from './db.js';
import { getSecret } from './secret.js';
import { assertReady, audit } from './ledger.js';
import { assertInv1 } from './invariant.js';

export const ALGO = 'sha256-index-v1';

// R1: seed = sha256_hex(secret ‖ group_id ‖ period_seq ‖ nonce). Deterministic in the
// public coordinates (group, seq) + server-only secret: precomputing future winners means
// grinding a secret whose sha256 was committed at group creation (§5.8 fairness ceiling).
// ponytail: nonce defaults to '' — inject beacon entropy here later; verify() only ever
// reads the persisted seed, so the upgrade needs no client change.
export function deriveSeed(secret, groupId, seq, nonce = '') {
  return createHash('sha256').update(`${secret}${groupId}${seq}${nonce}`).digest('hex');
}

// R1: winner = inputs[int(sha256_hex(algo ‖ seed ‖ join(ids, ',')), 16) % n].
// BigInt, not parseInt: a 256-bit hex exceeds double precision and a client recomputing
// with BigInt/Web Crypto must land on the exact same index.
export function sampleIndex(algo, seed, ids) {
  const h = createHash('sha256').update(`${algo}${seed}${ids.join(',')}`).digest('hex');
  return Number(BigInt(`0x${h}`) % BigInt(ids.length));
}

// Client-checkable fairness (§5.4 step 8): from the public artifacts alone, recompute the
// winner and compare it with the server's drawn recipient.
export function verify({ seed, algo, inputs, drawn_recipient = null }) {
  if (typeof seed !== 'string' || !/^[0-9a-f]{64}$/.test(seed)) {
    throw bad('seed must be a 64-character lowercase hex sha256 string');
  }
  if (algo !== ALGO) throw unprocessable(`unsupported algo: expected '${ALGO}', got '${algo}'`);
  if (!Array.isArray(inputs) || inputs.length === 0
      || !inputs.every((x) => Number.isInteger(x) && x > 0)) {
    throw bad('inputs must be a non-empty array of positive integer member ids');
  }
  const index = sampleIndex(algo, seed, inputs);
  const member_id = inputs[index];
  return {
    index,
    member_id,
    ok: drawn_recipient === null ? null : member_id === drawn_recipient,
  };
}

// One draw per period: read-check-write inside BEGIN IMMEDIATE (tx), R2 precondition
// re-checked INSIDE the transaction, then the R8 guarded UPDATE — 0 rows changed means a
// concurrent writer won the race → 409 + ROLLBACK, never a second DrawEvent (period_id is
// UNIQUE on draw_events as the last line of defence).
export function drawPeriod(db, { periodId, actor_id: actorId = null }) {
  if (!Number.isInteger(periodId)) throw bad('periodId must be an integer');
  return tx(db, () => {
    const p = get(db, 'SELECT * FROM periods WHERE id = ?', periodId);
    if (!p) throw notFound(`period ${periodId} not found`);
    // R2 re-checked INSIDE the transaction, not in the HTTP layer. Run before the status
    // guard so §5.7 case 2 surfaces the short-payer's name instead of a bare state error.
    assertReady(db, periodId);
    // 'resolved' = default handled, collection complete (§5.4 "+ resolved after default
    // handling", M6): legal predecessor of drawn in PERIOD_EDGES, so the draw may proceed.
    if (p.status !== 'ready' && p.status !== 'resolved') {
      const drawn = get(db, 'SELECT id FROM draw_events WHERE period_id = ?', periodId);
      throw conflict(
        drawn
          ? `period ${periodId} already drawn (draw_event ${drawn.id})`
          : `draw requires period status 'ready' (period is ${p.status})`,
        { period_id: periodId, status: p.status },
      );
    }

    const g = get(db, 'SELECT * FROM groups WHERE id = ?', p.group_id);
    // Inputs = members with a contribution row for this period, ordered by rotation slot
    // (R9: paid-undrawn members keep their row, so they stay eligible).
    const inputs = all(
      db,
      `SELECT m.id FROM contributions c JOIN members m ON m.id = c.member_id
       WHERE c.period_id = ? ORDER BY m.sort_order`,
      periodId,
    ).map((r) => r.id);
    if (inputs.length === 0) throw conflict(`period ${periodId} has no eligible participants`);

    const pot = get(
      db,
      `SELECT COALESCE(SUM(amount), 0) AS pot FROM contributions
       WHERE period_id = ? AND status = 'paid'`,
      periodId,
    ).pot;
    if (pot === 0) throw conflict(`period ${periodId} has no paid contributions to pay out`);

    const seed = deriveSeed(getSecret(), g.id, p.seq);
    const index = sampleIndex(ALGO, seed, inputs);
    const winnerId = inputs[index];

    const drawId = Number(run(
      db,
      `INSERT INTO draw_events (period_id, seed, algo, inputs_json, actor_id)
       VALUES (?, ?, ?, ?, ?)`,
      periodId, seed, ALGO, JSON.stringify(inputs), actorId,
    ).lastInsertRowid);

    // R8 verbatim: must affect exactly 1 row; 0 → conflict → ROLLBACK (no orphan event).
    // The status predicate pins the state read above ('ready' or 'resolved'), so a
    // concurrent writer between get() and here still loses the race to version/status.
    const res = run(
      db,
      `UPDATE periods SET status = 'drawn', version = version + 1, drawn_recipient = ?
       WHERE id = ? AND status = ? AND version = ?`,
      winnerId, periodId, p.status, p.version,
    );
    if (Number(res.changes) !== 1) throw conflict('period was modified concurrently (stale version)');

    // Payout leg = the pot: the period drops out of INV-1's parked-collected term, so its
    // paid total must leave as money out in the same transaction (R3 — INV-1 stays 0).
    run(
      db,
      `INSERT INTO ledger (group_id, period_id, member_id, kind, amount, sign, actor_id, reason, ref)
       VALUES (?, ?, ?, 'payout', ?, -1, ?, 'drawn payout', ?)`,
      g.id, periodId, winnerId, pot, actorId, `draw:${drawId}`,
    );
    audit(db, {
      groupId: g.id, entity: 'draw_event', entityId: drawId, action: 'draw', actorId,
      payload: { period_id: periodId, seq: p.seq, algo: ALGO, winner_member_id: winnerId, inputs },
    });
    assertInv1(db, g.id);

    return {
      draw_event: get(db, 'SELECT * FROM draw_events WHERE id = ?', drawId),
      period: get(db, 'SELECT * FROM periods WHERE id = ?', periodId),
      inputs,
      index,
      winner_member_id: winnerId,
      pot,
    };
  });
}
