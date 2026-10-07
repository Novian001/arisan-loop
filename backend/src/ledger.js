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

// R4 grant: "Due for P waived into an advance: adjustment(+a, reason=early_payout_grant) +
// outstanding_advances += a." Lives here because §20 makes ledger.js the only writer of
// ledger/audit rows — defaults.js orchestrates the case and calls this. Asserts INV-1 before
// returning: the grant is only balanced because v_group_inv1 subtracts the open claim.
export function grantAdvance(db, { groupId, periodId, targetPeriodId, memberId, caseId, amount, actorId = null }) {
  const advId = Number(run(
    db,
    `INSERT INTO advances (group_id, member_id, from_period, target_period, amount, status)
     VALUES (?, ?, ?, ?, ?, 'outstanding')`,
    groupId, memberId, periodId, targetPeriodId, amount,
  ).lastInsertRowid);
  run(
    db,
    `INSERT INTO ledger (group_id, period_id, member_id, kind, amount, sign, actor_id, reason, ref)
     VALUES (?, ?, ?, 'adjustment', ?, 1, ?, 'early_payout_grant', ?)`,
    groupId, periodId, memberId, amount, actorId, `default_case:${caseId}`,
  );
  audit(db, {
    groupId, entity: 'advance', entityId: advId, action: 'advance_granted', actorId,
    reason: 'early_payout_grant',
    payload: { period_id: periodId, target_period_id: targetPeriodId, member_id: memberId, amount },
  });
  assertInv1(db, groupId);
  return get(db, 'SELECT * FROM advances WHERE id = ?', advId);
}

// R4 recovery: "when the target period collects, payout (-a, kind=early_default_payout)
// recovers it." Fires whenever an advance's target period has actually collected (resolved /
// ready / drawn / settled with nothing outstanding) — i.e. from autoReady when a collection
// completes, and defensively from defaults.js when a target was already collected. One leg +
// one status flip per advance; grant and recovery are the two halves of the same audited pair
// (grantAdvance above).
export function recoverAdvances(db, periodId) {
  const p = get(db, 'SELECT * FROM periods WHERE id = ?', periodId);
  if (!p || !['resolved', 'ready', 'drawn', 'settled'].includes(p.status)) return 0;
  if (shortPayers(db, periodId).length > 0) return 0; // collection not actually complete
  const open = all(db, "SELECT * FROM advances WHERE target_period = ? AND status = 'outstanding' ORDER BY id", periodId);
  for (const a of open) {
    run(
      db,
      `INSERT INTO ledger (group_id, period_id, member_id, kind, amount, sign, actor_id, reason, ref)
       VALUES (?, ?, ?, 'payout', ?, -1, NULL, 'early_default_payout', ?)`,
      a.group_id, periodId, a.member_id, a.amount, `advance:${a.id}`,
    );
    const res = run(
      db,
      "UPDATE advances SET status = 'recovered', recovered_at = datetime('now') WHERE id = ? AND status = 'outstanding'",
      a.id,
    );
    if (Number(res.changes) !== 1) throw conflict(`advance ${a.id} was recovered concurrently`);
    audit(db, {
      groupId: a.group_id, entity: 'advance', entityId: a.id, action: 'advance_recovered',
      reason: 'early_default_payout',
      payload: { period_id: periodId, member_id: a.member_id, amount: a.amount },
    });
  }
  if (open.length > 0) assertInv1(db, p.group_id);
  return open.length;
}

// The ONE place that decides a collection is complete (§5.4 step 5): no short payers while
// `collecting` -> ready. Payment (M3) and a leave waiver (M5) both land here, so readiness
// can never depend on which write happened to be last. Advance recovery (R4) hangs off the
// same moment: the target period has just collected.
export function autoReady(db, periodId) {
  const p = get(db, 'SELECT * FROM periods WHERE id = ?', periodId);
  if (!p || p.status !== 'collecting' || shortPayers(db, periodId).length > 0) return p;
  const ready = transition(db, periodId, 'ready');
  recoverAdvances(db, periodId);
  return ready;
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
