// M4 proof: DrawEvent written with {seed, algo, ordered inputs}; determinism (same
// secret+group+seq+inputs → same seed, same winner, across separate DB opens); verify()
// reproduces the winner from public artifacts alone; exactly one draw per period —
// concurrent/second attempts get 409; INV-1 stays 0 after the payout leg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, get, all, ValidationError } from '../src/db.js';
import { createGroup, openPeriod } from '../src/schedule.js';
import { recordContribution } from '../src/ledger.js';
import { drawPeriod, verify, deriveSeed, sampleIndex, ALGO } from '../src/draw.js';

process.env.ARISAN_SECRET = 'draw-test-secret';

const members = [
  { display_name: 'Ana', is_organizer: 1 },
  { display_name: 'Bagus' },
  { display_name: 'Citra' },
];

function setup(mode = 'ready') {
  const db = openDb(':memory:');
  migrate(db);
  const g = createGroup(db, { name: 'Kas 2026', amount: 50000, frequency: 'weekly', members });
  if (mode === 'open') return { db, g, period: g.periods[0] }; // period row exists, collection never opened
  const period = openPeriod(db, g.periods[0].id, g.members[0].id).period;
  if (mode === 'ready') {
    for (const m of g.members) {
      recordContribution(db, { periodId: period.id, memberId: m.id, status: 'paid' });
    }
  }
  return { db, g, period };
}

function inv1(db, gid) {
  return get(db, 'SELECT balance FROM v_group_inv1 WHERE group_id = ?', gid).balance;
}

const artifacts = (db, periodId) => {
  const row = get(db, 'SELECT * FROM draw_events WHERE period_id = ?', periodId);
  return { ...row, inputs: JSON.parse(row.inputs_json) };
};

test('draw writes DrawEvent + payout leg, period drawn, INV-1 still 0', () => {
  const { db, g, period } = setup();
  const gid = g.group.id;
  const organizer = g.members[0].id;

  const versionBefore = get(db, 'SELECT version FROM periods WHERE id = ?', period.id).version;
  const out = drawPeriod(db, { periodId: period.id, actor_id: organizer });

  const de = get(db, 'SELECT * FROM draw_events WHERE period_id = ?', period.id);
  assert.equal(de.algo, ALGO);
  assert.ok(/^[0-9a-f]{64}$/.test(de.seed), 'seed is a sha256 hex string');
  assert.ok(de.drawn_at, 'drawn_at timestamp persisted');
  assert.equal(de.actor_id, organizer, 'actor attributed');
  assert.deepEqual(JSON.parse(de.inputs_json), g.members.map((m) => m.id),
    'inputs = ordered member ids (rotation order)');

  // seed is a pure function of secret + group + seq (raw secret never stored)
  assert.equal(de.seed, deriveSeed('draw-test-secret', gid, period.seq));
  assert.ok(!JSON.stringify(de).includes('draw-test-secret'), 'raw secret never persisted');

  // winner derived by the spec scheme, drawn_recipient + version bumped once
  const inputs = JSON.parse(de.inputs_json);
  assert.equal(out.winner_member_id, inputs[sampleIndex(ALGO, de.seed, inputs)]);
  assert.equal(out.period.status, 'drawn');
  assert.equal(out.period.drawn_recipient, out.winner_member_id);
  assert.equal(out.period.version, versionBefore + 1, 'draw bumps the optimistic version once (R8)');

  // payout leg = the pot (3 × 50000), sign −1, append-only ref draw:<id>
  const legs = all(db, "SELECT * FROM ledger WHERE kind = 'payout'");
  assert.equal(legs.length, 1);
  assert.equal(legs[0].amount, 150000);
  assert.equal(legs[0].sign, -1);
  assert.equal(legs[0].member_id, out.winner_member_id);
  assert.equal(legs[0].ref, `draw:${de.id}`);

  assert.equal(inv1(db, gid), 0, 'INV-1 holds through the draw (R3)');
  assert.equal(
    get(db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'draw'").n, 1,
    'draw audited with actor',
  );
  db.close();
});

test('determinism: same secret + group + seq + inputs → same seed and winner across separate DB opens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arisan-draw-'));
  let fileNo = 0;
  const run1 = () => {
    const db = openDb(join(dir, `arisan-${++fileNo}.db`));
    migrate(db);
    const g = createGroup(db, { name: 'Kas 2026', amount: 50000, frequency: 'weekly', members });
    const period = openPeriod(db, g.periods[0].id, g.members[0].id).period;
    for (const m of g.members) {
      recordContribution(db, { periodId: period.id, memberId: m.id, status: 'paid' });
    }
    const out = drawPeriod(db, { periodId: period.id });
    const de = artifacts(db, period.id);
    db.close();
    return { seq: period.seq, groupId: g.group.id, de, winner: out.winner_member_id };
  };

  const first = run1();
  // close + reopen the same file: stored artifacts alone reproduce the winner
  const reopened = openDb(join(dir, 'arisan-1.db'));
  migrate(reopened);
  const v = verify({
    seed: first.de.seed, algo: first.de.algo, inputs: first.de.inputs,
    drawn_recipient: get(reopened, 'SELECT drawn_recipient FROM periods WHERE seq = ?', first.seq).drawn_recipient,
  });
  assert.equal(v.ok, true, 'verify() reproduces the winner after a fresh DB open');
  assert.equal(v.member_id, first.winner);
  // derivation itself is reproducible: same secret+group+seq → byte-identical seed
  assert.equal(first.de.seed, deriveSeed('draw-test-secret', first.groupId, first.seq));
  reopened.close();

  // a second, independent DB with the same logical coordinates draws the same winner
  const second = run1();
  assert.equal(second.de.seed, first.de.seed, 'seed depends only on secret + group + seq');
  assert.deepEqual(second.de.inputs, first.de.inputs);
  assert.equal(second.winner, first.winner, 'same inputs → same winner forever (R1)');

  // same seed + inputs re-sampled 100× never moves
  for (let i = 0; i < 100; i++) {
    assert.equal(sampleIndex(ALGO, first.de.seed, first.de.inputs),
      sampleIndex(ALGO, first.de.seed, first.de.inputs));
  }
  rmSync(dir, { recursive: true, force: true });
});

test('verify(): recomputes winner from public artifacts; tamper or bad input fails loudly', () => {
  const { db, period } = setup();
  const out = drawPeriod(db, { periodId: period.id });
  const de = artifacts(db, period.id);

  const good = verify({ seed: de.seed, algo: de.algo, inputs: de.inputs, drawn_recipient: out.period.drawn_recipient });
  assert.equal(good.ok, true);
  assert.equal(good.member_id, out.period.drawn_recipient);

  // tampered inputs (winner removed) no longer reproduce the stored recipient
  const tampered = de.inputs.filter((id) => id !== out.period.drawn_recipient);
  const bad1 = verify({ seed: de.seed, algo: de.algo, inputs: tampered, drawn_recipient: out.period.drawn_recipient });
  assert.equal(bad1.ok, false, 'verify must detect doctored inputs');

  assert.throws(() => verify({ seed: 'nope', algo: de.algo, inputs: de.inputs }),
    (e) => e instanceof ValidationError && e.status === 400 && /seed/.test(e.message));
  assert.throws(() => verify({ seed: de.seed, algo: 'v2-evil', inputs: de.inputs }),
    (e) => e.status === 422 && /unsupported algo/.test(e.message));
  assert.throws(() => verify({ seed: de.seed, algo: de.algo, inputs: [] }),
    (e) => e.status === 400 && /inputs/.test(e.message));
  db.close();
});

test('R2 precondition: one partial left → 409 names the short-payer, nothing written', () => {
  const { db, g, period } = setup('collecting');
  recordContribution(db, { periodId: period.id, memberId: g.members[0].id, status: 'paid' });
  recordContribution(db, { periodId: period.id, memberId: g.members[1].id, status: 'paid' });
  recordContribution(db, { periodId: period.id, memberId: g.members[2].id, status: 'partial', proof_note: 'half' });
  const before = { ledger: all(db, 'SELECT * FROM ledger').length, inv: inv1(db, g.group.id) };

  assert.throws(
    () => drawPeriod(db, { periodId: period.id }),
    (e) => e.status === 409 && /Citra: partial/.test(e.message) && e.detail.short_payers.length === 1,
    'draw re-checks readiness inside the transaction and names the short-payer',
  );
  assert.equal(get(db, 'SELECT status FROM periods WHERE id = ?', period.id).status, 'collecting');
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM draw_events').n, 0);
  assert.equal(all(db, 'SELECT * FROM ledger').length, before.ledger, 'refused draw writes no legs');
  assert.equal(inv1(db, g.group.id), before.inv);
  db.close();
});

test('concurrency: two draws race → exactly one DrawEvent, loser gets 409', async () => {
  // (a) same connection, two overlapping requests (Promise microtasks, no await inside draw)
  const a = setup();
  const r1 = await Promise.allSettled([
    Promise.resolve().then(() => drawPeriod(a.db, { periodId: a.period.id, actor_id: a.g.members[0].id })),
    Promise.resolve().then(() => drawPeriod(a.db, { periodId: a.period.id, actor_id: a.g.members[1].id })),
  ]);
  assert.equal(r1.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one draw wins');
  const loser = r1.find((r) => r.status === 'rejected');
  assert.equal(loser.reason.status, 409, 'race loser is 409');
  assert.match(loser.reason.message, /already drawn/);
  assert.equal(get(a.db, 'SELECT COUNT(*) AS n FROM draw_events').n, 1, 'one DrawEvent only');
  assert.equal(all(a.db, "SELECT * FROM ledger WHERE kind = 'payout'").length, 1, 'no double pay');
  assert.equal(inv1(a.db, a.g.group.id), 0);
  a.db.close();

  // (b) two independent connections on one file DB — real lock serialisation (BEGIN IMMEDIATE)
  const dir = mkdtempSync(join(tmpdir(), 'arisan-race-'));
  const file = join(dir, 'arisan.db');
  const c1 = openDb(file);
  migrate(c1);
  const g = createGroup(c1, { name: 'Kas 2026', amount: 50000, frequency: 'weekly', members });
  const period = openPeriod(c1, g.periods[0].id, g.members[0].id).period;
  for (const m of g.members) recordContribution(c1, { periodId: period.id, memberId: m.id, status: 'paid' });
  const c2 = openDb(file);
  migrate(c2);

  const r2 = await Promise.allSettled([
    Promise.resolve().then(() => drawPeriod(c1, { periodId: period.id })),
    Promise.resolve().then(() => drawPeriod(c2, { periodId: period.id })),
  ]);
  assert.equal(r2.filter((r) => r.status === 'fulfilled').length, 1, 'cross-connection race: one draw');
  assert.equal(r2.find((r) => r.status === 'rejected').reason.status, 409);
  assert.equal(get(c1, 'SELECT COUNT(*) AS n FROM draw_events').n, 1);
  c1.close();
  c2.close();
  rmSync(dir, { recursive: true, force: true });
});

test('illegal draws: wrong state → 409, unknown period → 404, refused calls write nothing', () => {
  // period never opened: status 'open', nothing outstanding — pure state refusal
  const { db, g, period } = setup('open');
  const before = all(db, 'SELECT * FROM draw_events');

  assert.throws(() => drawPeriod(db, { periodId: period.id }),
    (e) => e.status === 409 && /requires period status 'ready'/.test(e.message) && e.detail.status === 'open');
  assert.throws(() => drawPeriod(db, { periodId: 999999 }), (e) => e.status === 404 && /not found/.test(e.message));
  assert.throws(() => drawPeriod(db, { periodId: 'nope' }), (e) => e.status === 400);
  assert.deepEqual(all(db, 'SELECT * FROM draw_events'), before, 'refused draws write nothing');

  // duplicate draw after success → 409 naming the existing event
  openPeriod(db, period.id, g.members[0].id);
  for (const m of g.members) {
    recordContribution(db, { periodId: period.id, memberId: m.id, status: 'paid' });
  }
  drawPeriod(db, { periodId: period.id });
  assert.throws(() => drawPeriod(db, { periodId: period.id }),
    (e) => e.status === 409 && /already drawn/.test(e.message));
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM draw_events').n, 1);
  assert.equal(all(db, "SELECT * FROM ledger WHERE kind = 'payout'").length, 1, 'still one payout leg');
  assert.equal(inv1(db, g.group.id), 0);
  db.close();
});
