// defaults.js — M6 default handling (build spec §5.4 step 7, §5.6 R4/R5, §5.7 case 5,
// §5.13 test 5, §23 M6). After grace a member is marked `defaulted`; the organizer then
// picks ONE audited resolution:
//   (a) early_payout — the due amount is waived into an advance (adjustment +a now,
//       payout -a from the next period when it collects → outstanding → recovered, R4);
//   (b) redistribute — the due amount is waived (recorded, excluded from money-in) and
//       the rotation is recomputed with the defaulter moved after the next member (R5).
// Both require reason + actor + timestamp. No ledger row is written here (§20: ledger.js is
// the only writer) — this module owns the case rows, the contribution waiver, the rotation
// shift and the period-state walk, and calls the ledger helpers for the money.
import { tx, get, all, run, bad, notFound, conflict } from './db.js';
import { transition } from './state-machine.js';
import { assertInv1 } from './invariant.js';
import { audit, shortPayers, grantAdvance, recoverAdvances } from './ledger.js';
import { recomputeRotation } from './schedule.js';

const PATHS = ['early_payout', 'redistribute'];
const REASON_MAX = 500;

function checkReason(reason) {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw bad('reason must be a non-empty string');
  }
  if (reason.trim().length > REASON_MAX) throw bad(`reason must be at most ${REASON_MAX} characters`);
  return reason.trim();
}

function checkActor(db, groupId, actorId) {
  if (actorId === null || actorId === undefined) return null;
  if (!Number.isInteger(actorId)) throw bad('actor_id must be an integer or null');
  if (!get(db, 'SELECT id FROM members WHERE id = ? AND group_id = ?', actorId, groupId)) {
    throw bad(`actor ${actorId} is not a member of group ${groupId}`);
  }
  return actorId;
}

function periodOf(db, periodId) {
  if (!Number.isInteger(periodId)) throw bad('periodId must be an integer');
  const p = get(db, 'SELECT * FROM periods WHERE id = ?', periodId);
  if (!p) throw notFound(`period ${periodId} not found`);
  return p;
}

// Detection: record WHO defaulted while the collection runs. No money moves, so INV-1 is
// unchanged — still asserted, per §5.8 challenge 2 ("each transition one assert"). The due
// row itself is the draw block (§5.7 case 5): R2 refuses while it is due/partial, so the
// draw stays blocked until a resolution waives it.
export function markDefault(db, { periodId, memberId, reason = null, actor_id: actorId = null }) {
  if (!Number.isInteger(memberId) || memberId < 1) throw bad('member_id must be a positive integer');
  if (reason !== null && reason !== undefined && typeof reason !== 'string') throw bad('reason must be a string or null');

  return tx(db, () => {
    const p = periodOf(db, periodId);
    if (!['collecting', 'resolved'].includes(p.status)) {
      throw conflict(`defaults are recorded while the period collects (period is ${p.status})`, {
        period_id: p.id, status: p.status,
      });
    }
    if (get(db, 'SELECT id FROM draw_events WHERE period_id = ?', p.id)) {
      throw conflict(`period ${p.id} already drawn: a default must be recorded before the draw`, { period_id: p.id });
    }
    const m = get(db, 'SELECT * FROM members WHERE id = ? AND group_id = ?', memberId, p.group_id);
    if (!m) throw notFound(`member ${memberId} not found in group ${p.group_id}`);
    if (m.status === 'left') throw conflict(`member ${memberId} has left the group`, { member_id: memberId });
    const c = get(db, 'SELECT * FROM contributions WHERE period_id = ? AND member_id = ?', p.id, memberId);
    if (!c) throw conflict(`member ${memberId} has no contribution row for period ${p.id}`, { period_id: p.id, member_id: memberId });
    if (c.status !== 'due' && c.status !== 'partial') {
      throw conflict(`nothing to default: contribution of member ${memberId} is ${c.status}`, {
        period_id: p.id, member_id: memberId, status: c.status,
      });
    }
    const open = get(
      db, 'SELECT id FROM default_cases WHERE period_id = ? AND member_id = ? AND resolution IS NULL',
      p.id, memberId,
    );
    if (open) {
      throw conflict(`member ${memberId} already has an open default case for period ${p.id} (case ${open.id})`, {
        period_id: p.id, member_id: memberId, default_case_id: open.id,
      });
    }
    const actor = checkActor(db, p.group_id, actorId);
    const why = reason === null || reason === undefined ? null : checkReason(reason);

    const caseId = Number(run(
      db, 'INSERT INTO default_cases (period_id, member_id) VALUES (?, ?)', p.id, memberId,
    ).lastInsertRowid);
    run(db, "UPDATE members SET status = 'defaulted' WHERE id = ? AND status <> 'defaulted'", memberId);
    audit(db, {
      groupId: p.group_id, entity: 'default_case', entityId: caseId, action: 'member_defaulted',
      actorId: actor, reason: why,
      payload: { period_id: p.id, member_id: memberId, contribution_status: c.status, owed: c.amount },
    });
    assertInv1(db, p.group_id);
    return {
      default_case: get(db, 'SELECT * FROM default_cases WHERE id = ?', caseId),
      member: get(db, 'SELECT * FROM members WHERE id = ?', memberId),
      period: get(db, 'SELECT * FROM periods WHERE id = ?', p.id),
    };
  });
}

// Resolution: reason + actor are REQUIRED on both paths (R5). One open case per call —
// member_id picks it when several are open. Everything rolls back together: the waiver, the
// path's writes, the case row and the period walk are a single atomic mutation, and INV-1 is
// asserted after each money-moving step.
export function resolveDefault(db, { periodId, memberId = null, path, reason, actor_id: actorId = null }) {
  if (!PATHS.includes(path)) throw bad(`path must be one of ${PATHS.join(', ')}`);
  const why = checkReason(reason);
  if (memberId !== null && memberId !== undefined && (!Number.isInteger(memberId) || memberId < 1)) {
    throw bad('member_id must be a positive integer or null');
  }
  if (actorId === null || actorId === undefined) {
    throw bad('actor_id is required to resolve a default (R5: reason + actor + timestamp)');
  }

  return tx(db, () => {
    const p = periodOf(db, periodId);
    if (get(db, 'SELECT id FROM draw_events WHERE period_id = ?', p.id)) {
      throw conflict(`period ${p.id} already drawn: defaults resolve before the draw`, { period_id: p.id });
    }
    const open = all(db, 'SELECT * FROM default_cases WHERE period_id = ? AND resolution IS NULL ORDER BY id', p.id);
    let kase;
    if (memberId !== null && memberId !== undefined) {
      kase = open.find((k) => k.member_id === memberId);
      if (!kase) {
        throw conflict(`no open default case for member ${memberId} in period ${p.id}`, {
          period_id: p.id, member_id: memberId, open_cases: open.length,
        });
      }
    } else if (open.length === 1) {
      [kase] = open;
    } else if (open.length === 0) {
      throw conflict(`period ${p.id} has no open default case`, { period_id: p.id });
    } else {
      throw bad(`period ${p.id} has ${open.length} open default cases: pass member_id to choose one`, {
        period_id: p.id, open_cases: open.map((k) => k.member_id),
      });
    }

    const c = get(db, 'SELECT * FROM contributions WHERE period_id = ? AND member_id = ?', p.id, kase.member_id);
    if (!c) throw conflict(`contribution row for member ${kase.member_id} missing in period ${p.id}`, { period_id: p.id });
    if (c.status !== 'due' && c.status !== 'partial') {
      throw conflict(`nothing to resolve: contribution of member ${kase.member_id} is ${c.status}`, {
        period_id: p.id, member_id: kase.member_id, status: c.status,
      });
    }
    const actor = checkActor(db, p.group_id, actorId);

    // R4/R5: the due row becomes waived — recorded and excluded from money-in, never deleted
    // (R9). It was never money in (only `paid` writes a leg), so INV-1 does not move here.
    run(db, "UPDATE contributions SET status = 'waived', proof_note = COALESCE(proof_note, ?) WHERE id = ?",
      `default ${path}: ${why}`, c.id);

    const detail = path === 'early_payout'
      ? pathEarlyPayout(db, p, kase, c.amount, actor)
      : pathRedistribute(db, p, kase.member_id);

    const done = run(
      db,
      `UPDATE default_cases SET resolution = ?, reason = ?, actor_id = ?, resolved_at = datetime('now')
       WHERE id = ? AND resolution IS NULL`,
      path, why, actor, kase.id,
    );
    if (Number(done.changes) !== 1) throw conflict(`default case ${kase.id} was resolved concurrently`);
    audit(db, {
      groupId: p.group_id, entity: 'default_case', entityId: kase.id, action: 'default_resolved',
      actorId: actor, reason: why,
      payload: { period_id: p.id, member_id: kase.member_id, path, contribution_id: c.id, amount: c.amount, ...detail },
    });
    assertInv1(db, p.group_id);

    // §5.4 "+ resolved after default handling": record the handling on the period, then —
    // collection complete (case 5's block lifted, the draw may proceed from `resolved`) —
    // rest there; others still owe → resume `collecting` so their payments can land.
    if (p.status === 'collecting') transition(db, p.id, 'resolved');
    if (shortPayers(db, p.id).length > 0) transition(db, p.id, 'collecting');
    recoverAdvances(db, p.id); // this period may itself be an earlier period's target
    if (path === 'early_payout') recoverAdvances(db, detail.target_period_id); // target may already have collected
    assertInv1(db, p.group_id);

    return {
      default_case: get(db, 'SELECT * FROM default_cases WHERE id = ?', kase.id),
      contribution: get(db, 'SELECT * FROM contributions WHERE id = ?', c.id),
      period: get(db, 'SELECT * FROM periods WHERE id = ?', p.id),
      ...detail,
    };
  });
}

// Path (a) R4: the next period funds the defaulter's claim. grantAdvance writes the
// adjustment + advance row (ledger.js) and asserts INV-1; recovery happens when the target
// period collects (recoverAdvances via autoReady, or immediately if it already has).
function pathEarlyPayout(db, p, kase, amount, actor) {
  const target = get(db, 'SELECT * FROM periods WHERE group_id = ? AND seq = ?', p.group_id, p.seq + 1);
  if (!target) {
    throw conflict(`path early_payout needs a target period: period ${p.seq} is the last one`, {
      period_id: p.id, seq: p.seq,
    });
  }
  const advance = grantAdvance(db, {
    groupId: p.group_id, periodId: p.id, targetPeriodId: target.id,
    memberId: kase.member_id, caseId: kase.id, amount, actorId: actor,
  });
  return { advance_id: advance.id, target_period_id: target.id, amount };
}

// Path (b) R5: no ledger legs. The defaulter swaps down one slot — the next member in
// rotation takes their position and the defaulter lands after them ("moved after the next
// member"). Already last → nothing to move past; the recompute below still runs (idempotent).
// ponytail: "next member" = next non-left member by sort_order; if the rotation should wrap
// instead, this is the one function to change.
function pathRedistribute(db, p, memberId) {
  const m = get(db, 'SELECT * FROM members WHERE id = ? AND group_id = ?', memberId, p.group_id);
  const next = get(
    db,
    `SELECT id, sort_order FROM members
     WHERE group_id = ? AND status <> 'left' AND sort_order > ? ORDER BY sort_order LIMIT 1`,
    p.group_id, m.sort_order,
  );
  let from = m.sort_order;
  let to = m.sort_order;
  if (next) {
    to = next.sort_order;
    const max = get(db, 'SELECT MAX(sort_order) AS n FROM members WHERE group_id = ?', p.group_id).n;
    run(db, 'UPDATE members SET sort_order = ? WHERE id = ?', max + 1, memberId); // park: frees `from`
    run(db, 'UPDATE members SET sort_order = ? WHERE id = ?', from, next.id);      // next takes the slot
    run(db, 'UPDATE members SET sort_order = ? WHERE id = ?', to, memberId);       // defaulter after them
  }
  recomputeRotation(db, p.group_id);
  return { member_id: memberId, from_sort: from, to_sort: to, moved: next ? 1 : 0 };
}
