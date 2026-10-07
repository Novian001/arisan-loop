// routes.js — §22 API surface: a hand-written [method, regex, auth, handler] table (rung 4
// of the ladder: ~20 paths, zero deps). Thin by contract: this module parses and validates
// at the trust boundary, enforces §5.12 RBAC, calls ONE domain function and maps thrown
// ValidationErrors to 4xx — it never writes to the DB itself, which is what makes the 4xx
// tests meaningful. 500s are logged server-side and never leak a stack to the client.
import {
  bad, notFound, ValidationError, get, all, tx,
} from '../db.js';
import {
  SESSION_COOKIE, MEMBER_TOKEN_TTL, parseCookies, sessionFromCookie, sessionCookie,
  loginOrganizer, redeemToken, issueSession, validatePassphrase, generatePassphrase,
  setOrganizerPassphrase, unauthorized, forbidden,
} from '../auth.js';
import * as schedule from '../schedule.js';
import { recordContribution } from '../ledger.js';
import { verify, drawPeriod } from '../draw.js';
import * as proration from '../proration.js';
import * as defaultRules from '../defaults.js';
import { closeGroup, statements } from '../closure.js';
import { overrideRecipient } from '../override.js';

// Body limit: a group setup with 30 members is kilobytes; an unbounded read is how a demo
// backend gets OOM-killed on a 2 GB box (§5.12 validation at the trust boundary).
const MAX_BODY = 64 * 1024;
const REASON_MAX = 500;

/** Handlers return a plain body (200) or a Reply to set status/headers (201, Set-Cookie). */
class Reply {
  constructor(body, { status = 200, headers = {} } = {}) {
    this.body = body;
    this.status = status;
    this.headers = headers;
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new ValidationError(`request body exceeds ${MAX_BODY} bytes`, 413, { max: MAX_BODY });
    chunks.push(c);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw bad('body is not valid JSON'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad('body must be a JSON object');
  return parsed;
}

// §5.12 CSRF: SameSite=Strict already refuses cross-site cookies; this refuses a mutation
// whose Origin (or Sec-Fetch-Site) says another page drove it — stdlib header checks only.
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { throw forbidden('malformed Origin header'); }
    if (host !== req.headers.host) throw forbidden(`cross-origin mutation refused (Origin ${origin})`);
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    throw forbidden(`cross-site mutation refused (Sec-Fetch-Site: ${site})`);
  }
}

// ---------------------------------------------------------------- scoping helpers
// Anything outside the session's group is answered 404, not 403: an id probe must not
// confirm another group's resources exist (§5.13 test 7).
function checkGroup(session, gidRaw) {
  const gid = Number(gidRaw);
  if (!Number.isInteger(gid) || gid < 1 || gid !== session.group_id) throw notFound(`group ${gidRaw} not found`);
  return gid;
}

function loadPeriod(db, pidRaw, session) {
  const pid = Number(pidRaw);
  const p = Number.isInteger(pid) && pid > 0 ? get(db, 'SELECT * FROM periods WHERE id = ?', pid) : null;
  if (!p || p.group_id !== session.group_id) throw notFound(`period ${pidRaw} not found`);
  return p;
}

function bodyInt(value, field) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw bad(`${field} must be a positive integer`);
  }
  return value;
}

function reasonOrThrow(value) {
  const why = typeof value === 'string' ? value.trim() : '';
  if (why.length === 0) throw bad('reason must be a non-empty string');
  if (why.length > REASON_MAX) throw bad(`reason must be at most ${REASON_MAX} characters`);
  return why;
}

// ---------------------------------------------------------------- read views (no writes)
function balanceStrip(db, gid) {
  const sums = get(db, `SELECT
      COALESCE(SUM(CASE WHEN sign = 1 THEN amount END), 0) AS collected,
      COALESCE(SUM(CASE WHEN sign = -1 THEN amount END), 0) AS paid_out
    FROM ledger WHERE group_id = ?`, gid);
  const adv = get(db, `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount
    FROM advances WHERE group_id = ? AND status = 'outstanding'`, gid);
  const parked = get(db, `SELECT COALESCE(SUM(c.amount), 0) AS amount
    FROM contributions c JOIN periods p ON p.id = c.period_id
    WHERE p.group_id = ? AND c.status = 'paid' AND p.status NOT IN ('drawn','settled')`, gid);
  const inv1 = get(db, 'SELECT balance FROM v_group_inv1 WHERE group_id = ?', gid).balance;
  return {
    collected: sums.collected,
    paid_out: sums.paid_out,
    parked_collected: parked.amount,
    outstanding_advances: adv.n,
    outstanding_amount: adv.amount,
    inv1,
    invariant_ok: inv1 === 0, // the pinned strip's "invariant OK" badge
  };
}

function overview(db, gid) {
  const group = get(db, 'SELECT * FROM groups WHERE id = ?', gid);
  const members = all(
    db,
    `SELECT id, display_name, sort_order, status, is_organizer, joined_seq, left_seq
     FROM members WHERE group_id = ? ORDER BY sort_order`, gid,
  );
  const periods = all(db, 'SELECT id, seq, status FROM periods WHERE group_id = ? ORDER BY seq', gid);
  const next = periods.find((p) => p.status !== 'drawn' && p.status !== 'settled') ?? null;
  return { group, members, periods, next_period: next, balance: balanceStrip(db, gid) };
}

// Timeline (§22 + §5.11): state chip, pot, rotation slot, drawn recipient, seed fragment.
// Per-member contribution rows ride along for the ORGANIZER console only — a member sees
// the schedule but never another member's payment rows (§5.12 own amounts only).
function timelineView(db, gid, role) {
  const rows = all(db, `
    SELECT p.id, p.seq, p.status, p.version, p.scheduled_recipient, p.drawn_recipient,
           ms.display_name AS scheduled_name, md.display_name AS drawn_name,
           d.id AS draw_event_id, d.seed AS seed, d.drawn_at,
           COALESCE((SELECT SUM(c.amount) FROM contributions c
                     WHERE c.period_id = p.id AND c.status = 'paid'), 0) AS pot,
           (SELECT COUNT(*) FROM contributions c WHERE c.period_id = p.id) AS due_count,
           (SELECT COUNT(*) FROM contributions c
            WHERE c.period_id = p.id AND c.status = 'paid') AS paid_count,
           EXISTS(SELECT 1 FROM overrides o WHERE o.period_id = p.id) AS has_override
    FROM periods p
    LEFT JOIN members ms ON ms.id = p.scheduled_recipient
    LEFT JOIN members md ON md.id = p.drawn_recipient
    LEFT JOIN draw_events d ON d.period_id = p.id
    WHERE p.group_id = ? ORDER BY p.seq`, gid)
    .map((r) => ({
      id: r.id, seq: r.seq, status: r.status, version: r.version,
      scheduled_recipient: r.scheduled_recipient, scheduled_name: r.scheduled_name,
      drawn_recipient: r.drawn_recipient, drawn_name: r.drawn_name,
      draw_event_id: r.draw_event_id, drawn_at: r.drawn_at,
      has_override: !!r.has_override,
      seed_fragment: r.seed ? r.seed.slice(0, 16) : null, // fragment on screen, full seed via verify
      pot: r.pot, due_count: r.due_count, paid_count: r.paid_count,
    }));

  if (role !== 'organizer') return { group_id: gid, periods: rows };
  const byPeriod = new Map(rows.map((r) => [r.id, { ...r, contributions: [], default_cases: [] }]));
  for (const c of all(db, `
      SELECT c.period_id, c.member_id, m.display_name, c.amount, c.status, c.paid_at, c.proof_note
      FROM contributions c
      JOIN members m ON m.id = c.member_id
      JOIN periods p ON p.id = c.period_id
      WHERE p.group_id = ? ORDER BY p.seq, m.sort_order`, gid)) {
    byPeriod.get(c.period_id).contributions.push(c);
  }
  for (const dc of all(db, `
      SELECT dc.id, dc.period_id, dc.member_id, m.display_name, dc.detected_at, dc.resolution
      FROM default_cases dc
      JOIN members m ON m.id = dc.member_id
      JOIN periods p ON p.id = dc.period_id
      WHERE p.group_id = ? ORDER BY dc.id`, gid)) {
    const slot = byPeriod.get(dc.period_id);
    if (slot) slot.default_cases.push(dc);
  }
  return { group_id: gid, periods: [...byPeriod.values()] };
}

// ---------------------------------------------------------------- route table
// auth: 'public' (no session) | 'session' (any member of their own group) | 'organizer'.
const routes = [
  // ---- auth (§5.12) — not part of §22's domain surface, but scrypt + HMAC cookie need a
  // login exchange; without it "auth green" would be untestable.
  ['POST', /^\/api\/auth\/login$/, 'public', ({ db, body }) => {
    const out = loginOrganizer(db, { group_id: body.group_id, passphrase: body.passphrase });
    return new Reply(
      { ok: true, role: 'organizer', member_id: out.member.id, group_id: out.member.group_id, group: out.group },
      { headers: { 'set-cookie': sessionCookie(out.token) } },
    );
  }],

  ['POST', /^\/api\/auth\/token$/, 'public', ({ db, body }) => {
    if (typeof body.token !== 'string' || body.token.length === 0) throw bad('token is required');
    const out = redeemToken(db, body.token);
    return new Reply(
      { ok: true, role: out.role, member_id: out.member.id, group_id: out.member.group_id, display_name: out.member.display_name },
      { headers: { 'set-cookie': sessionCookie(out.token) } },
    );
  }],

  ['GET', /^\/api\/auth\/me$/, 'session', ({ session, db }) => ({
    member_id: session.member_id,
    group_id: session.group_id,
    display_name: session.display_name,
    role: session.role,
    exp: session.exp,
    group: get(db, 'SELECT id, name, amount, frequency, status FROM groups WHERE id = ?', session.group_id),
  })],

  ['POST', /^\/api\/auth\/logout$/, 'session', () => new Reply(
    { ok: true }, { headers: { 'set-cookie': sessionCookie('', { clear: true }) } },
  )],

  // ---- groups (§22)
  ['POST', /^\/api\/groups$/, 'public', ({ db, body }) => {
    // RBAC needs an organizer to exist (§5.12): exactly one roster member must be flagged.
    const roster = Array.isArray(body.members) ? body.members : [];
    if (roster.length > 0) {
      const orgs = roster.filter((m) => m && (m.is_organizer === 1 || m.is_organizer === true)).length;
      if (orgs !== 1) {
        throw bad('exactly one member must be flagged is_organizer: 1 (the group needs one organizer to administer it)');
      }
    }
    const provided = body.organizer_passphrase;
    const generated = provided === undefined || provided === null;
    // Validate BEFORE any write so a rejected passphrase never leaves an unadministrable group.
    const passphrase = generated ? generatePassphrase() : validatePassphrase(provided);
    const out = tx(db, () => {
      const g = schedule.createGroup(db, body);
      schedule.recomputeRotation(db, g.group.id); // §22: create group -> schedule (re)compute
      setOrganizerPassphrase(db, g.group.id, passphrase); // stored as scrypt(salt, hash)
      return g;
    });
    // Only a GENERATED passphrase is ever returned (shown once at creation, §5.12); a
    // provided one is never echoed back.
    return new Reply(
      generated
        ? { ...out, organizer_passphrase: passphrase, organizer_passphrase_generated: true }
        : out,
      { status: 201 },
    );
  }],

  ['GET', /^\/api\/groups\/(?<gid>\d+)$/, 'session', ({ db, m, session }) => {
    const gid = checkGroup(session, m.gid);
    const base = overview(db, gid);
    // Statements list EVERY member's money — organizer console only (§5.12 member scoping).
    return session.role === 'organizer' ? { ...base, statements: statements(db, gid) } : base;
  }],

  ['GET', /^\/api\/groups\/(?<gid>\d+)\/timeline$/, 'session', ({ db, m, session }) => {
    const gid = checkGroup(session, m.gid);
    return timelineView(db, gid, session.role);
  }],

  ['GET', /^\/api\/groups\/(?<gid>\d+)\/audit$/, 'organizer', ({ db, m, session }) => {
    const gid = checkGroup(session, m.gid);
    return {
      audit: all(db, 'SELECT * FROM audit_log WHERE group_id = ? ORDER BY id DESC LIMIT 500', gid),
      draw_events: all(
        db,
        `SELECT d.* FROM draw_events d JOIN periods p ON p.id = d.period_id
         WHERE p.group_id = ? ORDER BY d.id`, gid,
      ),
      overrides: all(
        db,
        `SELECT o.* FROM overrides o JOIN periods p ON p.id = o.period_id
         WHERE p.group_id = ? ORDER BY o.id`, gid,
      ),
    };
  }],

  // Members: step 1 (no token) previews the join delta; step 2 (token + exact delta) applies
  // it — R6 "nothing written until confirmed" on the same §22 route.
  ['POST', /^\/api\/groups\/(?<gid>\d+)\/members$/, 'organizer', ({ db, m, body, session }) => {
    const gid = checkGroup(session, m.gid);
    const actor = session.member_id;
    if (body.preview_token !== undefined) {
      const mcId = body.membership_change_id;
      if (!Number.isInteger(mcId) || mcId < 1) throw bad('membership_change_id must be a positive integer');
      const mc = get(db, 'SELECT group_id FROM membership_changes WHERE id = ?', mcId);
      if (!mc || mc.group_id !== gid) throw notFound(`membership change ${mcId} not found`);
      return proration.confirmMembershipChange(db, {
        membership_change_id: mcId, preview_token: body.preview_token,
        delta: body.delta, actor_id: actor,
      });
    }
    return proration.previewMembershipChange(db, {
      kind: 'join', group_id: gid, display_name: body.display_name,
      sort_order: body.sort_order, effective_seq: body.effective_seq, actor_id: actor,
    });
  }],

  ['POST', /^\/api\/groups\/(?<gid>\d+)\/members\/(?<mid>\d+)\/leave$/, 'organizer', ({ db, m, body, session }) => {
    const gid = checkGroup(session, m.gid);
    return proration.previewMembershipChange(db, {
      kind: 'leave', group_id: gid, member_id: bodyInt(Number(m.mid), 'member_id'),
      effective_seq: body.effective_seq, actor_id: session.member_id,
    });
  }],

  ['POST', /^\/api\/groups\/(?<gid>\d+)\/members\/(?<mid>\d+)\/leave\/confirm$/, 'organizer', ({ db, m, body, session }) => {
    const gid = checkGroup(session, m.gid);
    const mcId = body.membership_change_id;
    if (!Number.isInteger(mcId) || mcId < 1) throw bad('membership_change_id must be a positive integer');
    const mc = get(db, 'SELECT group_id FROM membership_changes WHERE id = ?', mcId);
    if (!mc || mc.group_id !== gid) throw notFound(`membership change ${mcId} not found`);
    return proration.confirmMembershipChange(db, {
      membership_change_id: mcId, preview_token: body.preview_token,
      delta: body.delta, actor_id: session.member_id,
    });
  }],

  // Organizer-issued signed group token (§5.12: members get tokens, no password to phish).
  ['POST', /^\/api\/groups\/(?<gid>\d+)\/members\/(?<mid>\d+)\/token$/, 'organizer', ({ db, m, session }) => {
    const gid = checkGroup(session, m.gid);
    const mid = bodyInt(Number(m.mid), 'member_id');
    const member = get(db, 'SELECT * FROM members WHERE id = ? AND group_id = ?', mid, gid);
    if (!member) throw notFound(`member ${mid} not found in group ${gid}`);
    return {
      token: issueSession({ memberId: mid, groupId: gid, ttl: MEMBER_TOKEN_TTL }),
      member_id: mid,
      group_id: gid,
      expires_in: MEMBER_TOKEN_TTL,
      note: 'send this token to the member: it signs them in without a password and grants read-only access',
    };
  }],

  ['POST', /^\/api\/groups\/(?<gid>\d+)\/close$/, 'organizer', ({ db, m, session }) => {
    const gid = checkGroup(session, m.gid);
    return closeGroup(db, { groupId: gid, actor_id: session.member_id });
  }],

  // ---- periods (§22)
  ['POST', /^\/api\/periods\/(?<pid>\d+)\/open$/, 'organizer', ({ db, m, session }) => {
    const p = loadPeriod(db, m.pid, session);
    return schedule.openPeriod(db, p.id, session.member_id);
  }],

  ['POST', /^\/api\/periods\/(?<pid>\d+)\/contributions$/, 'organizer', ({ db, m, body, session }) => {
    const p = loadPeriod(db, m.pid, session);
    return recordContribution(db, {
      periodId: p.id,
      memberId: bodyInt(body.member_id, 'member_id'),
      status: body.status,
      proof_note: body.proof_note ?? null,
      actor_id: session.member_id,
    });
  }],

  ['POST', /^\/api\/periods\/(?<pid>\d+)\/draw$/, 'organizer', ({ db, m, session }) => {
    const p = loadPeriod(db, m.pid, session);
    // R2 re-checks the precondition INSIDE drawPeriod's transaction, never here.
    return drawPeriod(db, { periodId: p.id, actor_id: session.member_id });
  }],

  ['GET', /^\/api\/periods\/(?<pid>\d+)\/draw\/verify$/, 'session', ({ db, m, session }) => {
    const p = loadPeriod(db, m.pid, session);
    const de = get(db, 'SELECT * FROM draw_events WHERE period_id = ?', p.id);
    if (!de) throw new ValidationError(`period ${p.id} has not been drawn yet`, 409, { period_id: p.id, status: p.status });
    const inputs = JSON.parse(de.inputs_json);
    // Full artifacts for the client-side re-run (§5.4 step 8); the raw secret never appears.
    return {
      period_id: p.id,
      seq: p.seq,
      seed: de.seed,
      algo: de.algo,
      inputs,
      drawn_at: de.drawn_at,
      drawn_recipient: p.drawn_recipient,
      recomputed: verify({ seed: de.seed, algo: de.algo, inputs, drawn_recipient: p.drawn_recipient }),
    };
  }],

  ['POST', /^\/api\/periods\/(?<pid>\d+)\/default$/, 'organizer', ({ db, m, body, session }) => {
    const p = loadPeriod(db, m.pid, session);
    return defaultRules.markDefault(db, {
      periodId: p.id,
      memberId: bodyInt(body.member_id, 'member_id'),
      reason: body.reason ?? null,
      actor_id: session.member_id,
    });
  }],

  ['POST', /^\/api\/periods\/(?<pid>\d+)\/default\/resolve$/, 'organizer', ({ db, m, body, session }) => {
    const p = loadPeriod(db, m.pid, session);
    return defaultRules.resolveDefault(db, {
      periodId: p.id,
      memberId: body.member_id === undefined || body.member_id === null ? null : bodyInt(body.member_id, 'member_id'),
      path: body.path,
      reason: body.reason,
      actor_id: session.member_id, // R5: reason + actor + timestamp are mandatory
    });
  }],

  ['POST', /^\/api\/periods\/(?<pid>\d+)\/override$/, 'organizer', ({ db, m, body, session }) => {
    const p = loadPeriod(db, m.pid, session);
    return overrideRecipient(db, {
      periodId: p.id,
      recipientId: bodyInt(body.recipient_id, 'recipient_id'),
      reason: reasonOrThrow(body.reason), // §5.7 case 7: empty reason -> 400
      actor_id: session.member_id,
    });
  }],

  ['POST', /^\/api\/periods\/(?<pid>\d+)\/cancel$/, 'organizer', ({ db, m, session }) => {
    const p = loadPeriod(db, m.pid, session);
    return schedule.cancelPeriod(db, { periodId: p.id, actor_id: session.member_id });
  }],

  // ---- member statement (§22): own rows only, 403 cross-member, 404 cross-group.
  ['GET', /^\/api\/members\/(?<mid>\d+)\/statement$/, 'session', ({ db, m, query, session }) => {
    if (query.group === undefined) throw bad('missing ?group= parameter');
    const gid = Number(query.group);
    if (!Number.isInteger(gid) || gid < 1) throw bad('?group must be a positive integer');
    if (gid !== session.group_id) throw notFound(`group ${query.group} not found`);
    const mid = bodyInt(Number(m.mid), 'member_id');
    const member = get(db, 'SELECT * FROM members WHERE id = ? AND group_id = ?', mid, gid);
    if (!member) throw notFound(`member ${mid} not found in group ${gid}`);
    if (session.role !== 'organizer' && session.member_id !== mid) {
      throw forbidden('members may read only their own statement');
    }
    const row = statements(db, gid).members.find((s) => s.member_id === mid);
    return {
      group_id: gid,
      member: { id: member.id, display_name: member.display_name, status: member.status, sort_order: member.sort_order },
      statement: row,
      // Own contribution rows only — this response never contains another member's money.
      contributions: all(
        db,
        `SELECT c.period_id, p.seq, c.amount, c.status, c.paid_at, c.proof_note
         FROM contributions c JOIN periods p ON p.id = c.period_id
         WHERE c.member_id = ? ORDER BY p.seq`, mid,
      ),
      group_status: get(db, 'SELECT status FROM groups WHERE id = ?', gid).status,
    };
  }],
];

// ---------------------------------------------------------------- handler
// Exported so tests can assert the §22 route shape directly (§5.13 test 7).
export { routes };

export function createHandler(db) {
  return async function handle(req, res) {
    const send = (status, payload, headers = {}) => {
      const bodyStr = JSON.stringify(payload);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(bodyStr),
        'x-content-type-options': 'nosniff',
        ...headers,
      });
      res.end(bodyStr);
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const query = Object.fromEntries(url.searchParams);

      let matched = null;
      for (const route of routes) {
        const [method, re] = route;
        if (req.method !== method) continue;
        const mm = path.match(re);
        if (mm) { matched = route; break; }
      }
      if (!matched) {
        const pathExists = routes.some(([, re]) => re.test(path));
        return send(pathExists ? 405 : 404, {
          error: pathExists ? `method ${req.method} not allowed` : 'no such route',
          path,
        });
      }

      // auth BEFORE the body is read: an unauthenticated flood never gets past RBAC, and a
      // member's POST is refused with 403 no matter what bytes follow (§5.12 negative tests).
      const [, , level, handler] = matched;
      let session = null;
      if (level !== 'public') {
        const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        if (!raw) throw unauthorized('authentication required: sign in first');
        session = sessionFromCookie(db, raw);
        if (level === 'organizer' && session.role !== 'organizer') {
          throw forbidden('organizer role required: members are read-only (§5.12)');
        }
      }
      if (req.method === 'POST') assertSameOrigin(req);

      const body = req.method === 'POST' ? await readBody(req) : {};
      // Named capture groups only: handlers read m.gid / m.pid / m.mid.
      const out = handler({ db, m: path.match(matched[1])?.groups ?? {}, body, query, session, req });
      if (out instanceof Reply) return send(out.status, out.body, out.headers);
      return send(200, out);
    } catch (e) {
      if (e instanceof ValidationError) {
        return send(e.status, { error: e.message, ...(e.detail != null ? { detail: e.detail } : {}) });
      }
      // A CHECK/UNIQUE that escaped the domain layer is still a client problem, not a 500.
      const msg = String(e?.message ?? '');
      if (msg.includes('constraint failed') || msg.includes('UNIQUE constraint')) {
        return send(409, { error: `database constraint rejected the write: ${msg}` });
      }
      process.stderr.write(`[500] ${req.method} ${req.url}: ${e?.stack ?? e}\n`);
      return send(500, { error: 'internal server error' });
    }
  };
}
