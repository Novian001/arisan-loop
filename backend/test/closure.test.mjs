// M7 proof (build spec §23 M7 + §5.4 step 9 + §5.6 R10 + §5.7 cases 6/8 + §5.13 test 1):
//   statements report per-member paid − received with a group_net of 0 · close on zero net
//   settles every period, flips the group and writes ONE group_closed audit row · wrong
//   state (period not yet drawn = membership window open, unrecovered advance, repeat
//   close) -> 409 with a human-readable reason and nothing written · injected imbalance ->
//   422 carrying the exact member/period breakdown · INV-1 = 0 throughout closure · after
//   the close every write is refused (app 4xx + DB triggers, append-only intact).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, get, all, run } from '../src/db.js';
import { createGroup, openPeriod } from '../src/schedule.js';
import { recordContribution } from '../src/ledger.js';
import { drawPeriod } from '../src/draw.js';
import { markDefault, resolveDefault } from '../src/defaults.js';
import { previewMembershipChange } from '../src/proration.js';
import { closeGroup, statements } from '../src/closure.js';

process.env.ARISAN_SECRET = 'closure-test-secret';

const roster = [
  { display_name: 'Ana', is_organizer: 1 },
  { display_name: 'Bagus' },
  { display_name: 'Citra' },
  { display_name: 'Dewi' },
];

function setup({ period_count = 3 } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const g = createGroup(db, {
    name: 'Kas Arisan', amount: 50000, frequency: 'weekly', members: roster, period_count,
  });
  return { db, g, gid: g.group.id, ids: g.members.map((m) => m.id) };
}

const inv1 = (db, gid) => get(db, 'SELECT balance FROM v_group_inv1 WHERE group_id = ?', gid).balance;
const closures = (db) => all(db, "SELECT * FROM audit_log WHERE action = 'group_closed'");
const ledgerCount = (db) => get(db, 'SELECT COUNT(*) AS n FROM ledger').n;
const states = (db) => all(db, 'SELECT id, status FROM periods ORDER BY id');

function pay(db, periodId, memberId) {
  return recordContribution(db, { periodId, memberId, status: 'paid', proof_note: 'transfer' });
}
function payAll(db, members, periodId) {
  for (const m of members) pay(db, periodId, m.id);
}
// Every period: open -> all members pay -> draw. The plain happy path.
function runCycle(db, g, ids) {
  for (const p of g.periods) {
    openPeriod(db, p.id, ids[0]);
    payAll(db, g.members, p.id);
    drawPeriod(db, { periodId: p.id, actor_id: ids[0] });
  }
}

test('close on zero net: statements, settle-all, one audit row, INV-1 = 0 throughout (§23 M7)', () => {
  const { db, g, gid, ids } = setup({ period_count: 3 });
  runCycle(db, g, ids);
  const ledgerBefore = ledgerCount(db);
  const drawsBefore = get(db, 'SELECT COUNT(*) AS n FROM draw_events').n;

  // statements (§23 M7, §5.11): paid − received per member, group net = 0 badge
  const st = statements(db, gid);
  assert.equal(st.group_status, 'open');
  assert.equal(st.members.length, 4);
  for (const m of st.members) {
    assert.equal(m.paid, 150000, `${m.display_name} paid 3 × 50000`);
  }
  assert.equal(
    st.members.reduce((s, m) => s + m.received, 0), 600000,
    'every pot (4 × 50000) was paid out',
  );
  assert.equal(st.group_net, 0, 'group net = 0 badge (§5.11)');
  assert.equal(inv1(db, gid), 0, 'INV-1 before the close');

  const out = closeGroup(db, { groupId: gid, actor_id: ids[0] });

  assert.equal(out.group.status, 'closed');
  assert.equal(out.net, 0);
  assert.equal(out.periods_settled, 3);
  assert.ok(out.periods.every((p) => p.status === 'settled'), 'every period rests in the settled leaf');
  assert.equal(inv1(db, gid), 0, 'INV-1 stays 0 through closure');
  assert.equal(out.statements.group_net, 0, 'statements still balance after the close');

  const aud = closures(db);
  assert.equal(aud.length, 1, 'exactly one group_closed audit row');
  assert.equal(aud[0].entity, 'group');
  assert.equal(aud[0].entity_id, gid);
  assert.equal(aud[0].actor_id, ids[0]);
  assert.ok(aud[0].created_at, 'audit timestamped');
  assert.deepEqual(JSON.parse(aud[0].payload_json), { periods: 3, settled: 3, group_net: 0, inv1: 0 });

  // append-only history preserved: closure moves no money and rewrites no draw
  assert.equal(ledgerCount(db), ledgerBefore, 'closure writes no ledger legs');
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM draw_events').n, drawsBefore);

  // idempotency / illegal re-close -> 409, no second audit row
  assert.throws(
    () => closeGroup(db, { groupId: gid }),
    (e) => e.status === 409 && /already closed/.test(e.message),
  );
  assert.equal(closures(db).length, 1, 'the refused re-close wrote nothing');
  db.close();
});

test('advance path (a) recovered first, then closure succeeds — advances = 0 is live, not vacuous', () => {
  const { db, g, gid, ids } = setup({ period_count: 4 });
  const [ana, bagus] = ids;
  const [p1, p2] = g.periods;

  openPeriod(db, p1.id, ana);
  payAll(db, g.members.filter((m) => m.id !== bagus), p1.id);
  markDefault(db, { periodId: p1.id, memberId: bagus, actor_id: ana });
  resolveDefault(db, {
    periodId: p1.id, memberId: bagus, path: 'early_payout',
    reason: 'grace habis', actor_id: ana,
  });
  drawPeriod(db, { periodId: p1.id, actor_id: ana });

  openPeriod(db, p2.id, ana);
  payAll(db, g.members, p2.id);
  assert.equal(get(db, 'SELECT status FROM advances').status, 'recovered', 'target collection recovered the claim');
  drawPeriod(db, { periodId: p2.id, actor_id: ana });

  for (const p of g.periods.slice(2)) {
    openPeriod(db, p.id, ana);
    payAll(db, g.members, p.id);
    drawPeriod(db, { periodId: p.id, actor_id: ana });
  }
  assert.equal(inv1(db, gid), 0);

  const out = closeGroup(db, { groupId: gid, actor_id: ana });
  assert.equal(out.group.status, 'closed');
  assert.equal(out.periods_settled, 4);
  assert.equal(out.statements.group_net, 0, 'grant + recovery pair nets to 0 for every member');
  const bagusSt = out.statements.members.find((m) => m.member_id === bagus);
  assert.ok(bagusSt.received >= 50000, 'the defaulter statement shows the recovered advance');
  assert.equal(inv1(db, gid), 0, 'INV-1 stays 0 through closure');
  db.close();
});

test('refusals: not-drawn periods, bad ids, unrecovered advance -> 409/404/400, nothing written', () => {
  const { db, g, gid, ids } = setup({ period_count: 3 });
  const [p1] = g.periods;
  openPeriod(db, p1.id, ids[0]);
  payAll(db, g.members, p1.id);
  drawPeriod(db, { periodId: p1.id, actor_id: ids[0] });
  // two periods never opened: the membership window is still open (§5.4 step 9)
  assert.throws(
    () => closeGroup(db, { groupId: gid }),
    (e) => e.status === 409 && /not yet drawn/.test(e.message)
      && /seq 2 is open/.test(e.message) && /membership window/.test(e.message),
    '409 with a human-readable reason naming the blocking periods',
  );
  // mid-collection blocks the same way
  openPeriod(db, g.periods[1].id, ids[0]);
  assert.throws(
    () => closeGroup(db, { groupId: gid }),
    (e) => e.status === 409 && /seq 2 is collecting/.test(e.message),
  );

  // validation and lookup
  assert.throws(() => closeGroup(db, {}), (e) => e.status === 400 && /group_id/.test(e.message));
  assert.throws(() => closeGroup(db, { groupId: 'x' }), (e) => e.status === 400 && /group_id/.test(e.message));
  assert.throws(() => closeGroup(db, { groupId: 999999 }), (e) => e.status === 404 && /not found/.test(e.message));
  assert.throws(
    () => closeGroup(db, { groupId: gid, actor_id: 999999 }),
    (e) => e.status === 400 && /not a member/.test(e.message),
  );

  // finish the cycle: p2 collects now, p3 too — everything is drawn
  payAll(db, g.members, g.periods[1].id);
  drawPeriod(db, { periodId: g.periods[1].id, actor_id: ids[0] });
  openPeriod(db, g.periods[2].id, ids[0]);
  payAll(db, g.members, g.periods[2].id);
  drawPeriod(db, { periodId: g.periods[2].id, actor_id: ids[0] });

  // snapshots AFTER every legitimate write in this test, so any movement below is the refusal's
  const ledgerBefore = ledgerCount(db);
  const periodStates = states(db);

  // §5.7 case 6: an unrecovered advance refuses closure even with every period drawn
  run(
    db,
    `INSERT INTO advances (group_id, member_id, from_period, target_period, amount, status)
     VALUES (?, ?, ?, ?, 50000, 'outstanding')`,
    gid, ids[0], p1.id, g.periods[1].id,
  );
  assert.equal(inv1(db, gid), -50000, 'the open claim is visible as a balance hole');
  assert.throws(
    () => closeGroup(db, { groupId: gid }),
    (e) => e.status === 409 && /advance/.test(e.message) && /net-zero/.test(e.message),
    'closure refused (case 6), not papered over',
  );
  assert.equal(get(db, 'SELECT status FROM groups WHERE id = ?', gid).status, 'open', 'no partial close (R10)');
  assert.equal(closures(db).length, 0, 'no group_closed audit row');
  assert.equal(ledgerCount(db), ledgerBefore, 'no refusal touched the ledger');
  assert.deepEqual(states(db), periodStates, 'no refusal moved a period');

  run(db, 'DELETE FROM advances WHERE group_id = ?', gid); // test-only cleanup of the injected row
  assert.equal(inv1(db, gid), 0);
  db.close();
});

test('injected imbalance -> 422 with the exact member/period breakdown, group untouched (case 8)', () => {
  const { db, g, gid, ids } = setup();
  runCycle(db, g, ids);
  const p1 = g.periods[0];
  const anaBefore = statements(db, gid).members.find((m) => m.member_id === ids[0]).net;
  run(
    db,
    `INSERT INTO ledger (group_id, period_id, member_id, kind, amount, sign, reason)
     VALUES (?, ?, ?, 'payout', 7777, -1, 'rogue injection')`,
    gid, p1.id, ids[0],
  );
  assert.equal(inv1(db, gid), -7777, 'the injected leg breaks conservation');

  const ledgerBefore = ledgerCount(db);
  const periodStates = states(db);
  let caught = null;
  try {
    closeGroup(db, { groupId: gid, actor_id: ids[0] });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'closure refused');
  assert.equal(caught.status, 422, 'imbalance is a 422, not a silent close (§23 M7)');
  assert.match(caught.message, /net -7777 != 0/);
  assert.equal(caught.detail.net, -7777);
  assert.equal(caught.detail.inv1, -7777);
  const member = caught.detail.members.find((m) => m.member_id === ids[0]);
  assert.equal(member.net, anaBefore - 7777, 'breakdown names the member whose balance the leg moved');
  assert.equal(
    caught.detail.members.reduce((s, m) => s + m.net, 0), -7777,
    'statement nets sum to the reported balance',
  );
  assert.equal(member.paid, 150000);
  const won = get(
    db,
    "SELECT COALESCE(SUM(amount), 0) AS s FROM ledger WHERE member_id = ? AND kind = 'payout' AND reason = 'drawn payout'",
    ids[0],
  ).s;
  assert.equal(member.received, won + 7777, 'statement counts the rogue payout as received');
  const period = caught.detail.periods.find((p) => p.period_id === p1.id);
  assert.deepEqual(
    { collected: period.collected, paid_out: period.paid_out, net: period.net },
    { collected: 200000, paid_out: 207777, net: -7777 },
    'breakdown names the period and the exact delta',
  );

  assert.equal(get(db, 'SELECT status FROM groups WHERE id = ?', gid).status, 'open', 'no partial close');
  assert.deepEqual(states(db), periodStates, 'periods untouched by the refusal');
  assert.equal(ledgerCount(db), ledgerBefore, 'the refusal wrote nothing');
  assert.equal(closures(db).length, 0, 'no group_closed audit row');
  db.close();
});

test('after the close every write is refused: app 4xx, DB triggers, append-only intact', () => {
  const { db, g, gid, ids } = setup({ period_count: 2 });
  runCycle(db, g, ids);
  closeGroup(db, { groupId: gid, actor_id: ids[0] });
  const [p1] = g.periods;
  const ledgerBefore = ledgerCount(db);

  assert.throws(() => closeGroup(db, { groupId: gid }),
    (e) => e.status === 409 && /already closed/.test(e.message), 're-close -> 409 (idempotency)');
  assert.throws(() => openPeriod(db, p1.id, ids[0]),
    (e) => e.status === 409 && /illegal transition/.test(e.message), 'settled is a leaf');
  assert.throws(
    () => recordContribution(db, { periodId: p1.id, memberId: ids[0], status: 'paid' }),
    (e) => e.status === 409 && /while collecting/.test(e.message),
  );
  assert.throws(() => drawPeriod(db, { periodId: p1.id, actor_id: ids[0] }),
    (e) => e.status === 409 && /already drawn/.test(e.message));
  assert.throws(() => markDefault(db, { periodId: p1.id, memberId: ids[1] }),
    (e) => e.status === 409 && /while the period collects/.test(e.message));
  assert.throws(
    () => previewMembershipChange(db, { kind: 'join', group_id: gid, display_name: 'Eka' }),
    (e) => e.status === 409 && /frozen/.test(e.message),
    'membership window shut by the closed group',
  );

  // DB level: the final state cannot be reopened even by raw SQL (schema.sql trigger)
  assert.throws(() => run(db, "UPDATE groups SET status = 'open' WHERE id = ?", gid),
    (e) => /immutable/.test(e.message));
  // history stays append-only after closure (R12)
  assert.throws(() => run(db, 'UPDATE ledger SET amount = amount + 1 WHERE group_id = ?', gid),
    (e) => /append-only/.test(e.message));
  assert.throws(() => run(db, 'DELETE FROM draw_events WHERE period_id = ?', p1.id),
    (e) => /append-only/.test(e.message));

  assert.equal(ledgerCount(db), ledgerBefore, 'no refused write touched money');
  assert.equal(get(db, 'SELECT status FROM groups WHERE id = ?', gid).status, 'closed');
  assert.equal(inv1(db, gid), 0);
  assert.equal(statements(db, gid).group_net, 0, 'statements stay readable and balanced');
  db.close();
});
