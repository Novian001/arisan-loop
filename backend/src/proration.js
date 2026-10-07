// proration.js — M5 membership window (build spec §5.4 step 3, §5.6 R6/R9/R11, §5.7
// cases 3–4, §5.8 challenge 4, §5.13 test 4).
//
// "Proration" here is the DELTA of positions + remaining periods (§5.4 step 3), not a
// fractional amount: an arisan contribution is a fixed integer amount PER PERIOD (§5.1/§5.3),
// so a joiner owes `amount` for every OPEN period from effective_seq on, and a leaver
// releases exactly the unpaid rows from effective_seq on. No division, no floats anywhere
// in the money path (R11: IDR has no subdivision — nothing to round).
//   ponytail: if per-period fractional entry shares are ever wanted, add ONE floor-div
//   helper here (floor(amount * remaining / total)); today no rule in the spec needs it.
//
// Rules enforced:
//   R6  apply only on the exact preview delta + token; stale/drifted token -> 409; drawn
//       periods (a period with a DrawEvent, or drawn/settled) are never touched.
//   R9  leave applies from the next undrawn period; paid-undrawn rows keep their draw
//       eligibility; NO contribution row is ever deleted — status changes only.
//   §5.8 challenge 4: the delta is recomputed as a pure function at confirm, so a preview
//       is a snapshot; replaying the SAME token with the SAME delta is idempotent (M5 proof).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  tx, get, all, run, bad, notFound, conflict, unprocessable, ValidationError,
} from './db.js';
import { assertInv1 } from './invariant.js';
import { audit, autoReady } from './ledger.js';
import { recomputeRotation } from './schedule.js';

const NAME_MAX = 60;

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

// The stored value is sha256(token), so the comparison hashes the candidate first — a raw
// token can never equal its own digest (the draft compared them directly: always false).
function sameToken(hash, token) {
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return false;
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return false;
  return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hashToken(token), 'hex'));
}

// Canonical JSON with sorted keys: the "exact preview delta" check (R6) must not depend on
// the client echoing keys in the same order it received them.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
const sameDelta = (a, b) => stable(a) === stable(b);

// R9 scope, one predicate shared by preview and apply: joined on/before seq, not left after.
function inScope(m, seq) {
  return (m.joined_seq ?? 1) <= seq && (m.left_seq == null || m.left_seq > seq);
}

// Period rows + drawn flag. Drawn = DrawEvent exists OR status drawn/settled: the DrawEvent
// is the immutable record (R6), the status covers a period settled by raw SQL.
function scheduleRows(db, groupId) {
  return all(db, `
    SELECT p.id, p.seq, p.status,
           (EXISTS(SELECT 1 FROM draw_events d WHERE d.period_id = p.id)
            OR p.status IN ('drawn','settled')) AS drawn
    FROM periods p WHERE p.group_id = ? ORDER BY p.seq`, groupId)
    .map((r) => ({ id: r.id, seq: r.seq, status: r.status, drawn: !!r.drawn }));
}

const firstUndrawn = (rows) => {
  const p = rows.find((r) => !r.drawn);
  return p ? p.seq : null;
};
const maxDrawnSeq = (rows) => rows.reduce((m, r) => (r.drawn ? Math.max(m, r.seq) : m), 0);

function loadGroup(db, groupId) {
  if (!Number.isInteger(groupId) || groupId < 1) throw bad('group_id must be a positive integer');
  const g = get(db, 'SELECT * FROM groups WHERE id = ?', groupId);
  if (!g) throw notFound(`group ${groupId} not found`);
  if (g.status !== 'open') throw conflict(`group ${g.id} is ${g.status}: membership is frozen`);
  return g;
}

function requireSchedule(db, groupId) {
  const rows = scheduleRows(db, groupId);
  if (rows.length === 0) throw unprocessable(`group ${groupId} has no periods`);
  const first = firstUndrawn(rows);
  if (first === null) {
    throw conflict('every period is already drawn: membership changes apply while a period is not yet drawn');
  }
  return { rows, first, maxSeq: rows[rows.length - 1].seq };
}

function pickEffectiveSeq(wanted, { first, maxSeq }) {
  const e = wanted === undefined || wanted === null ? first : wanted;
  if (!Number.isInteger(e)) throw bad('effective_seq must be an integer');
  if (e < 1 || e > maxSeq) throw bad(`effective_seq must be between 1 and ${maxSeq}`);
  return e;
}

// Join (§5.7 case 4): no retroactive rows and no mid-collection injection — the joiner gets
// rows only for OPEN periods from effective_seq on. `joiner_owed` per period pins the exact
// amount the confirm will write; `shifts` shows the position effects (§5.4 step 3).
function joinDelta(db, { groupId, displayName, sortOrder, effectiveSeq }) {
  const g = loadGroup(db, groupId);
  const { rows, first, maxSeq } = requireSchedule(db, groupId);

  const name = typeof displayName === 'string' ? displayName.trim() : '';
  if (name.length === 0 || name.length > NAME_MAX) {
    throw bad(`display_name must be a non-empty string of at most ${NAME_MAX} characters`);
  }
  if (get(db, 'SELECT id FROM members WHERE group_id = ? AND lower(display_name) = lower(?)', groupId, name)) {
    throw bad(`member '${name}' already exists in group ${groupId}`);
  }
  if (sortOrder !== undefined && sortOrder !== null && (!Number.isInteger(sortOrder) || sortOrder < 0)) {
    throw bad('sort_order must be a non-negative integer');
  }

  const e = pickEffectiveSeq(effectiveSeq, { first, maxSeq });
  if (e <= maxDrawnSeq(rows)) {
    throw conflict(
      `effective_seq ${e} is already drawn: joins apply from the next undrawn period (seq ${first})`,
      { next_undrawn_seq: first },
    );
  }

  const existing = all(db, 'SELECT * FROM members WHERE group_id = ? ORDER BY sort_order', groupId);
  const at = sortOrder === undefined || sortOrder === null ? existing.length : Math.min(sortOrder, existing.length);
  const shifts = existing
    .filter((m) => m.sort_order >= at)
    .map((m) => ({ member_id: m.id, from: m.sort_order, to: m.sort_order + 1 }));

  const periods = rows.filter((p) => p.seq >= e).map((p) => ({
    period_id: p.id,
    seq: p.seq,
    status: p.status,
    drawn: p.drawn,
    eligible_member_ids: existing.filter((m) => inScope(m, p.seq)).map((m) => m.id),
    joiner_owed: p.status === 'open' ? g.amount : null,
  }));
  const totalOwed = periods.reduce((s, p) => s + (p.joiner_owed ?? 0), 0);

  return {
    kind: 'join',
    group_id: groupId,
    display_name: name,
    sort_order: at,
    effective_seq: e,
    next_undrawn_seq: first,
    total_periods: maxSeq,
    amount_per_period: g.amount,
    shifts,
    periods,
    total_owed: totalOwed,
    note: 'joiner gets no contribution row before effective_seq and none for a period already collecting (no retroactive rows)',
  };
}

// Leave (§5.7 case 3): the delta shows BOTH effects — paid-undrawn rows keep their eligibility
// and their money (retained), unpaid rows from effective_seq are released (-> waived, never
// deleted, never refunded).
function leaveDelta(db, { groupId, memberId, effectiveSeq }) {
  const g = loadGroup(db, groupId);
  const { rows, first, maxSeq } = requireSchedule(db, groupId);
  if (!Number.isInteger(memberId) || memberId < 1) throw bad('member_id must be a positive integer');
  const m = get(db, 'SELECT * FROM members WHERE id = ? AND group_id = ?', memberId, groupId);
  if (!m) throw notFound(`member ${memberId} not found in group ${groupId}`);
  if (m.status === 'left') throw conflict(`member ${memberId} already left`);

  const e = pickEffectiveSeq(effectiveSeq, { first, maxSeq });
  if (e < first) {
    throw conflict(
      `leave applies from the next undrawn period (seq ${first}), not from a drawn one`,
      { next_undrawn_seq: first },
    );
  }

  const periods = rows.filter((p) => p.seq >= e).map((p) => {
    const c = get(db, 'SELECT id, amount, status FROM contributions WHERE period_id = ? AND member_id = ?', p.id, memberId);
    const paid = !!c && c.status === 'paid';
    const owing = !!c && (c.status === 'due' || c.status === 'partial');
    const eligibility = !c ? 'none' : p.drawn ? 'settled' : paid ? 'retained' : owing ? 'released' : 'none';
    return {
      period_id: p.id,
      seq: p.seq,
      status: p.status,
      drawn: p.drawn,
      contribution_id: c ? c.id : null,
      contribution_status: c ? c.status : null,
      released_amount: owing && !p.drawn ? c.amount : 0,
      retained_amount: paid && !p.drawn ? c.amount : 0,
      eligibility,
    };
  });

  const shifts = all(
    db, 'SELECT id, sort_order FROM members WHERE group_id = ? AND sort_order > ? ORDER BY sort_order',
    groupId, m.sort_order,
  ).map((x) => ({ member_id: x.id, from: x.sort_order, to: x.sort_order - 1 }));
  // The leaver keeps a row but leaves the rotation: their slot is parked at the end so the
  // members behind them can shift up without tripping UNIQUE(group_id, sort_order).
  const maxOrder = get(db, 'SELECT MAX(sort_order) AS n FROM members WHERE group_id = ?', groupId).n;

  return {
    kind: 'leave',
    group_id: groupId,
    member_id: memberId,
    display_name: m.display_name,
    sort_order: m.sort_order,
    effective_seq: e,
    next_undrawn_seq: first,
    total_periods: maxSeq,
    amount_per_period: g.amount,
    removes: [{ member_id: memberId, from: m.sort_order, to: maxOrder }],
    shifts,
    periods,
    amount_released: periods.reduce((s, p) => s + p.released_amount, 0),
    retained_amount: periods.reduce((s, p) => s + p.retained_amount, 0),
    note: 'paid rows are never deleted and never refunded — they keep their draw eligibility (R9); unpaid rows from effective_seq become waived',
  };
}

// Step 1 (§5.4 step 3): preview only. Nothing about the schedule changes — the single write
// is the membership_changes row whose hash authorises step 2.
export function previewMembershipChange(db, input) {
  if (input === null || typeof input !== 'object') throw bad('request body must be an object');
  const {
    kind, group_id: groupId, member_id: memberId, display_name: displayName,
    sort_order: sortOrder, effective_seq: effectiveSeq, actor_id: actorId = null,
  } = input;
  if (kind !== 'join' && kind !== 'leave') throw bad("kind must be 'join' or 'leave'");
  if (!Number.isInteger(groupId) || groupId < 1) throw bad('group_id must be a positive integer');
  if (actorId !== null && actorId !== undefined && !Number.isInteger(actorId)) {
    throw bad('actor_id must be an integer or null');
  }

  return tx(db, () => {
    const delta = kind === 'join'
      ? joinDelta(db, { groupId, displayName, sortOrder, effectiveSeq })
      : leaveDelta(db, { groupId, memberId, effectiveSeq });
    const token = randomBytes(32).toString('hex');
    const id = Number(run(
      db,
      `INSERT INTO membership_changes (group_id, member_id, kind, effective_seq, delta_json, preview_token_hash, actor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      groupId, kind === 'leave' ? memberId : null, kind, delta.effective_seq,
      JSON.stringify(delta), hashToken(token), actorId,
    ).lastInsertRowid);
    return { membership_change_id: id, preview_token: token, delta };
  });
}

// Recompute the delta from the STORED preview inputs (never from the submitted body), so a
// confirm can only ever re-derive what the token authorised. Any validation refusal here
// means the world moved since the preview -> 409, not 400.
function recompute(db, mc, stored) {
  try {
    return mc.kind === 'join'
      ? joinDelta(db, {
        groupId: mc.group_id,
        displayName: stored.display_name,
        sortOrder: stored.sort_order,
        effectiveSeq: mc.effective_seq,
      })
      : leaveDelta(db, {
        groupId: mc.group_id, memberId: mc.member_id, effectiveSeq: mc.effective_seq,
      });
  } catch (e) {
    if (e instanceof ValidationError && e.status === 400) {
      throw conflict(`preview delta is stale: ${e.message}`, { reason: e.message });
    }
    throw e;
  }
}

// Token replay (§5.13 test 4): the same token + the same delta returns the applied result
// without writing anything — apply happens exactly once.
function replayResult(db, mc, delta) {
  const member = mc.member_id ? get(db, 'SELECT * FROM members WHERE id = ?', mc.member_id) : null;
  if (!member) throw conflict('membership change was applied but its member row is missing');
  const base = {
    already_applied: true,
    membership_change: get(db, 'SELECT * FROM membership_changes WHERE id = ?', mc.id),
    member,
    delta,
  };
  return mc.kind === 'join'
    ? { ...base, contributions: all(db, 'SELECT * FROM contributions WHERE member_id = ? ORDER BY period_id', member.id) }
    : { ...base, amount_released: delta.amount_released };
}

// Step 2: apply only on exact preview delta + token (R6). Wrong delta, drifted state or a
// stale/unknown token -> 409, and the whole call is one transaction (roll back = no writes).
export function confirmMembershipChange(db, {
  membership_change_id: id, preview_token: token, delta, actor_id: actorId = null,
}) {
  if (!Number.isInteger(id)) throw bad('membership_change_id must be an integer');
  if (delta === null || typeof delta !== 'object' || Array.isArray(delta)) {
    throw bad('delta (the confirmed preview snapshot) is required');
  }
  if (actorId !== null && actorId !== undefined && !Number.isInteger(actorId)) {
    throw bad('actor_id must be an integer or null');
  }

  return tx(db, () => {
    const mc = get(db, 'SELECT * FROM membership_changes WHERE id = ?', id);
    if (!mc) throw notFound(`membership change ${id} not found`);
    if (!sameToken(mc.preview_token_hash, token)) throw conflict('stale or invalid preview token');
    const stored = mc.delta_json ? JSON.parse(mc.delta_json) : null;
    if (stored === null || typeof stored !== 'object') {
      throw conflict(`membership change ${id} has no stored preview delta`);
    }

    if (mc.confirmed_at) {
      if (!sameDelta(stored, delta)) {
        throw conflict('membership change already applied with a different delta', { expected: stored });
      }
      return replayResult(db, mc, stored);
    }

    if (!sameDelta(stored, delta)) {
      throw conflict('delta does not match the previewed delta: regenerate the preview', { expected: stored });
    }
    const fresh = recompute(db, mc, stored);
    if (!sameDelta(fresh, stored)) {
      throw conflict('preview delta is stale: state changed since the preview, regenerate the preview', {
        expected: fresh,
      });
    }
    return mc.kind === 'join' ? applyJoin(db, mc, stored, actorId) : applyLeave(db, mc, stored, actorId);
  });
}

// UNIQUE(group_id, sort_order) is checked per row write — one bulk `SET s = s ± 1` aborts
// mid-statement (probed). Shifts therefore walk row by row in the direction that vacates
// each target slot first: descending when moving up, ascending when moving down.
function shiftSortOrders(db, groupId, fromSort, step) {
  const rows = all(db, 'SELECT id, sort_order FROM members WHERE group_id = ?', groupId)
    .filter((m) => (step > 0 ? m.sort_order >= fromSort : m.sort_order > fromSort))
    .sort((a, b) => (step > 0 ? b.sort_order - a.sort_order : a.sort_order - b.sort_order));
  for (const m of rows) run(db, 'UPDATE members SET sort_order = ? WHERE id = ?', m.sort_order + step, m.id);
}

function applyJoin(db, mc, delta, actorId) {
  const g = get(db, 'SELECT * FROM groups WHERE id = ?', mc.group_id);
  if (g.status !== 'open') throw conflict(`group ${g.id} is ${g.status}: membership is frozen`);

  shiftSortOrders(db, g.id, delta.sort_order, 1);
  const memberId = Number(run(
    db,
    `INSERT INTO members (group_id, display_name, sort_order, status, is_organizer, joined_seq)
     VALUES (?, ?, ?, 'active', 0, ?)`,
    g.id, delta.display_name, delta.sort_order, mc.effective_seq,
  ).lastInsertRowid);

  // Only OPEN periods from effective_seq get rows (§5.7 case 4: no retroactive rows, no
  // mid-collection injection). Delta rows were re-verified as current moments ago (R6), so
  // joiner_owed != null still means "this period is open".
  let created = 0;
  for (const p of delta.periods) {
    if (p.joiner_owed === null) continue;
    run(db, "INSERT INTO contributions (period_id, member_id, amount, status) VALUES (?, ?, ?, 'due')",
      p.period_id, memberId, p.joiner_owed);
    created++;
  }

  recomputeRotation(db, g.id); // §22: add member -> schedule recompute
  run(
    db,
    `UPDATE membership_changes SET member_id = ?, confirmed_at = datetime('now'), actor_id = COALESCE(?, actor_id)
     WHERE id = ?`,
    memberId, actorId, mc.id,
  );
  audit(db, {
    groupId: g.id, entity: 'membership_change', entityId: mc.id, action: 'join_applied', actorId,
    payload: {
      member_id: memberId, effective_seq: mc.effective_seq, sort_order: delta.sort_order,
      contributions_created: created, total_owed: delta.total_owed,
    },
  });
  assertInv1(db, g.id);
  return {
    membership_change: get(db, 'SELECT * FROM membership_changes WHERE id = ?', mc.id),
    member: get(db, 'SELECT * FROM members WHERE id = ?', memberId),
    contributions: all(db, 'SELECT * FROM contributions WHERE member_id = ? ORDER BY period_id', memberId),
    delta,
  };
}

function applyLeave(db, mc, delta, actorId) {
  const g = get(db, 'SELECT * FROM groups WHERE id = ?', mc.group_id);
  if (g.status !== 'open') throw conflict(`group ${g.id} is ${g.status}: membership is frozen`);
  const mid = mc.member_id;

  // Park the leaver past the end first: UNIQUE(group_id, sort_order) needs slot `effective`
  // free for the member shifting up into it, and the downshift then walks the leaver back to
  // `max` (the delta records that move as `removes`).
  run(db, "UPDATE members SET status = 'left', left_seq = ? WHERE id = ?", delta.effective_seq, mid);
  run(db, 'UPDATE members SET sort_order = ? WHERE id = ?', delta.removes[0].to + 1, mid);
  shiftSortOrders(db, g.id, delta.sort_order, -1);

  // R9: rows are never deleted. Unpaid rows from effective_seq become `waived` (excluded from
  // money-in and from readiness); paid rows keep their money and their draw eligibility.
  let released = 0;
  const touched = [];
  for (const p of delta.periods) {
    if (p.released_amount === 0) continue;
    const c = get(db, 'SELECT id, amount, status FROM contributions WHERE id = ?', p.contribution_id);
    if (!c || (c.status !== 'due' && c.status !== 'partial')) {
      throw conflict('preview delta is stale: outstanding contributions changed since the preview');
    }
    run(
      db,
      "UPDATE contributions SET status = 'waived', proof_note = COALESCE(proof_note, ?) WHERE id = ?",
      `left group from seq ${delta.effective_seq}`, c.id,
    );
    released += c.amount;
    touched.push(p.period_id);
  }
  if (released !== delta.amount_released) {
    throw conflict('preview delta is stale: outstanding contributions changed since the preview');
  }

  recomputeRotation(db, g.id);
  // The waiver may be what the readiness gate was waiting for (§5.4 step 5) — same helper the
  // payment path uses, so a leaving non-payer can never strand a collectable period.
  for (const pid of touched) autoReady(db, pid);

  run(
    db,
    `UPDATE membership_changes SET confirmed_at = datetime('now'), actor_id = COALESCE(?, actor_id) WHERE id = ?`,
    actorId, mc.id,
  );
  audit(db, {
    groupId: g.id, entity: 'membership_change', entityId: mc.id, action: 'leave_applied', actorId,
    reason: `leave from seq ${delta.effective_seq}`,
    payload: {
      member_id: mid, effective_seq: delta.effective_seq, amount_released: released,
      retained_amount: delta.retained_amount,
    },
  });
  assertInv1(db, g.id);
  return {
    membership_change: get(db, 'SELECT * FROM membership_changes WHERE id = ?', mc.id),
    member: get(db, 'SELECT * FROM members WHERE id = ?', mid),
    amount_released: released,
    delta,
  };
}
