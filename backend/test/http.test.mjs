// M8 proof: the §22 surface over a REAL socket (ephemeral port, nothing mocked) — static
// frontend serving, JSON errors with human messages and no stack traces, §5.12 auth
// (401 unauthenticated / 403 role + CSRF / 404 scoping), validation at the trust boundary,
// body limit, and the happy path from setup -> draw -> verify -> proration -> close refusal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { start } from '../src/http/server.js';

process.env.ARISAN_SECRET = 'http-integration-secret';

let app;
let gid;
let orgCookie;
let memberCookie;   // member 2, read-only
let p1;             // period 1 (drawn in the happy path)
let p2;             // period 2 (cancel path)
let winnerId;
let paidMemberIds;  // all three members paid period 1

const call = async (method, path, { body, raw, cookie, origin } = {}) => {
  const payload = raw ?? (body !== undefined ? JSON.stringify(body) : undefined);
  const res = await fetch(app.url + path, {
    method,
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(origin !== undefined ? { origin } : {}),
    },
    body: payload,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* static/HTML responses */ }
  const sc = res.headers.getSetCookie?.() ?? [];
  return { status: res.status, headers: res.headers, text, json, setCookie: sc[0] ?? null };
};

// A raw path (no WHATWG URL normalization) is the only honest way to test traversal.
const rawGet = (path) => new Promise((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port: app.port, path, method: 'GET' }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: data }));
  });
  req.on('error', reject);
  req.end();
});

before(async () => { app = await start({ port: 0, dbFile: ':memory:' }); });
after(async () => { await app.close(); });

test('static frontend: index + assets with correct content types', async () => {
  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.text, /<title>ArisanLoop/);
  assert.match(page.text, /id="alert"[^>]*role="alert"/); // errors get role=alert (a11y spec)

  const css = await call('GET', '/tokens.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  const js = await call('GET', '/js/app.mjs');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /text\/javascript/);

  for (const asset of ['/js/api.mjs', '/js/dom.mjs', '/js/verify.mjs', '/js/timeline.mjs',
    '/js/member.mjs', '/app.css']) {
    assert.equal((await call('GET', asset)).status, 200, asset);
  }
  assert.equal((await call('GET', '/js/does-not-exist.mjs')).status, 404);
});

test('directory traversal never escapes the frontend root and never leaks files', async () => {
  const probes = [
    '/../../backend/package.json',
    '/../backend/package.json',
    '/..%2f..%2fbackend%2fpackage.json',
    '/%2e%2e/%2e%2e/backend/package.json',
    '/....//backend/src/auth.js',
  ];
  for (const p of probes) {
    const res = await rawGet(p);
    assert.equal(res.status, 404, `${p} -> ${res.status}`);
    assert.match(res.type ?? '', /application\/json/, `${p} must 404 as JSON`);
    assert.ok(!res.body.includes('devDependencies'), `${p} leaked package.json`);
    assert.ok(!res.body.includes('scryptSync'), `${p} leaked auth.js`);
    assert.ok(!res.body.includes('root:x:'), `${p} leaked /etc/passwd`);
  }
});

test('unknown API paths: JSON 404, wrong method on a real path: 405', async () => {
  const nf = await call('GET', '/api/nope');
  assert.equal(nf.status, 404);
  assert.equal(nf.json.error, 'no such route');
  assert.equal(nf.json.path, '/api/nope');

  const m = await call('GET', '/api/auth/login');
  assert.equal(m.status, 405);
  assert.match(m.json.error, /method GET not allowed/);
});

test('group setup validation at the trust boundary (400 with human messages)', async () => {
  const empty = await call('POST', '/api/groups', { body: {} });
  assert.equal(empty.status, 400);
  assert.equal(typeof empty.json.error, 'string');
  assert.ok(empty.json.error.length > 10, 'message readable by a human');

  const noOrg = await call('POST', '/api/groups', {
    body: { name: 'X', amount: 10000, frequency: 'monthly', members: [{ display_name: 'A' }, { display_name: 'B' }] },
  });
  assert.equal(noOrg.status, 400);
  assert.match(noOrg.json.error, /exactly one member must be flagged/);

  const shortPass = await call('POST', '/api/groups', {
    body: {
      name: 'X', amount: 10000, frequency: 'monthly', organizer_passphrase: 'short',
      members: [{ display_name: 'A', is_organizer: 1 }, { display_name: 'B' }],
    },
  });
  assert.equal(shortPass.status, 400);
  assert.match(shortPass.json.error, /organizer_passphrase/);

  const badAmount = await call('POST', '/api/groups', {
    body: {
      name: 'X', amount: 0, frequency: 'monthly', organizer_passphrase: 'correct-horse-battery',
      members: [{ display_name: 'A', is_organizer: 1 }, { display_name: 'B' }],
    },
  });
  assert.equal(badAmount.status, 400);

  const badJson = await call('POST', '/api/groups', { raw: '{"name": "truncated"' });
  assert.equal(badJson.status, 400);
  assert.match(badJson.json.error, /not valid JSON/);

  const notObject = await call('POST', '/api/groups', { raw: '[1,2,3]' });
  assert.equal(notObject.status, 400);
  assert.match(notObject.json.error, /JSON object/);

  const big = await call('POST', '/api/groups', { raw: JSON.stringify({ pad: 'a'.repeat(70 * 1024) }) });
  assert.equal(big.status, 413);
  assert.match(big.json.error, /exceeds/);
});

test('create group 201, then login: 401 refused / 200 with cookie flags', async () => {
  const created = await call('POST', '/api/groups', {
    body: {
      name: 'Kas RT 07', amount: 50000, frequency: 'monthly', period_count: 12,
      organizer_passphrase: 'correct-horse-battery',
      members: [
        { display_name: 'Ana', is_organizer: 1 },
        { display_name: 'Bagus' },
        { display_name: 'Citra' },
      ],
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.members.length, 3);
  assert.equal(created.json.periods.length, 12);
  assert.equal(created.json.organizer_passphrase, undefined, 'a provided passphrase is never echoed');
  gid = created.json.group.id;
  p1 = created.json.periods[0].id;
  p2 = created.json.periods[1].id;

  const badLogin = await call('POST', '/api/auth/login', { body: { group_id: gid, passphrase: 'wrong-pass-123' } });
  assert.equal(badLogin.status, 401);
  assert.equal(badLogin.json.error, 'invalid group or passphrase');
  assert.equal(badLogin.setCookie, null, 'no cookie on a refused login');

  const okLogin = await call('POST', '/api/auth/login', { body: { group_id: gid, passphrase: 'correct-horse-battery' } });
  assert.equal(okLogin.status, 200);
  assert.match(okLogin.setCookie, /^arisan_session=/);
  assert.match(okLogin.setCookie, /HttpOnly/);
  assert.match(okLogin.setCookie, /SameSite=Strict/);
  orgCookie = okLogin.setCookie.split(';')[0];
});

test('authentication: 401 without/with bad session; /api/auth/me is authoritative', async () => {
  assert.equal((await call('GET', `/api/groups/${gid}`)).status, 401);
  const forged = await call('GET', `/api/groups/${gid}`, { cookie: 'arisan_session=v1.1.1.9999999999.forged' });
  assert.equal(forged.status, 401);
  assert.match(forged.json.error, /sign in/);

  const me = await call('GET', '/api/auth/me', { cookie: orgCookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.role, 'organizer');
  assert.equal(me.json.display_name, 'Ana');
});

test('CSRF: cross-origin mutation refused with 403', async () => {
  const evil = await call('POST', `/api/periods/${p1}/open`, { body: {}, cookie: orgCookie, origin: 'http://evil.test' });
  assert.equal(evil.status, 403);
  assert.match(evil.json.error, /cross-origin mutation refused/);
  // the period was NOT opened by the refused request
  const tl = await call('GET', `/api/groups/${gid}/timeline`, { cookie: orgCookie });
  assert.equal(tl.json.periods[0].status, 'open', 'refused open left the period untouched');
});

test('member tokens: read-only member gets 401 unauthenticated, 403 on writes/admin', async () => {
  const tok = await call('POST', `/api/groups/${gid}/members/2/token`, { body: {}, cookie: orgCookie });
  assert.equal(tok.status, 200);
  assert.equal(typeof tok.json.token, 'string');
  assert.equal(tok.json.expires_in, 365 * 24 * 60 * 60);

  const redeem = await call('POST', '/api/auth/token', { body: { token: tok.json.token } });
  assert.equal(redeem.status, 200);
  assert.equal(redeem.json.role, 'member');
  memberCookie = redeem.setCookie.split(';')[0];

  // overview WITHOUT statements (member scoping), audit forbidden, writes forbidden
  const overview = await call('GET', `/api/groups/${gid}`, { cookie: memberCookie });
  assert.equal(overview.status, 200);
  assert.equal(overview.json.statements, undefined);

  const audit = await call('GET', `/api/groups/${gid}/audit`, { cookie: memberCookie });
  assert.equal(audit.status, 403);
  assert.match(audit.json.error, /organizer role required/);

  const open = await call('POST', `/api/periods/${p1}/open`, { body: {}, cookie: memberCookie });
  assert.equal(open.status, 403);
  assert.match(open.json.error, /members are read-only/);

  // member cannot read a sibling's statement, and cannot probe another group's ids
  const sibling = await call('GET', `/api/members/3/statement?group=${gid}`, { cookie: memberCookie });
  assert.equal(sibling.status, 403);
  assert.match(sibling.json.error, /only their own statement/);
  const crossGroup = await call('GET', `/api/members/3/statement?group=999`, { cookie: memberCookie });
  assert.equal(crossGroup.status, 404);
  assert.match(crossGroup.json.error, /group 999 not found/);

  // own statement: 200, own rows only
  const own = await call('GET', `/api/members/2/statement?group=${gid}`, { cookie: memberCookie });
  assert.equal(own.status, 200);
  assert.equal(own.json.member.id, 2);
  assert.ok(Array.isArray(own.json.contributions));

  // organiser scoping: another group's id is a 404, not a 403 (id probe)
  const foreign = await call('GET', '/api/groups/999', { cookie: orgCookie });
  assert.equal(foreign.status, 404);
});

test('happy path: open -> collect -> ready -> draw -> verify (recomputed ok)', async () => {
  const opened = await call('POST', `/api/periods/${p1}/open`, { body: {}, cookie: orgCookie });
  assert.equal(opened.status, 200);
  assert.equal(opened.json.period.status, 'collecting');
  assert.equal(opened.json.due_created, 3);

  const early = await call('GET', `/api/periods/${p1}/draw/verify`, { cookie: orgCookie });
  assert.equal(early.status, 409);
  assert.match(early.json.error, /not been drawn yet/);

  const badStatus = await call('POST', `/api/periods/${p1}/contributions`, {
    body: { member_id: 1, status: 'bogus' }, cookie: orgCookie,
  });
  assert.equal(badStatus.status, 400);
  assert.match(badStatus.json.error, /status must be one of/);

  const badMember = await call('POST', `/api/periods/${p1}/contributions`, {
    body: { member_id: 'two', status: 'paid' }, cookie: orgCookie,
  });
  assert.equal(badMember.status, 400);
  assert.match(badMember.json.error, /member_id must be a positive integer/);

  for (const id of [1, 2, 3]) {
    const paid = await call('POST', `/api/periods/${p1}/contributions`, {
      body: { member_id: id, status: 'paid', proof_note: `transfer ${id}` }, cookie: orgCookie,
    });
    assert.equal(paid.status, 200, JSON.stringify(paid.json));
  }
  const drawn = await call('POST', `/api/periods/${p1}/draw`, { body: {}, cookie: orgCookie });
  assert.equal(drawn.status, 200);
  assert.equal(drawn.json.period.status, 'drawn');
  winnerId = drawn.json.winner_member_id;
  paidMemberIds = drawn.json.inputs;
  assert.ok(paidMemberIds.includes(winnerId));

  const again = await call('POST', `/api/periods/${p1}/draw`, { body: {}, cookie: orgCookie });
  assert.equal(again.status, 409, 'one draw per period (R2)');

  const verify = await call('GET', `/api/periods/${p1}/draw/verify`, { cookie: orgCookie });
  assert.equal(verify.status, 200);
  assert.equal(verify.json.recomputed.ok, true, 'served artifacts recompute to the served winner');
  assert.equal(verify.json.seed.length, 64);

  // a member may verify too (§5.4 step 8 is for everyone)
  const memberVerify = await call('GET', `/api/periods/${p1}/draw/verify`, { cookie: memberCookie });
  assert.equal(memberVerify.status, 200);
});

test('override: empty reason is 400, a real one writes the audit trail', async () => {
  const target = paidMemberIds.find((id) => id !== winnerId);
  const noReason = await call('POST', `/api/periods/${p1}/override`, {
    body: { recipient_id: target, reason: '   ' }, cookie: orgCookie,
  });
  assert.equal(noReason.status, 400);
  assert.match(noReason.json.error, /reason must be a non-empty string/);

  const ok = await call('POST', `/api/periods/${p1}/override`, {
    body: { recipient_id: target, reason: 'recipient hospitalised, agreed in meeting' }, cookie: orgCookie,
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));

  const audit = await call('GET', `/api/groups/${gid}/audit`, { cookie: orgCookie });
  assert.equal(audit.status, 200);
  assert.equal(audit.json.overrides.length, 1);
  assert.equal(audit.json.overrides[0].recipient_member_id, target);
  assert.equal(audit.json.draw_events.length, 1);
  assert.ok(audit.json.audit.length >= 3, 'setup/open/pay/draw actions are logged');

  const repeat = await call('POST', `/api/periods/${p1}/override`, {
    body: { recipient_id: winnerId, reason: 'second override' }, cookie: orgCookie,
  });
  assert.ok(repeat.status === 409 || repeat.status === 400 || repeat.status === 422,
    `double override must be refused, got ${repeat.status}`);
});

test('cancel: ready -> collecting (R12), then a second cancel is 409', async () => {
  await call('POST', `/api/periods/${p2}/open`, { body: {}, cookie: orgCookie });
  for (const id of [1, 2, 3]) {
    const r = await call('POST', `/api/periods/${p2}/contributions`, { body: { member_id: id, status: 'paid' }, cookie: orgCookie });
    assert.equal(r.status, 200);
  }
  const tl1 = await call('GET', `/api/groups/${gid}/timeline`, { cookie: orgCookie });
  assert.equal(tl1.json.periods[1].status, 'ready');

  const cancelled = await call('POST', `/api/periods/${p2}/cancel`, { body: {}, cookie: orgCookie });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.period.status, 'collecting');

  const again = await call('POST', `/api/periods/${p2}/cancel`, { body: {}, cookie: orgCookie });
  assert.equal(again.status, 409, 'only ready -> collecting exists in the state machine');
});

test('proration: join preview writes nothing, confirm with the exact delta applies it', async () => {
  const before = await call('GET', `/api/groups/${gid}`, { cookie: orgCookie });
  assert.equal(before.json.members.length, 3);

  const preview = await call('POST', `/api/groups/${gid}/members`, {
    body: { display_name: 'Dodi', sort_order: 4 }, cookie: orgCookie,
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(typeof preview.json.membership_change_id, 'number');
  assert.equal(typeof preview.json.preview_token, 'string');
  assert.equal(preview.json.delta.kind, 'join');

  const still = await call('GET', `/api/groups/${gid}`, { cookie: orgCookie });
  assert.equal(still.json.members.length, 3, 'R6: nothing written until confirmed');

  const confirmed = await call('POST', `/api/groups/${gid}/members`, {
    body: {
      membership_change_id: preview.json.membership_change_id,
      preview_token: preview.json.preview_token,
      delta: preview.json.delta,
    },
    cookie: orgCookie,
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));

  const after = await call('GET', `/api/groups/${gid}`, { cookie: orgCookie });
  assert.equal(after.json.members.length, 4);
  assert.ok(after.json.members.some((m) => m.display_name === 'Dodi'));

  // a tampered delta is refused, not silently applied (R6)
  const tampered = await call('POST', `/api/groups/${gid}/members`, {
    body: { display_name: 'Eve' }, cookie: orgCookie,
  });
  assert.equal(tampered.status, 200, 'preview itself still works');
  const drift = await call('POST', `/api/groups/${gid}/members`, {
    body: {
      membership_change_id: tampered.json.membership_change_id,
      preview_token: tampered.json.preview_token,
      delta: { ...tampered.json.delta, total_owed: 0 },
    },
    cookie: orgCookie,
  });
  assert.equal(drift.status, 409, 'stale/tampered delta refused');
  assert.match(drift.json.error, /preview/);
});

test('close: refused while periods are undrawn (409), message lists them', async () => {
  const close = await call('POST', `/api/groups/${gid}/close`, { body: {}, cookie: orgCookie });
  assert.equal(close.status, 409);
  assert.equal(typeof close.json.error, 'string');
  assert.match(close.json.error, /undrawn|seq /);
  assert.ok(close.json.detail?.undrawn?.length >= 1, 'detail names the undrawn periods');
});

test('no stack traces or internals ever reach the client', async () => {
  const errors = [
    await call('POST', '/api/groups', { raw: 'not json at all' }),
    await call('GET', '/api/groups/42'),
    await call('POST', '/api/auth/login', { body: { group_id: gid, passphrase: 'nope-nope-nope' } }),
    await call('POST', `/api/periods/${p1}/draw`, { body: {}, cookie: memberCookie }),
    await call('GET', '/api/definitely/not/a/route'),
  ];
  for (const e of errors) {
    assert.ok(e.status >= 400 && e.status < 500, `unexpected status ${e.status}`);
    assert.ok(!/\n\s+at /.test(e.text), `stack leaked: ${e.text.slice(0, 120)}`);
    assert.ok(!e.text.includes('.mjs:'), `file/line leaked: ${e.text.slice(0, 120)}`);
    assert.ok(!e.text.includes('node:'), `runtime internals leaked: ${e.text.slice(0, 120)}`);
    assert.equal(typeof e.json?.error, 'string', 'every error carries a human message');
  }
});
