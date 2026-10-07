// schedule.js — group setup, K-period generation, rotation order, period lifecycle (M2).
// Rotation (R7): scheduled_recipient for seq s = member at index (s-1) mod n by sort_order.
// It is the fallback order and statement default; the drawn recipient (M4) may differ.
import { tx, get, all, run, bad, notFound } from './db.js';
import { transition } from './state-machine.js';
import { assertInv1 } from './invariant.js';
import { secretCommit } from './secret.js';
import { audit } from './ledger.js';

const NAME_MAX = 80;
const MEMBER_NAME_MAX = 60;
// R1: draw inputs n <= 30 (modulo-bias budget); a club of 1 is not an arisan.
const MIN_MEMBERS = 2;
const MAX_MEMBERS = 30;

function validateGroupInput(input) {
  if (input === null || typeof input !== 'object') throw bad('request body must be an object');
  const { name, amount, frequency, members, period_count: periodCount } = input;

  if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > NAME_MAX) {
    throw bad(`name must be a non-empty string of at most ${NAME_MAX} characters`);
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    throw bad('amount must be a positive integer number of rupiah (no floats, R11)');
  }
  if (frequency !== 'monthly' && frequency !== 'weekly') {
    throw bad("frequency must be 'monthly' or 'weekly'");
  }
  if (!Array.isArray(members) || members.length < MIN_MEMBERS || members.length > MAX_MEMBERS) {
    throw bad(`members must be an array of ${MIN_MEMBERS}..${MAX_MEMBERS} entries`);
  }
  const names = new Set();
  const clean = members.map((m, i) => {
    if (m === null || typeof m !== 'object') throw bad(`members[${i}] must be an object`);
    const dn = m.display_name;
    if (typeof dn !== 'string' || dn.trim().length === 0 || dn.trim().length > MEMBER_NAME_MAX) {
      throw bad(`members[${i}].display_name must be a non-empty string of at most ${MEMBER_NAME_MAX} characters`);
    }
    const trimmed = dn.trim();
    const key = trimmed.toLowerCase();
    if (names.has(key)) throw bad(`duplicate member name: ${trimmed}`);
    names.add(key);
    const isOrg = m.is_organizer === undefined ? 0 : (m.is_organizer === true ? 1 : m.is_organizer);
    if (isOrg !== 0 && isOrg !== 1) throw bad(`members[${i}].is_organizer must be 0 or 1`);
    return { display_name: trimmed, is_organizer: isOrg };
  });
  if (clean.filter((m) => m.is_organizer === 1).length > 1) {
    throw bad('at most one organizer per group');
  }

  let k = members.length;
  if (periodCount !== undefined) {
    if (!Number.isInteger(periodCount) || periodCount < 1 || periodCount > 365) {
      throw bad('period_count must be an integer between 1 and 365');
    }
    k = periodCount;
  }
  return { name: name.trim(), amount, frequency, members: clean, periodCount: k };
}

// Group setup (§5.4 step 1): members in payout order + K periods with rotation recipients.
export function createGroup(db, input) {
  const v = validateGroupInput(input);
  return tx(db, () => {
    const commit = secretCommit();
    const gid = Number(run(
      db,
      'INSERT INTO groups (name, amount, frequency, secret_commit) VALUES (?, ?, ?, ?)',
      v.name, v.amount, v.frequency, commit,
    ).lastInsertRowid);

    const memberIds = v.members.map((m, i) => Number(run(
      db,
      `INSERT INTO members (group_id, display_name, sort_order, status, is_organizer, joined_seq)
       VALUES (?, ?, ?, 'active', ?, 1)`,
      gid, m.display_name, i, m.is_organizer,
    ).lastInsertRowid));

    const periods = [];
    for (let seq = 1; seq <= v.periodCount; seq++) {
      const recipient = memberIds[(seq - 1) % memberIds.length];
      periods.push(Number(run(
        db,
        `INSERT INTO periods (group_id, seq, status, scheduled_recipient) VALUES (?, ?, 'open', ?)`,
        gid, seq, recipient,
      ).lastInsertRowid));
    }

    run(
      db,
      `INSERT INTO audit_log (group_id, entity, entity_id, action, actor_id, payload_json)
       VALUES (?, 'group', ?, 'create', ?, ?)`,
      gid, gid, memberIds[0],
      JSON.stringify({ members: v.members.length, periods: v.periodCount }),
    );
    assertInv1(db, gid);
    return {
      group: get(db, 'SELECT * FROM groups WHERE id = ?', gid),
      members: all(db, 'SELECT * FROM members WHERE group_id = ? ORDER BY sort_order', gid),
      periods: all(db, 'SELECT * FROM periods WHERE group_id = ? ORDER BY seq', gid),
    };
  });
}

// Open collection for one period: legal edge only, then one due row per member who is in
// scope for this seq (R9: no retroactive rows for joins/leaves — M5 relies on this filter).
export function openPeriod(db, periodId, actorId = null) {
  return tx(db, () => {
    const before = get(db, 'SELECT * FROM periods WHERE id = ?', periodId);
    if (!before) throw notFound(`period ${periodId} not found`);
    const period = transition(db, periodId, 'collecting');

    const created = db.prepare(`
      INSERT INTO contributions (period_id, member_id, amount, status)
      SELECT ?, m.id, g.amount, 'due'
      FROM members m JOIN groups g ON g.id = m.group_id
      WHERE m.group_id = ? AND m.status <> 'left'
        AND m.joined_seq <= ? AND (m.left_seq IS NULL OR m.left_seq > ?)
        AND NOT EXISTS (SELECT 1 FROM contributions c
                        WHERE c.period_id = ? AND c.member_id = m.id)
    `).run(period.id, before.group_id, period.seq, period.seq, period.id);

    run(
      db,
      `INSERT INTO audit_log (group_id, entity, entity_id, action, actor_id, payload_json)
       VALUES (?, 'period', ?, 'open_collection', ?, ?)`,
      before.group_id, period.id, actorId, JSON.stringify({ due_rows: Number(created.changes) }),
    );
    assertInv1(db, before.group_id);
    return {
      period,
      due_created: Number(created.changes),
      contributions: all(db, 'SELECT * FROM contributions WHERE period_id = ?', period.id),
    };
  });
}

// §22 POST /api/periods/:id/cancel — an all-paid `ready` period goes back to `collecting`
// (audited, R12). Only `ready` has this edge in PERIOD_EDGES; any other state is a 409 from
// transition(), so the route cannot invent a path the state machine and its DB trigger ban.
export function cancelPeriod(db, { periodId, actorId = null }) {
  return tx(db, () => {
    const before = get(db, 'SELECT * FROM periods WHERE id = ?', periodId);
    if (!before) throw notFound(`period ${periodId} not found`);
    const period = transition(db, periodId, 'collecting');
    audit(db, {
      groupId: before.group_id, entity: 'period', entityId: period.id, action: 'cancel_ready',
      actorId, payload: { from: 'ready', seq: period.seq },
    });
    assertInv1(db, before.group_id);
    return { period };
  });
}

// §22 "schedule recompute" + R5/R7: scheduled_recipient for every NOT-YET-DRAWN period
// follows the current rotation order among the members in scope for that seq (joined on/before,
// not left after — the same scope openPeriod uses). Drawn periods keep their original slot:
// the draw record and its rotation view are immutable (R6/R7). Deterministic + idempotent —
// an untouched group recomputes exactly what createGroup assigned.
export function recomputeRotation(db, groupId) {
  const periods = all(db, `
    SELECT p.id, p.seq, p.scheduled_recipient,
           (EXISTS(SELECT 1 FROM draw_events d WHERE d.period_id = p.id) OR p.status IN ('drawn','settled')) AS drawn
    FROM periods p WHERE p.group_id = ? ORDER BY p.seq`, groupId);
  const members = all(db, `
    SELECT id, sort_order, joined_seq, left_seq FROM members
    WHERE group_id = ? AND status <> 'left' ORDER BY sort_order`, groupId);
  for (const p of periods) {
    if (p.drawn) continue;
    const pool = members.filter((m) => (m.joined_seq ?? 1) <= p.seq && (m.left_seq == null || m.left_seq > p.seq));
    // ponytail: empty pool (every member left) keeps the previous slot; a group with no
    // members cannot draw anyway. Upgrade: refuse closing instead, once M7 defines it.
    if (pool.length === 0) continue;
    const recipient = pool[(p.seq - 1) % pool.length].id;
    run(db, 'UPDATE periods SET scheduled_recipient = ? WHERE id = ?', recipient, p.id);
  }
}

// GET timeline shape (§22): per period state, pot, rotation slot, draw ref (M4 fills draw).
export function timeline(db, groupId) {
  const g = get(db, 'SELECT * FROM groups WHERE id = ?', groupId);
  if (!g) throw notFound(`group ${groupId} not found`);
  const periods = all(db, `
    SELECT p.id, p.seq, p.status, p.version, p.scheduled_recipient, p.drawn_recipient,
           m.display_name AS scheduled_name,
           (SELECT d.id FROM draw_events d WHERE d.period_id = p.id) AS draw_event_id
    FROM periods p LEFT JOIN members m ON m.id = p.scheduled_recipient
    WHERE p.group_id = ? ORDER BY p.seq
  `, groupId);
  return { group_id: g.id, amount: g.amount, frequency: g.frequency, periods };
}
