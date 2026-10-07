// M6 proof (build spec §23 M6 + §5.13 test 5 + §5.7 case 5/6 + §5.6 R4/R5):
//   markDefault records the default without moving money · path (a) advance
//   funded -> recovered (grant adjustment +a, payout -a from the target period) with INV-1 = 0
//   at every step · path (b) redistribution waives with NO ledger legs and moves the
//   defaulter after the next member · both paths audit reason + actor + timestamp · the draw
//   stays blocked until a path is chosen · every illegal transition/refusal -> 4xx with the
//   period, ledger and cases untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, get, all } from '../src/db.js';
import { createGroup, openPeriod } from '../src/schedule.js';
import { recordContribution } from '../src/ledger.js';
import { drawPeriod } from '../src/draw.js';
import { markDefault, resolveDefault } from '../src/defaults.js';

process.env.ARISAN_SECRET = 'defaults-test-secret';

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
const ledgerRows = (db) => all(db, 'SELECT * FROM ledger ORDER BY id');
const order = (db, gid) => all(
  db, 'SELECT display_name, sort_order FROM members WHERE group_id = ? ORDER BY sort_order', gid,
).map((m) => `${m.display_name}:${m.sort_order}`);
const recipients = (db, gid) => all(
  db, 'SELECT scheduled_recipient FROM periods WHERE group_id = ? ORDER BY seq', gid,
).map((p) => p.scheduled_recipient);

function pay(db, periodId, memberId) {
  return recordContribution(db, { periodId, memberId, status: 'paid', proof_note: 'transfer' });
}
function payAll(db, members, periodId) {
  for (const m of members) pay(db, periodId, m.id);
}

test('markDefault: records the default, moves no money, draw blocked until a path is chosen (case 5)', () => {
  const { db, g, gid, ids } = setup();
  const [ana, bagus] = ids;
  const p1 = g.periods[0];
  openPeriod(db, p1.id, ana);
  payAll(db, [g.members[0], g.members[2], g.members[3]], p1.id); // everyone except Bagus

  // system-driven detection: actor may be null, reason optional (R5 binds the RESOLUTION)
  const marked = markDefault(db, { periodId: p1.id, memberId: bagus, reason: 'grace 7 hari lewat' });

  assert.equal(marked.default_case.period_id, p1.id);
  assert.equal(marked.default_case.member_id, bagus);
  assert.equal(marked.default_case.resolution, null);
  assert.ok(marked.default_case.detected_at, 'detection timestamped');
  assert.equal(marked.member.status, 'defaulted');
  assert.equal(inv1(db, gid), 0, 'INV-1 unchanged: no money moved');

  // the due row itself blocks the draw — §5.7 case 5
  assert.throws(
    () => drawPeriod(db, { periodId: p1.id, actor_id: ana }),
    (e) => e.status === 409 && /Bagus/.test(e.message),
  );
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM draw_events').n, 0, 'no DrawEvent');
  assert.equal(get(db, 'SELECT status FROM periods WHERE id = ?', p1.id).status, 'collecting');

  // one open case per member+period
  assert.throws(
    () => markDefault(db, { periodId: p1.id, memberId: bagus }),
    (e) => e.status === 409 && /open default case/.test(e.message),
  );

  const aud = get(db, "SELECT * FROM audit_log WHERE action = 'member_defaulted'");
  assert.equal(aud.entity, 'default_case');
  assert.equal(aud.reason, 'grace 7 hari lewat');
  assert.ok(aud.created_at, 'audit timestamped');
  assert.equal(inv1(db, gid), 0);
  db.close();
});

test('path (a) early_payout: grant funds an advance, target collection recovers it, INV-1 = 0 per step', () => {
  const { db, g, gid, ids } = setup();
  const [ana, bagus] = ids;
  const [p1, p2] = g.periods;
  openPeriod(db, p1.id, ana);
  payAll(db, [g.members[0], g.members[2], g.members[3]], p1.id);
  markDefault(db, { periodId: p1.id, memberId: bagus, actor_id: ana });
  const beforeLedger = ledgerRows(db).length;

  const out = resolveDefault(db, {
    periodId: p1.id, memberId: bagus, path: 'early_payout',
    reason: 'tidak bayar setelah grace', actor_id: ana,
  });

  // the due row is waived — recorded, excluded from money-in, never deleted (R9)
  const c = get(db, 'SELECT * FROM contributions WHERE period_id = ? AND member_id = ?', p1.id, bagus);
  assert.equal(c.status, 'waived');
  assert.match(c.proof_note, /early_payout/);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM contributions').n, 4, 'no row deleted');

  // R4 verbatim: adjustment(+a, reason=early_payout_grant) + outstanding advance += a
  const legs = ledgerRows(db);
  assert.equal(legs.length, beforeLedger + 1, 'exactly one new ledger row');
  const grant = legs[legs.length - 1];
  assert.deepEqual(
    { kind: grant.kind, amount: grant.amount, sign: grant.sign, reason: grant.reason, ref: grant.ref },
    { kind: 'adjustment', amount: 50000, sign: 1, reason: 'early_payout_grant', ref: `default_case:${out.default_case.id}` },
  );
  assert.equal(grant.member_id, bagus);
  const adv = get(db, 'SELECT * FROM advances');
  assert.deepEqual(
    { status: adv.status, amount: adv.amount, from_period: adv.from_period, target_period: adv.target_period },
    { status: 'outstanding', amount: 50000, from_period: p1.id, target_period: p2.id },
  );
  assert.equal(inv1(db, gid), 0, 'INV-1 after the grant');

  // case resolved with reason + actor + timestamps on case AND audit
  assert.equal(out.default_case.resolution, 'early_payout');
  assert.equal(out.default_case.reason, 'tidak bayar setelah grace');
  assert.equal(out.default_case.actor_id, ana);
  assert.ok(out.default_case.resolved_at);
  for (const action of ['default_resolved', 'advance_granted']) {
    const a = get(db, 'SELECT * FROM audit_log WHERE action = ?', action);
    assert.ok(a, `${action} audited`);
    assert.equal(a.actor_id, ana, `${action} carries actor`);
    assert.ok(a.reason, `${action} carries reason`);
    assert.ok(a.created_at, `${action} carries timestamp`);
  }
  // collection complete -> period rests in `resolved` (§5.4 "+ resolved after default handling")
  assert.equal(out.period.status, 'resolved');

  // draw proceeds from `resolved` (legal predecessor of drawn), pot = paid only
  const d1 = drawPeriod(db, { periodId: p1.id, actor_id: ana });
  assert.equal(d1.pot, 150000, 'waived default is not money in (§5.5)');
  assert.equal(inv1(db, gid), 0, 'INV-1 after the draw');

  // target collects -> recovery fires on the completing payment
  openPeriod(db, p2.id, ana);
  for (const m of g.members) {
    pay(db, p2.id, m.id);
    assert.equal(inv1(db, gid), 0, 'INV-1 after each contribution');
  }
  const paid = get(db, 'SELECT * FROM periods WHERE id = ?', p2.id);
  assert.equal(paid.status, 'ready');
  const recovered = get(db, 'SELECT * FROM advances WHERE id = ?', adv.id);
  assert.equal(recovered.status, 'recovered');
  assert.ok(recovered.recovered_at, 'recovery timestamped');
  const back = ledgerRows(db).filter((l) => l.reason === 'early_default_payout');
  assert.equal(back.length, 1, 'R4: one recovery payout');
  assert.deepEqual(
    { kind: back[0].kind, amount: back[0].amount, sign: back[0].sign, ref: back[0].ref },
    { kind: 'payout', amount: 50000, sign: -1, ref: `advance:${adv.id}` },
  );
  assert.equal(back[0].member_id, bagus, 'the claim is paid to the defaulter');
  assert.equal(back[0].period_id, p2.id, 'funded from the target period');
  assert.ok(get(db, "SELECT id FROM audit_log WHERE action = 'advance_recovered'"), 'recovery audited');
  assert.equal(inv1(db, gid), 0, 'INV-1 after the recovery');
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM advances WHERE status = 'outstanding'").n, 0);

  const d2 = drawPeriod(db, { periodId: p2.id, actor_id: ana });
  assert.equal(d2.pot, 200000);
  assert.equal(inv1(db, gid), 0, 'INV-1 after both draws');
  db.close();
});

test('path (b) redistribute: waiver with no ledger legs, defaulter moved after the next member (R5)', () => {
  const { db, g, gid, ids } = setup();
  const [ana, bagus, citra] = ids;
  const p1 = g.periods[0];
  openPeriod(db, p1.id, ana);
  payAll(db, [g.members[0], g.members[2], g.members[3]], p1.id);
  markDefault(db, { periodId: p1.id, memberId: bagus, actor_id: ana });

  const beforeLedger = ledgerRows(db).length;
  const beforeRecipients = recipients(db, gid);
  assert.deepEqual(beforeRecipients, [ana, bagus, citra, ids[3], ana], 'original rotation');

  const out = resolveDefault(db, {
    periodId: p1.id, memberId: bagus, path: 'redistribute',
    reason: 'keputusan pengurus', actor_id: ana,
  });

  const c = get(db, 'SELECT * FROM contributions WHERE period_id = ? AND member_id = ?', p1.id, bagus);
  assert.equal(c.status, 'waived');
  assert.equal(ledgerRows(db).length, beforeLedger, 'R5: no ledger legs on path (b)');
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM advances').n, 0, 'no advance');
  assert.equal(inv1(db, gid), 0, 'INV-1 after the waiver');

  // rotation recomputed: defaulter down one slot, next member takes theirs
  assert.deepEqual(order(db, gid), ['Ana:0', 'Citra:1', 'Bagus:2', 'Dewi:3']);
  assert.ok(out.default_case.resolution === 'redistribute');
  assert.equal(out.default_case.actor_id, ana);
  assert.ok(out.default_case.resolved_at);
  const a = get(db, "SELECT * FROM audit_log WHERE action = 'default_resolved'");
  assert.equal(a.actor_id, ana);
  assert.equal(a.reason, 'keputusan pengurus');
  assert.ok(a.created_at);
  assert.deepEqual(
    JSON.parse(a.payload_json).path, 'redistribute',
    'audit payload records the path',
  );
  assert.deepEqual(recipients(db, gid), [ana, citra, bagus, ids[3], ana], 'undrawn schedule recomputed');
  assert.equal(out.period.status, 'resolved');

  const d1 = drawPeriod(db, { periodId: p1.id, actor_id: ana });
  assert.equal(d1.pot, 150000);
  assert.equal(inv1(db, gid), 0);
  db.close();
});

test('resolve while others still owe: period resumes collecting, last payment completes it', () => {
  const { db, g, gid, ids } = setup();
  const [ana, bagus, , dewi] = ids;
  const p1 = g.periods[0];
  openPeriod(db, p1.id, ana);
  pay(db, p1.id, ana);
  pay(db, p1.id, ids[2]); // Citra paid, Bagus + Dewi owe
  markDefault(db, { periodId: p1.id, memberId: bagus, actor_id: ana });

  const out = resolveDefault(db, {
    periodId: p1.id, memberId: bagus, path: 'redistribute', reason: 'grace habis', actor_id: ana,
  });
  assert.equal(out.period.status, 'collecting', 'others still owe: collection resumes');
  assert.equal(inv1(db, gid), 0);

  pay(db, p1.id, dewi);
  assert.equal(get(db, 'SELECT status FROM periods WHERE id = ?', p1.id).status, 'ready');
  assert.equal(inv1(db, gid), 0, 'INV-1 after the completing payment');
  drawPeriod(db, { periodId: p1.id, actor_id: ana });
  assert.equal(inv1(db, gid), 0);
  db.close();
});

test('path (a) when the target already collected: recovery lands immediately', () => {
  const { db, g, gid, ids } = setup();
  const [ana, bagus] = ids;
  const [p1, p2] = g.periods;
  openPeriod(db, p1.id, ana);
  payAll(db, [g.members[0], g.members[2], g.members[3]], p1.id);
  markDefault(db, { periodId: p1.id, memberId: bagus, actor_id: ana });

  openPeriod(db, p2.id, ana);
  payAll(db, g.members, p2.id);
  assert.equal(get(db, 'SELECT status FROM periods WHERE id = ?', p2.id).status, 'ready');
  assert.equal(inv1(db, gid), 0);

  const out = resolveDefault(db, {
    periodId: p1.id, memberId: bagus, path: 'early_payout', reason: 'target sudah terkumpul', actor_id: ana,
  });
  const adv = get(db, 'SELECT * FROM advances WHERE id = ?', out.advance_id);
  assert.equal(adv.status, 'recovered', 'target was already collected -> recovered in the same tx');
  assert.ok(adv.recovered_at);
  assert.equal(
    get(db, "SELECT COUNT(*) AS n FROM ledger WHERE reason = 'early_default_payout'").n, 1,
  );
  assert.equal(inv1(db, gid), 0, 'INV-1 after immediate recovery');

  drawPeriod(db, { periodId: p1.id, actor_id: ana });
  drawPeriod(db, { periodId: p2.id, actor_id: ana });
  assert.equal(inv1(db, gid), 0, 'INV-1 after both draws');
  db.close();
});

test('refusals: illegal paths, missing actor/reason, wrong state -> 4xx, nothing written', () => {
  const { db, g, gid, ids } = setup();
  const [ana, bagus, citra, dewi] = ids;
  const p1 = g.periods[0];
  openPeriod(db, p1.id, ana);
  pay(db, p1.id, ana);
  pay(db, p1.id, citra); // Bagus + Dewi owe

  // preconditions and validation
  assert.throws(
    () => markDefault(db, { periodId: p1.id, memberId: citra }),
    (e) => e.status === 409 && /nothing to default/.test(e.message),
    'paid member cannot default',
  );
  assert.throws(
    () => markDefault(db, { periodId: p1.id, memberId: 999999 }),
    (e) => e.status === 404 && /not found/.test(e.message),
  );
  const p2 = g.periods[1]; // still `open` — no rows, no collection
  assert.throws(
    () => markDefault(db, { periodId: p2.id, memberId: dewi }),
    (e) => e.status === 409 && /while the period collects/.test(e.message),
  );

  markDefault(db, { periodId: p1.id, memberId: bagus, actor_id: ana });
  markDefault(db, { periodId: p1.id, memberId: dewi, actor_id: ana }); // two open cases
  const snapshot = ledgerRows(db).length;
  const cases = get(db, 'SELECT COUNT(*) AS n FROM default_cases').n;

  assert.throws(
    () => resolveDefault(db, { periodId: p1.id, path: 'steal', reason: 'x', actor_id: ana }),
    (e) => e.status === 400 && /path must be one of/.test(e.message),
  );
  assert.throws(
    () => resolveDefault(db, { periodId: p1.id, path: 'redistribute', reason: '   ', actor_id: ana }),
    (e) => e.status === 400 && /reason/.test(e.message),
    'reason is required on both paths (R5)',
  );
  assert.throws(
    () => resolveDefault(db, { periodId: p1.id, path: 'redistribute', reason: 'ok' }),
    (e) => e.status === 400 && /actor_id is required/.test(e.message),
    'actor is required on both paths (R5)',
  );
  assert.throws(
    () => resolveDefault(db, { periodId: 999999, path: 'redistribute', reason: 'ok', actor_id: ana }),
    (e) => e.status === 404 && /not found/.test(e.message),
  );
  assert.throws(
    () => resolveDefault(db, { periodId: p1.id, path: 'redistribute', reason: 'ok', actor_id: ana }),
    (e) => e.status === 400 && /member_id to choose/.test(e.message),
    'two open cases: caller must pick one',
  );
  assert.throws(
    () => resolveDefault(db, { periodId: p1.id, memberId: citra, path: 'redistribute', reason: 'ok', actor_id: ana }),
    (e) => e.status === 409 && /no open default case/.test(e.message),
  );
  assert.equal(ledgerRows(db).length, snapshot, 'no ledger row from any refusal');
  assert.equal(inv1(db, gid), 0);

  // resolve one, then every repeat path refuses
  resolveDefault(db, { periodId: p1.id, memberId: bagus, path: 'redistribute', reason: 'ok', actor_id: ana });
  const afterFirst = ledgerRows(db).length;
  assert.throws(
    () => resolveDefault(db, { periodId: p1.id, memberId: bagus, path: 'redistribute', reason: 'ok', actor_id: ana }),
    (e) => e.status === 409 && /no open default case/.test(e.message),
    'already resolved',
  );
  assert.equal(ledgerRows(db).length, afterFirst, 'second resolve wrote nothing');
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM default_cases').n, cases, 'no duplicate case row');
  assert.equal(inv1(db, gid), 0);

  // resolution against a drawn period refuses before anything else
  resolveDefault(db, { periodId: p1.id, memberId: dewi, path: 'redistribute', reason: 'ok', actor_id: ana });
  drawPeriod(db, { periodId: p1.id, actor_id: ana });
  assert.throws(
    () => resolveDefault(db, { periodId: p1.id, path: 'redistribute', reason: 'ok', actor_id: ana }),
    (e) => e.status === 409 && /already drawn/.test(e.message),
  );
  assert.throws(
    () => markDefault(db, { periodId: p1.id, memberId: citra }),
    (e) => e.status === 409 && /while the period collects/.test(e.message),
    'a drawn period accepts no new default',
  );
  assert.equal(inv1(db, gid), 0);
  db.close();
});

test('path (a) on the last period: 409, target period needed', () => {
  const { db, g, gid, ids } = setup({ period_count: 1 });
  const [ana, bagus] = ids;
  const p1 = g.periods[0];
  openPeriod(db, p1.id, ana);
  payAll(db, [g.members[0], g.members[2], g.members[3]], p1.id);
  markDefault(db, { periodId: p1.id, memberId: bagus, actor_id: ana });
  const snapshot = ledgerRows(db).length;

  assert.throws(
    () => resolveDefault(db, {
      periodId: p1.id, memberId: bagus, path: 'early_payout', reason: 'ada yang telat', actor_id: ana,
    }),
    (e) => e.status === 409 && /target period/.test(e.message),
  );
  assert.equal(ledgerRows(db).length, snapshot, 'refusal left the ledger untouched');
  assert.equal(get(db, 'SELECT resolution FROM default_cases WHERE period_id = ?', p1.id).resolution, null);
  assert.equal(inv1(db, gid), 0);
  db.close();
});
