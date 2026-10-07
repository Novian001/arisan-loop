// closure.js — M7 group finalisation (build spec §23 M7, §5.4 step 9, §5.6 R10, §5.7 cases
// 6/8, §5.11 statements, §22 POST /api/groups/:id/close).
// Two failure classes with deliberately different codes: a wrong STATE (a period not yet
// drawn — the membership window is still open — an unrecovered advance, an already-closed
// group) is a 409 with a human-readable reason; broken CONSERVATION (net != 0, e.g. an
// injected imbalance) is a 422 carrying the exact per-member / per-period breakdown (case 8).
// The close itself is ONE transaction: settle every drawn period, flip the group to
// `closed`, audit it — or nothing at all. Closure only ever appends (R12).
import { tx, get, all, run, bad, conflict, notFound, unprocessable } from './db.js';
import { transition } from './state-machine.js';
import { audit } from './ledger.js';
import { inv1, closureBalance, assertInv1 } from './invariant.js';

function loadGroup(db, groupId) {
  if (!Number.isInteger(groupId) || groupId < 1) throw bad('group_id must be a positive integer');
  const g = get(db, 'SELECT * FROM groups WHERE id = ?', groupId);
  if (!g) throw notFound(`group ${groupId} not found`);
  return g;
}

// §23 M7 "statements" / §5.11: per-member paid − received plus the group net badge. Built
// straight off the append-only ledger (§21: views read only from here) with LEFT JOIN so a
// member with no money at all still shows net 0. `net` sums EVERY signed leg, so an
// early-payout grant (+adjustment) and its recovery (−payout) both count and group_net hits
// 0 exactly when closure is legal. Read-only: works before and after the close.
export function statements(db, groupId) {
  const g = loadGroup(db, groupId);
  const members = all(db, `
    SELECT m.id AS member_id, m.display_name, m.is_organizer, m.status,
           COALESCE(SUM(CASE WHEN l.kind = 'contribution' AND l.sign = 1 THEN l.amount END), 0) AS paid,
           COALESCE(SUM(CASE WHEN l.kind = 'payout' AND l.sign = -1 THEN l.amount END), 0) AS received,
           COALESCE(SUM(CASE WHEN l.sign = 1 THEN l.amount END), 0)
             - COALESCE(SUM(CASE WHEN l.sign = -1 THEN l.amount END), 0) AS net
    FROM members m LEFT JOIN ledger l ON l.member_id = m.id
    WHERE m.group_id = ?
    GROUP BY m.id
    ORDER BY m.sort_order`, g.id);
  return {
    group_id: g.id,
    group_status: g.status,
    members,
    group_net: members.reduce((sum, m) => sum + m.net, 0),
  };
}

// §5.7 case 8: the 422 body must name WHERE the money is off — per member (statement) and
// per period (collected vs paid out) — so an imbalance is diagnosable, not just refused.
function imbalance(db, groupId) {
  const periods = all(db, `
    SELECT p.id AS period_id, p.seq, p.status,
           COALESCE((SELECT SUM(c.amount) FROM contributions c
                     WHERE c.period_id = p.id AND c.status = 'paid'), 0) AS collected,
           COALESCE((SELECT SUM(l.amount) FROM ledger l
                     WHERE l.period_id = p.id AND l.kind = 'payout' AND l.sign = -1), 0) AS paid_out
    FROM periods p WHERE p.group_id = ? ORDER BY p.seq`, groupId)
    .map((p) => ({ ...p, net: p.collected - p.paid_out }));
  return { members: statements(db, groupId).members, periods };
}

// Close the group (§5.4 step 9). Preconditions in order, all inside BEGIN IMMEDIATE:
// open group -> every period drawn (membership window closed) -> advances = 0 (R10 /
// §5.7 case 6) -> INV-2 and INV-1 both read 0. Then the final state is written once:
// every period walks to the `settled` leaf (state-machine.js: no edges out), the group
// flips open -> closed under a guarded UPDATE, one `group_closed` audit row, INV-1 re-asserted.
export function closeGroup(db, { groupId, actor_id: actorId = null } = {}) {
  if (actorId !== null && actorId !== undefined && !Number.isInteger(actorId)) {
    throw bad('actor_id must be an integer or null');
  }
  return tx(db, () => {
    const g = loadGroup(db, groupId);
    if (g.status === 'closed') {
      throw conflict(`group ${g.id} is already closed: closure is final and cannot be repeated`, {
        group_id: g.id, status: g.status,
      });
    }
    const actor = actorId === null || actorId === undefined ? null : actorId;
    if (actor !== null && !get(db, 'SELECT id FROM members WHERE id = ? AND group_id = ?', actor, g.id)) {
      throw bad(`actor ${actor} is not a member of group ${g.id}`);
    }

    const periods = all(db, `
      SELECT p.id, p.seq, p.status,
             (EXISTS(SELECT 1 FROM draw_events d WHERE d.period_id = p.id)
              OR p.status IN ('drawn','settled')) AS drawn
      FROM periods p WHERE p.group_id = ? ORDER BY p.seq`, g.id);
    if (periods.length === 0) throw conflict(`group ${g.id} has no periods: nothing to close`);
    const undrawn = periods.filter((p) => !p.drawn);
    if (undrawn.length > 0) {
      throw conflict(
        `cannot close group ${g.id}: ${undrawn.length} of ${periods.length} period(s) not yet drawn `
        + `(${undrawn.map((p) => `seq ${p.seq} is ${p.status}`).join(', ')}) — the membership window `
        + 'stays open until every period is drawn',
        { group_id: g.id, undrawn: undrawn.map((p) => ({ period_id: p.id, seq: p.seq, status: p.status })) },
      );
    }

    const adv = get(
      db,
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount
       FROM advances WHERE group_id = ? AND status = 'outstanding'`,
      g.id,
    );
    if (adv.n > 0) {
      throw conflict(
        `cannot close group ${g.id}: ${adv.n} unrecovered advance(s) totalling ${adv.amount} rupiah — `
        + 'settlement must be net-zero with advances = 0 (R10, §5.7 case 6)',
        { group_id: g.id, outstanding_advances: adv.n, amount: adv.amount },
      );
    }

    // R10 zero net: INV-2 (closure view) and INV-1 both read 0 once every period is drawn.
    // Failure is a 422 with the member/period breakdown (§23 M7) — never a silent or partial close.
    const net = closureBalance(db, g.id);
    const balance = inv1(db, g.id);
    if (net !== 0 || balance !== 0) {
      throw unprocessable(
        `closure refused for group ${g.id}: net ${net} != 0 (INV-1 balance ${balance})`,
        { group_id: g.id, net, inv1: balance, ...imbalance(db, g.id) },
      );
    }

    let settled = 0;
    for (const p of periods) {
      if (p.status === 'settled') continue;
      transition(db, p.id, 'settled'); // drawn|resolved -> settled: legal edge, then a leaf
      settled++;
    }
    const upd = run(db, "UPDATE groups SET status = 'closed' WHERE id = ? AND status = 'open'", g.id);
    if (Number(upd.changes) !== 1) throw conflict(`group ${g.id} was closed concurrently`);

    audit(db, {
      groupId: g.id, entity: 'group', entityId: g.id, action: 'group_closed', actorId: actor,
      payload: { periods: periods.length, settled, group_net: net, inv1: balance },
    });
    assertInv1(db, g.id); // INV-1 must still be 0 AFTER the final state is written

    return {
      group: get(db, 'SELECT * FROM groups WHERE id = ?', g.id),
      periods: all(db, 'SELECT id, seq, status FROM periods WHERE group_id = ? ORDER BY seq', g.id),
      statements: statements(db, g.id),
      periods_settled: settled,
      net,
    };
  });
}
