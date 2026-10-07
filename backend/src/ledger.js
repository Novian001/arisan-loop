// ledger.js — the ONLY writer of ledger and audit rows (build spec §20).
// Collection flow (M3): contribution statuses due -> partial -> paid | waived (R11 integer
// money). Only `paid` is money in (§5.5), so only that status appends a ledger leg;
// `partial` keeps the period out of `ready` until the rest arrives.
import { tx, get, all, run, bad, notFound, conflict } from './db.js';
import { transition } from './state-machine.js';
import { assertInv1 } from './invariant.js';

// Contribution status machine: paid/waived are terminal, no step backwards (R9: rows are
// never deleted or rewritten to an earlier state — corrections are compensating entries).
const NEXT_STATUS = Object.freeze({
  due: ['partial', 'paid', 'waived'],
  partial: ['paid', 'waived'],
  paid: [],
  waived: [],
});

const RECORDABLE = ['partial', 'paid', 'waived'];
const NOTE_MAX = 500;

// Sole audit writer: every mutating action lands here with actor + timestamp (R12).
export function audit(db, { groupId, entity, entityId, action, actorId = null, reason = null, payload = null }) {
  run(
    db,
    `INSERT INTO audit_log (group_id, entity, entity_id, action, actor_id, reason, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    groupId, entity, entityId, action, actorId, reason,
    payload === null ? null : JSON.stringify(payload),
  );
}

// Members still owing for a period (organizer-only detail once RBAC lands, M4+).
export function shortPayers(db, periodId) {
  return all(db, `
    SELECT c.member_id, m.display_name, c.status
    FROM contributions c JOIN members m ON m.id = c.member_id
    WHERE c.period_id = ? AND c.status IN ('due', 'partial')
    ORDER BY m.sort_order
  `, periodId);
}

// R2's precondition as a reusable guard: draw (M4) calls this INSIDE its transaction.
export function assertReady(db, periodId) {
  const short = shortPayers(db, periodId);
  if (short.length > 0) {
    const detail = short.map((s) => `${s.display_name}: ${s.status}`).join(', ');
    throw conflict(`period not ready: ${short.length} contribution(s) outstanding (${detail})`, {
      period_id: periodId,
      short_payers: short,
    });
  }
  return true;
}

// The ONE place that decides a collection is complete (§5.4 step 5): no short payers while
// `collecting` -> ready. Payment (M3) and a leave waiver (M5) both land here, so readiness
// can never depend on which write happened to be last. M6 hooks advance recovery off the
// same moment (R4: "when the target period collects").
export function autoReady(db, periodId) {
  const p = get(db, 'SELECT * FROM periods WHERE id = ?', periodId);
  if (!p || p.status !== 'collecting' || shortPayers(db, periodId).length > 0) return p;
  return transition(db, periodId, 'ready');
}

// Record one member's payment step for a period. Auto-transitions collecting -> ready
// once every non-waived contribution is `paid` (server-side precondition, §5.4 step 5).
export function recordContribution(db, { periodId, memberId, status, proof_note: proofNote = null, actor_id: actorId = null }) {
  if (!RECORDABLE.includes(status)) {
    throw bad(`status must be one of ${RECORDABLE.join('|')}`);
  }
  if (proofNote !== null && (typeof proofNote !== 'string' || proofNote.length > NOTE_MAX)) {
    throw bad(`proof_note must be a string of at most ${NOTE_MAX} characters`);
  }

  return tx(db, () => {
    const period = get(db, 'SELECT * FROM periods WHERE id = ?', periodId);
    if (!period) throw notFound(`period ${periodId} not found`);
    const c = get(db, 'SELECT * FROM contributions WHERE period_id = ? AND member_id = ?', periodId, memberId);
    if (!c) throw notFound(`contribution for member ${memberId} in period ${periodId} not found`);
    if (period.status !== 'collecting') {
      throw conflict(`contributions can only change while collecting (period is ${period.status})`);
    }
    if (!NEXT_STATUS[c.status].includes(status)) {
      throw conflict(`illegal contribution transition: ${c.status} -> ${status}`);
    }

    if (status === 'paid') {
      run(db, `UPDATE contributions SET status = 'paid', paid_at = datetime('now'), proof_note = ? WHERE id = ?`,
        proofNote, c.id);
      // money in: one ledger leg for the full due amount (§5.5: only paid counts)
      run(db, `INSERT INTO ledger (group_id, period_id, member_id, kind, amount, sign, actor_id, reason, ref)
               VALUES (?, ?, ?, 'contribution', ?, 1, ?, 'contribution paid', ?)`,
        period.group_id, period.id, memberId, c.amount, actorId, `contribution:${c.id}`);
    } else {
      run(db, 'UPDATE contributions SET status = ?, proof_note = ? WHERE id = ?', status, proofNote, c.id);
    }

    audit(db, {
      groupId: period.group_id, entity: 'contribution', entityId: c.id,
      action: `contribution_${status}`, actorId,
      payload: { period_id: period.id, member_id: memberId },
    });

    // all non-waived paid? -> ready (one read, one edge, via the shared readiness helper)
    const updated = autoReady(db, period.id);

    assertInv1(db, period.group_id);
    return {
      contribution: get(db, 'SELECT * FROM contributions WHERE id = ?', c.id),
      period: updated,
      short_payers: shortPayers(db, period.id),
    };
  });
}
