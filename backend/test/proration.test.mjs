// M5 proof (build spec §23 M5 + §5.13 test 4 + §5.7 cases 3–4):
//   preview delta correct · confirm applies ONLY on exact delta + token (stale/drifted -> 409)
//   · token replay idempotent · paid-undrawn eligibility survives a leave · drawn periods
//   immutable · no contribution row ever deleted (R9) · INV-1 = 0 after every apply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, get, all } from '../src/db.js';
import { createGroup, openPeriod } from '../src/schedule.js';
import { recordContribution } from '../src/ledger.js';
import { drawPeriod } from '../src/draw.js';
import { previewMembershipChange, confirmMembershipChange } from '../src/proration.js';

process.env.ARISAN_SECRET = 'proration-test-secret';

const roster = [
  { display_name: 'Ana', is_organizer: 1 },
  { display_name: 'Bagus' },
  { display_name: 'Citra' },
  { display_name: 'Dewi' },
];

function setup({ period_count = 5 } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const g = createGroup(db, {
    name: 'Kas Arisan', amount: 50000, frequency: 'weekly', members: roster, period_count,
  });
  return { db, g, gid: g.group.id, ids: g.members.map((m) => m.id) };
}

const inv1 = (db, gid) => get(db, 'SELECT balance FROM v_group_inv1 WHERE group_id = ?', gid).balance;
const order = (db, gid) => all(db, 'SELECT display_name, sort_order FROM members WHERE group_id = ? ORDER BY sort_order', gid);
const recipients = (db, gid) => all(db, 'SELECT scheduled_recipient FROM periods WHERE group_id = ? ORDER BY seq', gid).map((p) => p.scheduled_recipient);

function pay(db, periodId, memberId) {
  return recordContribution(db, { periodId, memberId, status: 'paid', proof_note: 'transfer' });
}
function payRest(db, g, periodId, skipIds = []) {
  for (const m of g.members) if (!skipIds.includes(m.id)) pay(db, periodId, m.id);
}

test('join preview: delta shows positions + remaining periods, nothing else is written', () => {
  const { db, g, gid, ids } = setup();
  const membersBefore = all(db, 'SELECT id FROM members ORDER BY id');
  const recipientsBefore = recipients(db, gid);

  const { membership_change_id, preview_token, delta } = previewMembershipChange(db, {
    kind: 'join', group_id: gid, display_name: 'Eka', sort_order: 2, actor_id: ids[0],
  });

  assert.equal(delta.kind, 'join');
  assert.equal(delta.effective_seq, 1, 'defaults to the next undrawn period');
  assert.equal(delta.next_undrawn_seq, 1);
  assert.equal(delta.sort_order, 2, 'confirmed position');
  assert.deepEqual(delta.shifts, [
    { member_id: ids[2], from: 2, to: 3 },
    { member_id: ids[3], from: 3, to: 4 },
  ], 'positions shift from the insertion point (§5.4 step 3)');
  assert.equal(delta.periods.length, 5, 'one entry per remaining period');
  assert.ok(delta.periods.every((p) => p.joiner_owed === 50000),
    'arisan amount is fixed per period: integer rupiah, no fractional share (R11)');
  assert.equal(delta.total_owed, 5 * 50000);

  // preview is read-only apart from the token row
  assert.deepEqual(all(db, 'SELECT id FROM members ORDER BY id'), membersBefore, 'no member written');
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM contributions').n, 0, 'no contribution written');
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM membership_changes').n, 1);
  assert.equal(get(db, 'SELECT confirmed_at FROM membership_changes WHERE id = ?', membership_change_id).confirmed_at, null);
  assert.equal(get(db, 'SELECT preview_token_hash FROM membership_changes WHERE id = ?', membership_change_id).preview_token_hash.length, 64);
  assert.ok(preview_token.length === 64);
  assert.deepEqual(recipients(db, gid), recipientsBefore, 'schedule untouched by a preview');
  assert.equal(inv1(db, gid), 0);
  db.close();
});

test('join confirm: exact delta + token applies once, rotation recomputes, replay is idempotent', () => {
  const { db, g, gid, ids } = setup();
  const [ana, bagus, citra, dewi] = ids;
  const pv = previewMembershipChange(db, {
    kind: 'join', group_id: gid, display_name: 'Eka', sort_order: 2, actor_id: ana,
  });

  const out = confirmMembershipChange(db, {
    membership_change_id: pv.membership_change_id, preview_token: pv.preview_token,
    delta: pv.delta, actor_id: ana,
  });

  assert.equal(out.member.display_name, 'Eka');
  assert.equal(out.member.sort_order, 2);
  assert.equal(out.member.joined_seq, 1);
  assert.equal(out.member.status, 'active');
  assert.deepEqual(order(db, gid).map((m) => m.sort_order), [0, 1, 2, 3, 4]);
  assert.equal(out.contributions.length, 5, 'one due row per open period from effective_seq (§5.7 case 4)');
  assert.ok(out.contributions.every((c) => c.amount === 50000 && c.status === 'due'));
  assert.equal(out.membership_change.member_id, out.member.id, 'preview row back-filled with the member');
  assert.ok(out.membership_change.confirmed_at);

  // §22 "add member -> schedule recompute": rotation follows the new order
  const eka = out.member.id;
  assert.deepEqual(recipients(db, gid), [ana, bagus, eka, citra, dewi]);
  assert.equal(inv1(db, gid), 0, 'due rows move no money (R3)');

  const auditRow = get(db, "SELECT * FROM audit_log WHERE action = 'join_applied'");
  assert.equal(auditRow.actor_id, ana, 'actor attributed');
  assert.ok(auditRow.created_at, 'timestamped');
  assert.equal(JSON.parse(auditRow.payload_json).member_id, eka);

  // token replay (§5.13 test 4): same token + same delta -> applied exactly once, no writes
  const membersBefore = all(db, 'SELECT id FROM members ORDER BY id');
  const rowsBefore = all(db, 'SELECT id FROM contributions ORDER BY id');
  const replay = confirmMembershipChange(db, {
    membership_change_id: pv.membership_change_id, preview_token: pv.preview_token, delta: pv.delta,
  });
  assert.equal(replay.already_applied, true);
  assert.equal(replay.member.id, eka);
  assert.equal(replay.contributions.length, 5);
  assert.deepEqual(all(db, 'SELECT id FROM members ORDER BY id'), membersBefore, 'replay creates no member');
  assert.deepEqual(all(db, 'SELECT id FROM contributions ORDER BY id'), rowsBefore, 'replay creates no rows');
  assert.equal(inv1(db, gid), 0);

  // a different delta on a used token is a conflict, not a second apply
  assert.throws(
    () => confirmMembershipChange(db, {
      membership_change_id: pv.membership_change_id, preview_token: pv.preview_token,
      delta: { ...pv.delta, total_owed: 1 },
    }),
    (e) => e.status === 409 && /already applied with a different delta/.test(e.message),
  );
  db.close();
});

test('confirm refuses bad token, tampered delta, unknown id — and writes nothing', () => {
  const { db, gid, ids } = setup();
  const pv = previewMembershipChange(db, { kind: 'join', group_id: gid, display_name: 'Eka' });
  const membersBefore = all(db, 'SELECT id FROM members ORDER BY id');

  assert.throws(
    () => confirmMembershipChange(db, {
      membership_change_id: pv.membership_change_id, preview_token: 'a'.repeat(64), delta: pv.delta,
    }),
    (e) => e.status === 409 && /stale or invalid preview token/.test(e.message),
    'wrong token -> 409 (R6)',
  );
  assert.throws(
    () => confirmMembershipChange(db, {
      membership_change_id: pv.membership_change_id, preview_token: 'not-a-token', delta: pv.delta,
    }),
    (e) => e.status === 409 && /stale or invalid preview token/.test(e.message),
  );
  assert.throws(
    () => confirmMembershipChange(db, {
      membership_change_id: pv.membership_change_id, preview_token: pv.preview_token,
      delta: { ...pv.delta, total_owed: 999 },
    }),
    (e) => e.status === 409 && /does not match the previewed delta/.test(e.message),
    'exact preview delta only (R6)',
  );
  assert.throws(
    () => confirmMembershipChange(db, { membership_change_id: 999999, preview_token: pv.preview_token, delta: pv.delta }),
    (e) => e.status === 404,
  );
  assert.throws(
    () => confirmMembershipChange(db, { membership_change_id: 'x', preview_token: pv.preview_token, delta: pv.delta }),
    (e) => e.status === 400,
  );
  assert.throws(
    () => confirmMembershipChange(db, { membership_change_id: pv.membership_change_id, preview_token: pv.preview_token }),
    (e) => e.status === 400 && /delta/.test(e.message),
  );

  assert.deepEqual(all(db, 'SELECT id FROM members ORDER BY id'), membersBefore, 'refused confirms write nothing');
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM contributions').n, 0);
  assert.equal(inv1(db, gid), 0);
  db.close();
});

test('stale preview: state moved between preview and confirm -> 409, no partial write', () => {
  const { db, g, gid, ids } = setup();
  const stale = previewMembershipChange(db, { kind: 'join', group_id: gid, display_name: 'Eka', sort_order: 2 });

  // another join lands first and shifts the positions the stale preview promised
  const other = previewMembershipChange(db, { kind: 'join', group_id: gid, display_name: 'Fikri', sort_order: 0 });
  confirmMembershipChange(db, {
    membership_change_id: other.membership_change_id, preview_token: other.preview_token, delta: other.delta,
  });
  const ekaBefore = all(db, "SELECT id FROM members WHERE display_name = 'Eka'").length;

  assert.throws(
    () => confirmMembershipChange(db, {
      membership_change_id: stale.membership_change_id, preview_token: stale.preview_token, delta: stale.delta,
    }),
    (e) => e.status === 409 && /stale/.test(e.message),
    'fresh recompute must differ from the stored snapshot (§5.8 challenge 4)',
  );
  assert.equal(all(db, "SELECT id FROM members WHERE display_name = 'Eka'").length, ekaBefore);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM members').n, 5, 'only the non-stale join applied');
  assert.equal(inv1(db, gid), 0);
  db.close();
});

test('join into an already-drawn period is refused; a valid join leaves the draw record untouched', () => {
  const { db, g, gid, ids } = setup({ period_count: 3 });
  const [ana] = ids;
  const p1 = g.periods[0].id;
  openPeriod(db, p1, ana);
  payRest(db, g, p1);
  const drawn = drawPeriod(db, { periodId: p1, actor_id: ana });
  const deBefore = get(db, 'SELECT * FROM draw_events WHERE period_id = ?', p1);
  const p1ContribsBefore = all(db, 'SELECT id, status FROM contributions WHERE period_id = ?', p1);
  const p1RecipientBefore = get(db, 'SELECT scheduled_recipient FROM periods WHERE id = ?', p1).scheduled_recipient;

  assert.throws(
    () => previewMembershipChange(db, {
      kind: 'join', group_id: gid, display_name: 'Eka', effective_seq: 1,
    }),
    (e) => e.status === 409 && /already drawn/.test(e.message) && e.detail.next_undrawn_seq === 2,
    'effective_seq inside a drawn period -> 409 (R6)',
  );
  assert.throws(
    () => previewMembershipChange(db, { kind: 'leave', group_id: gid, member_id: ids[1], effective_seq: 1 }),
    (e) => e.status === 409 && /next undrawn period/.test(e.message),
  );

  // a legal join from seq 2 applies without touching the drawn period (R6/R7)
  const pv = previewMembershipChange(db, { kind: 'join', group_id: gid, display_name: 'Eka' });
  assert.equal(pv.delta.effective_seq, 2);
  assert.ok(pv.delta.periods.every((p) => p.seq >= 2), 'no entry for the drawn period');
  confirmMembershipChange(db, {
    membership_change_id: pv.membership_change_id, preview_token: pv.preview_token, delta: pv.delta,
  });

  assert.deepEqual(get(db, 'SELECT * FROM draw_events WHERE period_id = ?', p1), deBefore, 'DrawEvent immutable');
  assert.deepEqual(all(db, 'SELECT id, status FROM contributions WHERE period_id = ?', p1), p1ContribsBefore,
    'drawn period contributions untouched');
  assert.equal(get(db, 'SELECT scheduled_recipient FROM periods WHERE id = ?', p1).scheduled_recipient,
    p1RecipientBefore, 'drawn period rotation slot immutable');
  assert.equal(drawn.period.status, 'drawn');
  assert.equal(inv1(db, gid), 0);
  db.close();
});

test('leave (§5.7 case 3): paid-undrawn stays eligible, exits next, rows never deleted', () => {
  const { db, g, gid, ids } = setup();
  const [ana, bagus, citra, dewi] = ids;
  const p1 = g.periods[0].id;
  const p2 = g.periods[1].id;

  openPeriod(db, p1, ana);
  payRest(db, g, p1);
  drawPeriod(db, { periodId: p1, actor_id: ana });
  openPeriod(db, p2, ana);
  pay(db, p2, bagus); // paid the current (still undrawn) period

  const rowsBefore = all(db, 'SELECT id FROM contributions ORDER BY id').map((r) => r.id);
  const deBefore = get(db, 'SELECT * FROM draw_events WHERE period_id = ?', p1);

  const pv = previewMembershipChange(db, { kind: 'leave', group_id: gid, member_id: bagus, actor_id: ana });
  assert.equal(pv.delta.effective_seq, 2, 'leave applies from the next undrawn period (R9)');
  assert.equal(pv.delta.next_undrawn_seq, 2);
  const p2row = pv.delta.periods.find((p) => p.period_id === p2);
  assert.equal(p2row.eligibility, 'retained', 'paid-undrawn keeps its eligibility (effect 1)');
  assert.equal(p2row.retained_amount, 50000);
  assert.equal(p2row.released_amount, 0, 'paid money is never released or refunded');
  assert.equal(pv.delta.amount_released, 0);
  assert.equal(pv.delta.retained_amount, 50000);
  assert.deepEqual(pv.delta.removes, [{ member_id: bagus, from: 1, to: 3 }]);
  assert.deepEqual(pv.delta.shifts, [
    { member_id: citra, from: 2, to: 1 },
    { member_id: dewi, from: 3, to: 2 },
  ], 'positions shift up (effect 2)');

  const out = confirmMembershipChange(db, {
    membership_change_id: pv.membership_change_id, preview_token: pv.preview_token,
    delta: pv.delta, actor_id: ana,
  });
  assert.equal(out.member.status, 'left');
  assert.equal(out.member.left_seq, 2);
  assert.equal(out.amount_released, 0);

  // R9: append-only rows — same ids, paid row intact, leaver parked out of the rotation
  assert.deepEqual(all(db, 'SELECT id FROM contributions ORDER BY id').map((r) => r.id), rowsBefore,
    'no contribution row is ever deleted');
  assert.equal(get(db, 'SELECT status FROM contributions WHERE period_id = ? AND member_id = ?', p2, bagus).status,
    'paid', 'paid-undrawn row survives the leave');
  assert.deepEqual(order(db, gid).map((m) => m.sort_order), [0, 1, 2, 3], 'slots stay unique (UNIQUE(group_id, sort_order))');
  assert.equal(inv1(db, gid), 0, 'INV-1 after apply');

  // the paid leaver really is still eligible: their row puts them in the draw inputs (R9),
  // while the rotation slot of the period they left from moves on (R7)
  assert.notEqual(get(db, 'SELECT scheduled_recipient FROM periods WHERE id = ?', p2).scheduled_recipient, bagus);
  payRest(db, g, p2, [bagus]);
  const out2 = drawPeriod(db, { periodId: p2, actor_id: ana });
  const inputs = JSON.parse(get(db, 'SELECT inputs_json FROM draw_events WHERE period_id = ?', p2).inputs_json);
  assert.ok(inputs.includes(bagus), 'paid-undrawn member stays in the draw inputs');
  assert.equal(out2.period.status, 'drawn');
  assert.deepEqual(get(db, 'SELECT * FROM draw_events WHERE period_id = ?', p1), deBefore,
    'the earlier DrawEvent is untouched');
  assert.equal(inv1(db, gid), 0, 'INV-1 after the second draw');
  db.close();
});

test('leave releases unpaid rows as waived (never deleted) and unblocks the readiness gate', () => {
  const { db, g, gid, ids } = setup();
  const [ana, bagus] = ids;
  const p1 = g.periods[0].id;
  openPeriod(db, p1, ana);
  payRest(db, g, p1, [bagus]); // everyone paid except Bagus -> draw would be blocked (R2)
  assert.equal(get(db, 'SELECT status FROM periods WHERE id = ?', p1).status, 'collecting');

  const rowsBefore = all(db, 'SELECT id FROM contributions ORDER BY id').map((r) => r.id);
  const pv = previewMembershipChange(db, { kind: 'leave', group_id: gid, member_id: bagus, actor_id: ana });
  assert.equal(pv.delta.periods[0].eligibility, 'released');
  assert.equal(pv.delta.amount_released, 50000, 'delta shows the released obligation (§5.7 case 3)');

  const out = confirmMembershipChange(db, {
    membership_change_id: pv.membership_change_id, preview_token: pv.preview_token,
    delta: pv.delta, actor_id: ana,
  });
  assert.equal(out.amount_released, 50000);

  const row = get(db, 'SELECT * FROM contributions WHERE period_id = ? AND member_id = ?', p1, bagus);
  assert.equal(row.status, 'waived', 'status change only — R9: rows are never deleted');
  assert.match(row.proof_note, /left group from seq 1/);
  assert.deepEqual(all(db, 'SELECT id FROM contributions ORDER BY id').map((r) => r.id), rowsBefore);
  assert.equal(all(db, "SELECT * FROM ledger WHERE kind = 'payout'").length, 0, 'a leave moves no money');
  assert.equal(all(db, "SELECT * FROM ledger WHERE sign = -1").length, 0, 'nothing is ever refunded (R9)');
  assert.equal(get(db, 'SELECT status FROM periods WHERE id = ?', p1).status, 'ready',
    'the waiver completed the collection -> the shared readiness gate flips it (§5.4 step 5)');
  assert.equal(inv1(db, gid), 0, 'INV-1 after apply');

  // the group is not stranded: the draw goes through
  const out2 = drawPeriod(db, { periodId: p1, actor_id: ana });
  assert.equal(out2.period.status, 'drawn');
  assert.equal(inv1(db, gid), 0);
  db.close();
});

test('validation at the trust boundary: 400/404/409 with human-readable messages, no writes', () => {
  const { db, gid, ids } = setup();
  const members = all(db, 'SELECT id FROM members ORDER BY id');
  const cases = [
    [null, 400, /request body/],
    [{ kind: 'move', group_id: gid }, 400, /kind/],
    [{ kind: 'join', group_id: 'x' }, 400, /group_id/],
    [{ kind: 'join', group_id: 999999, display_name: 'Eka' }, 404, /not found/],
    [{ kind: 'join', group_id: gid }, 400, /display_name/],
    [{ kind: 'join', group_id: gid, display_name: '   ' }, 400, /display_name/],
    [{ kind: 'join', group_id: gid, display_name: 'ana' }, 400, /already exists/],
    [{ kind: 'join', group_id: gid, display_name: 'Eka', sort_order: -1 }, 400, /sort_order/],
    [{ kind: 'join', group_id: gid, display_name: 'Eka', effective_seq: 0 }, 400, /effective_seq/],
    [{ kind: 'join', group_id: gid, display_name: 'Eka', effective_seq: 99 }, 400, /effective_seq/],
    [{ kind: 'leave', group_id: gid }, 400, /member_id/],
    [{ kind: 'leave', group_id: gid, member_id: 999999 }, 404, /not found/],
    [{ kind: 'leave', group_id: gid, member_id: ids[1], effective_seq: 'now' }, 400, /effective_seq/],
  ];
  for (const [input, status, re] of cases) {
    assert.throws(() => previewMembershipChange(db, input),
      (e) => e.status === status && re.test(e.message),
      `expected ${status} matching ${re} for ${JSON.stringify(input)}`);
  }

  // a member who already left cannot leave twice
  const pv = previewMembershipChange(db, { kind: 'leave', group_id: gid, member_id: ids[3] });
  confirmMembershipChange(db, {
    membership_change_id: pv.membership_change_id, preview_token: pv.preview_token, delta: pv.delta,
  });
  assert.throws(() => previewMembershipChange(db, { kind: 'leave', group_id: gid, member_id: ids[3] }),
    (e) => e.status === 409 && /already left/.test(e.message));

  // closed group: membership frozen (409) for both kinds
  db.prepare("UPDATE groups SET status = 'closed' WHERE id = ?").run(gid);
  assert.throws(() => previewMembershipChange(db, { kind: 'join', group_id: gid, display_name: 'Eka' }),
    (e) => e.status === 409 && /frozen/.test(e.message));
  assert.throws(() => previewMembershipChange(db, { kind: 'leave', group_id: gid, member_id: ids[0] }),
    (e) => e.status === 409 && /frozen/.test(e.message));

  assert.equal(all(db, "SELECT id FROM members WHERE display_name = 'Eka'").length, 0, 'rejected previews write nothing');
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM contributions').n, 0);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM members').n, 4, 'membership count unchanged');
  assert.equal(inv1(db, gid), 0);
  db.close();
});

test('every period drawn -> membership window closed (409 for both kinds)', () => {
  const { db, g, gid, ids } = setup({ period_count: 1 });
  openPeriod(db, g.periods[0].id, ids[0]);
  payRest(db, g, g.periods[0].id);
  drawPeriod(db, { periodId: g.periods[0].id, actor_id: ids[0] });

  assert.throws(() => previewMembershipChange(db, { kind: 'join', group_id: gid, display_name: 'Eka' }),
    (e) => e.status === 409 && /already drawn/.test(e.message));
  assert.throws(() => previewMembershipChange(db, { kind: 'leave', group_id: gid, member_id: ids[1] }),
    (e) => e.status === 409 && /already drawn/.test(e.message));
  assert.equal(inv1(db, gid), 0);
  db.close();
});
