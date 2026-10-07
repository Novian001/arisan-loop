// M3 proof: due -> partial -> paid | waived flow; only `paid` writes a ledger leg;
// period reaches `ready` only when every non-waived contribution is paid — one `partial`
// left means 409 and the period stays in `collecting`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, get, all, ValidationError } from '../src/db.js';
import { createGroup, openPeriod } from '../src/schedule.js';
import { recordContribution, assertReady, shortPayers } from '../src/ledger.js';

process.env.ARISAN_SECRET = 'contributions-test-secret';

const members = [
  { display_name: 'Ana', is_organizer: 1 },
  { display_name: 'Bagus' },
  { display_name: 'Citra' },
];

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const g = createGroup(db, { name: 'Kas 2026', amount: 50000, frequency: 'weekly', members });
  const opened = openPeriod(db, g.periods[0].id, g.members[0].id);
  return { db, g, period: opened.period };
}

function inv1(db, gid) {
  return get(db, 'SELECT balance FROM v_group_inv1 WHERE group_id = ?', gid).balance;
}

test('full due -> partial -> paid flow: ledger leg only on paid, INV-1 = 0 each step', () => {
  const { db, g } = setup();
  const gid = g.group.id;
  const m0 = g.members[0].id;
  const p1 = g.periods[0].id;

  assert.equal(shortPayers(db, p1).length, 3);
  assert.equal(inv1(db, gid), 0);

  // partial: note recorded, no money in yet, period stays collecting
  let out = recordContribution(db, { periodId: p1, memberId: m0, status: 'partial', proof_note: 'paid 25k first' });
  assert.equal(out.contribution.status, 'partial');
  assert.equal(out.period.status, 'collecting');
  assert.equal(all(db, 'SELECT * FROM ledger').length, 0, 'partial is not money in');
  assert.equal(inv1(db, gid), 0);

  // rest arrives -> paid: full due amount enters the ledger
  out = recordContribution(db, { periodId: p1, memberId: m0, status: 'paid', proof_note: 'transfer 50k' });
  assert.equal(out.contribution.status, 'paid');
  assert.ok(out.contribution.paid_at, 'paid_at timestamp set');
  const legs = all(db, 'SELECT * FROM ledger');
  assert.equal(legs.length, 1);
  assert.equal(legs[0].amount, 50000);
  assert.equal(legs[0].sign, 1);
  assert.equal(inv1(db, gid), 0, 'ledger leg cancels the parked collection (R3)');

  // remaining two paid -> auto ready
  recordContribution(db, { periodId: p1, memberId: g.members[1].id, status: 'paid' });
  assert.equal(get(db, 'SELECT status FROM periods WHERE id = ?', p1).status, 'collecting');
  out = recordContribution(db, { periodId: p1, memberId: g.members[2].id, status: 'paid' });
  assert.equal(out.period.status, 'ready', 'all paid flips collecting -> ready');
  assert.equal(inv1(db, gid), 0);

  // audit trail: one row per mutation, actor attributed
  const actions = all(db, "SELECT action FROM audit_log WHERE entity='contribution' ORDER BY id");
  assert.deepEqual(actions.map((a) => a.action),
    ['contribution_partial', 'contribution_paid', 'contribution_paid', 'contribution_paid']);
  db.close();
});

test('waived excludes the member from readiness and writes no ledger leg', () => {
  const { db, g } = setup();
  const gid = g.group.id;
  const p1 = g.periods[0].id;
  recordContribution(db, { periodId: p1, memberId: g.members[0].id, status: 'waived', proof_note: 'sick, waived by organizer' });
  recordContribution(db, { periodId: p1, memberId: g.members[1].id, status: 'paid' });
  const out = recordContribution(db, { periodId: p1, memberId: g.members[2].id, status: 'paid' });
  assert.equal(out.period.status, 'ready', 'waived rows do not block ready');
  assert.equal(all(db, 'SELECT * FROM ledger').length, 2, 'waived contributes nothing to money in');
  assert.equal(inv1(db, gid), 0);
  db.close();
});

test('one partial left -> 409 names the short-payer, period never reaches ready', () => {
  const { db, g } = setup();
  const p1 = g.periods[0].id;
  recordContribution(db, { periodId: p1, memberId: g.members[0].id, status: 'paid' });
  recordContribution(db, { periodId: p1, memberId: g.members[1].id, status: 'paid' });
  recordContribution(db, { periodId: p1, memberId: g.members[2].id, status: 'partial', proof_note: 'half' });

  assert.equal(get(db, 'SELECT status FROM periods WHERE id = ?', p1).status, 'collecting');
  assert.throws(
    () => assertReady(db, p1),
    (e) => e.status === 409
      && /Citra: partial/.test(e.message)
      && e.detail.short_payers.length === 1,
    'error must name the short-payer (organizer view)',
  );
  db.close();
});

test('contribution status machine: terminal states and wrong-phase writes are 409', () => {
  const { db, g } = setup();
  const p1 = g.periods[0].id;
  const [m0, m1] = [g.members[0].id, g.members[1].id];

  // paid is terminal: no paid -> partial rewrite of history
  recordContribution(db, { periodId: p1, memberId: m0, status: 'paid' });
  assert.throws(() => recordContribution(db, { periodId: p1, memberId: m0, status: 'partial' }),
    (e) => e.status === 409 && /paid -> partial/.test(e.message));
  assert.throws(() => recordContribution(db, { periodId: p1, memberId: m0, status: 'waived' }),
    (e) => e.status === 409 && /paid -> waived/.test(e.message));

  // partial cannot step backwards to due — 'due' is outside the recordable enum (400)
  recordContribution(db, { periodId: p1, memberId: m1, status: 'partial' });
  assert.throws(() => recordContribution(db, { periodId: p1, memberId: m1, status: 'due' }),
    (e) => e.status === 400 && /must be one of/.test(e.message));

  // once ready, the period is frozen for collection
  recordContribution(db, { periodId: p1, memberId: m1, status: 'paid' });
  recordContribution(db, { periodId: p1, memberId: g.members[2].id, status: 'paid' });
  assert.equal(get(db, 'SELECT status FROM periods WHERE id = ?', p1).status, 'ready');
  assert.throws(() => recordContribution(db, { periodId: p1, memberId: m0, status: 'paid' }),
    (e) => e.status === 409 && /only change while collecting/.test(e.message));
  db.close();
});

test('validation and not-found paths: 400 / 404, nothing written', () => {
  const { db, g } = setup();
  const p1 = g.periods[0].id;
  const m0 = g.members[0].id;
  const before = all(db, 'SELECT * FROM ledger');

  assert.throws(() => recordContribution(db, { periodId: p1, memberId: m0, status: 'due' }),
    (e) => e instanceof ValidationError && e.status === 400);
  assert.throws(() => recordContribution(db, { periodId: p1, memberId: m0, status: 'paid', proof_note: 'x'.repeat(501) }),
    (e) => e.status === 400 && /proof_note/.test(e.message));
  assert.throws(() => recordContribution(db, { periodId: 999999, memberId: m0, status: 'paid' }),
    (e) => e.status === 404);
  assert.throws(() => recordContribution(db, { periodId: p1, memberId: 999999, status: 'paid' }),
    (e) => e.status === 404);
  assert.deepEqual(all(db, 'SELECT * FROM ledger'), before, 'refused calls write nothing');
  assert.equal(inv1(db, g.group.id), 0);
  db.close();
});
