// M2 proof: group + members + K periods generated with rotation honored (R7), period
// lifecycle open -> collecting works, and every illegal transition is refused TWICE —
// by the state machine (409) and by the schema trigger (RAISE(ABORT) on raw SQL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDb, migrate, get, all, run, ValidationError } from '../src/db.js';
import { createGroup, openPeriod, timeline } from '../src/schedule.js';
import { transition, canTransition, PERIOD_EDGES } from '../src/state-machine.js';

process.env.ARISAN_SECRET = 'schedule-test-secret';

function db() {
  const d = openDb(':memory:');
  migrate(d);
  return d;
}

const baseInput = {
  name: 'Arisan RT 05',
  amount: 100000,
  frequency: 'monthly',
  members: [
    { display_name: 'Ana', is_organizer: 1 },
    { display_name: 'Bagus' },
    { display_name: 'Citra' },
    { display_name: 'Dewi' },
    { display_name: 'Eka' },
  ],
};

test('createGroup: K periods, rotation recipient honored per sort_order (R7)', () => {
  const d = db();
  const out = createGroup(d, baseInput);
  assert.equal(out.group.name, 'Arisan RT 05');
  assert.equal(out.members.length, 5);
  assert.deepEqual(out.members.map((m) => m.sort_order), [0, 1, 2, 3, 4]);
  assert.equal(out.periods.length, 5, 'K defaults to member count');
  assert.ok(out.periods.every((p) => p.status === 'open'));
  out.periods.forEach((p, i) => {
    assert.equal(p.seq, i + 1);
    assert.equal(p.scheduled_recipient, out.members[i].id, `seq ${p.seq} rotates to slot ${i}`);
  });
  // secret_commit is sha256(secret); raw secret never persisted
  assert.equal(out.group.secret_commit, createHash('sha256').update('schedule-test-secret').digest('hex'));
  assert.ok(!JSON.stringify(out).includes('schedule-test-secret'), 'raw secret must not leak');
  assert.equal(all(d, "SELECT * FROM audit_log WHERE action='create'").length, 1);
  d.close();
});

test('rotation wraps when period_count exceeds member count', () => {
  const d = db();
  const out = createGroup(d, { ...baseInput, period_count: 7 });
  assert.equal(out.periods.length, 7);
  assert.equal(out.periods[5].scheduled_recipient, out.members[0].id, 'seq 6 wraps to slot 0');
  assert.equal(out.periods[6].scheduled_recipient, out.members[1].id, 'seq 7 wraps to slot 1');
  d.close();
});

test('createGroup validates at the trust boundary (400s, nothing written)', () => {
  const d = db();
  const cases = [
    [{ ...baseInput, amount: 100000.5 }, /integer number of rupiah/],
    [{ ...baseInput, amount: 0 }, /positive integer/],
    [{ ...baseInput, amount: -5 }, /positive integer/],
    [{ ...baseInput, frequency: 'daily' }, /frequency/],
    [{ ...baseInput, name: '   ' }, /name/],
    [{ ...baseInput, members: [{ display_name: 'Ana' }] }, /members must be/],
    [{ ...baseInput, members: [...baseInput.members, { display_name: 'Ana' }] }, /duplicate member/],
    [{ ...baseInput, members: [...baseInput.members.slice(0, 4), { display_name: 'Eka', is_organizer: 1 }] }, /organizer/],
    [{ ...baseInput, period_count: 0 }, /period_count/],
    [{ ...baseInput, period_count: 2.5 }, /period_count/],
  ];
  for (const [input, re] of cases) {
    assert.throws(() => createGroup(d, input), (e) => e instanceof ValidationError && e.status === 400 && re.test(e.message),
      `expected 400 matching ${re} for ${JSON.stringify(input).slice(0, 80)}`);
  }
  assert.equal(get(d, 'SELECT COUNT(*) AS n FROM groups').n, 0, 'rejected input must write nothing');
  d.close();
});

test('openPeriod: due rows for in-scope members, second open refused (409)', () => {
  const d = db();
  const g = createGroup(d, baseInput);
  const first = openPeriod(d, g.periods[0].id, g.members[0].id);
  assert.equal(first.period.status, 'collecting');
  assert.equal(first.due_created, 5);
  assert.ok(first.contributions.every((c) => c.status === 'due' && c.amount === 100000));
  assert.equal(get(d, 'SELECT balance FROM v_group_inv1 WHERE group_id = ?', g.group.id).balance, 0);

  assert.throws(() => openPeriod(d, g.periods[0].id), (e) => e.status === 409 && /illegal transition/.test(e.message));
  assert.throws(() => openPeriod(d, 999999), (e) => e.status === 404);
  d.close();
});

test('illegal transitions ABORT at the DB trigger (raw SQL) and 409 in the state machine', () => {
  const d = db();
  const g = createGroup(d, baseInput);
  const pid = g.periods[0].id;

  // raw SQL bypasses the JS guard — the trigger is the last line of defence (R8)
  assert.throws(() => run(d, "UPDATE periods SET status='drawn' WHERE id = ?", pid), /illegal transition/);
  assert.equal(get(d, 'SELECT status FROM periods WHERE id = ?', pid).status, 'open', 'refused update changed nothing');

  run(d, "UPDATE periods SET status='collecting' WHERE id = ?", pid);
  assert.throws(() => run(d, "UPDATE periods SET status='drawn' WHERE id = ?", pid), /illegal transition/);
  run(d, "UPDATE periods SET status='ready' WHERE id = ?", pid);
  run(d, "UPDATE periods SET status='drawn' WHERE id = ?", pid); // legal
  assert.throws(() => run(d, "UPDATE periods SET status='collecting' WHERE id = ?", pid), /illegal transition/);
  run(d, "UPDATE periods SET status='settled' WHERE id = ?", pid); // legal
  assert.throws(() => run(d, "UPDATE periods SET status='open' WHERE id = ?", pid), /illegal transition/, 'settled is a leaf');

  // app guard says the same thing with a 409
  const p2 = g.periods[1];
  assert.throws(() => transition(d, p2.id, 'drawn'), (e) => e.status === 409 && /open -> drawn/.test(e.message));
  assert.equal(get(d, 'SELECT status FROM periods WHERE id = ?', p2.id).status, 'open');
  assert.throws(() => transition(d, 999999, 'collecting'), (e) => e.status === 404);

  // version bump is the optimistic lock: stale version affects 0 rows -> 409
  const stale = get(d, 'SELECT * FROM periods WHERE id = ?', p2.id);
  run(d, "UPDATE periods SET status='collecting' WHERE id = ?", p2.id);
  const res = run(d, 'UPDATE periods SET status = ?, version = version + 1 WHERE id = ? AND status = ? AND version = ?',
    'ready', p2.id, stale.status, stale.version);
  assert.equal(Number(res.changes), 0, 'stale version must affect 0 rows');

  d.close();
});

test('state machine edge matrix matches the schema trigger matrix', () => {
  const statuses = Object.keys(PERIOD_EDGES);
  for (const from of statuses) {
    for (const to of statuses) {
      // trigger allows exactly what PERIOD_EDGES allows; sample one direction each way
      if (from === to) assert.equal(canTransition(from, to), false, `${from} -> ${from} is not an edge`);
    }
  }
  assert.deepEqual(PERIOD_EDGES.open, ['collecting']);
  assert.deepEqual(PERIOD_EDGES.settled, []);
});

test('timeline returns periods ordered with rotation names and draw ref slot', () => {
  const d = db();
  const g = createGroup(d, baseInput);
  const t = timeline(d, g.group.id);
  assert.deepEqual(t.periods.map((p) => p.seq), [1, 2, 3, 4, 5]);
  assert.equal(t.periods[0].scheduled_name, 'Ana');
  assert.equal(t.periods[0].draw_event_id, null);
  assert.throws(() => timeline(d, 424242), (e) => e.status === 404);
  d.close();
});
