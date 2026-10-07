// auth.js — §5.12 (build spec): organizer passphrase via node:crypto scrypt (salted),
// session = HMAC-SHA256 cookie (HttpOnly, SameSite=Strict), members sign in with
// organizer-issued signed group tokens (no password to phish). Zero deps, stdlib only.
//
// WHY a stateless signed cookie instead of a session table: two roles and ~15 routes do not
// justify server-side session storage — a restart logging a local dev app out would buy no
// security, while the cookie already carries {member, group, exp} under an HMAC keyed by a
// server-side secret. Tampering fails the signature, expiry is checked on every request, the
// raw passphrase never travels, and the role is re-derived from the DB on each request so a
// demoted organizer cannot keep admin rights from an old cookie.
import { scryptSync, randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { get, run, bad, ValidationError } from './db.js';
import { getSecret } from './secret.js';

export const SESSION_COOKIE = 'arisan_session';
export const SESSION_TTL = 12 * 60 * 60;              // organizer login session (s)
export const MEMBER_TOKEN_TTL = 365 * 24 * 60 * 60;   // organizer-issued member token (s)
const PASS_MIN = 8;
const PASS_MAX = 100;
// scrypt defaults: N=16384 (~16 MB, ~50 ms) is a real kdf cost without stalling a request.
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1 });

export const unauthorized = (msg) => new ValidationError(msg, 401);
export const forbidden = (msg) => new ValidationError(msg, 403);

// Domain-separated key: ARISAN_SESSION_SECRET when set, otherwise derived from the draw
// secret (§5.12: env-generated / generated-once, never hardcoded). ponytail: a dedicated
// rotation env per purpose is all that is missing if secrets ever rotate independently.
function hmacKey() {
  const base = process.env.ARISAN_SESSION_SECRET ?? getSecret();
  return createHash('sha256').update(`${base}|arisan-session-v1`).digest();
}

// ---------------------------------------------------------------- organizer passphrase
export function validatePassphrase(pass) {
  if (typeof pass !== 'string' || pass.length < PASS_MIN || pass.length > PASS_MAX) {
    throw bad(`organizer_passphrase must be a string of ${PASS_MIN}..${PASS_MAX} characters`);
  }
  return pass;
}

export function setOrganizerPassphrase(db, groupId, passphrase) {
  validatePassphrase(passphrase);
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(passphrase, salt, 64, SCRYPT).toString('hex');
  run(
    db,
    `INSERT INTO organizer_auth (group_id, salt, hash) VALUES (?, ?, ?)
     ON CONFLICT(group_id) DO UPDATE SET salt = excluded.salt, hash = excluded.hash`,
    groupId, salt, hash,
  );
}

// timingSafeEqual on every compare; a missing row is a plain false (no user enumeration).
export function checkOrganizerPassphrase(db, groupId, passphrase) {
  const row = get(db, 'SELECT salt, hash FROM organizer_auth WHERE group_id = ?', groupId);
  if (!row || typeof passphrase !== 'string') return false;
  const cand = scryptSync(passphrase, row.salt, 64, SCRYPT);
  const want = Buffer.from(row.hash, 'hex');
  return cand.length === want.length && timingSafeEqual(cand, want);
}

// One message for "unknown group" / "no organizer" / "wrong passphrase": a login form must
// not tell a prober which group ids exist.
export function loginOrganizer(db, { group_id: groupId, passphrase }) {
  if (!Number.isInteger(groupId) || groupId < 1) throw bad('group_id must be a positive integer');
  if (typeof passphrase !== 'string' || passphrase.length === 0) throw bad('passphrase is required');
  const g = get(db, 'SELECT id, name FROM groups WHERE id = ?', groupId);
  const org = g ? get(db, 'SELECT * FROM members WHERE group_id = ? AND is_organizer = 1', groupId) : null;
  if (!g || !org || !checkOrganizerPassphrase(db, groupId, passphrase)) {
    throw unauthorized('invalid group or passphrase');
  }
  return { token: issueSession({ memberId: org.id, groupId, ttl: SESSION_TTL }), member: org, group: g };
}

// ---------------------------------------------------------------- session tokens
// v1.<member>.<group>.<exp>.<hmac> — role is NOT in the payload on purpose: it is re-derived
// from members.is_organizer per request (see sessionFromCookie).
export function issueSession({ memberId, groupId, ttl = SESSION_TTL }) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload = `v1.${memberId}.${groupId}.${exp}`;
  const sig = createHmac('sha256', hmacKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function readSession(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const payload = parts.slice(0, 4).join('.');
  const want = createHmac('sha256', hmacKey()).update(payload).digest('base64url');
  const got = parts[4];
  if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return null;
  const memberId = Number(parts[1]);
  const groupId = Number(parts[2]);
  const exp = Number(parts[3]);
  if (!Number.isInteger(memberId) || !Number.isInteger(groupId)) return null;
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  return { member_id: memberId, group_id: groupId, exp };
}

// A member token (organizer-issued) is the same shape as a session cookie, so redemption is
// "verify it, then set it as the cookie" — no second credential kind to store or rotate.
export function redeemToken(db, rawToken) {
  const s = readSession(rawToken);
  if (!s) throw unauthorized('member token is invalid or expired');
  const m = get(db, 'SELECT * FROM members WHERE id = ? AND group_id = ?', s.member_id, s.group_id);
  if (!m) throw unauthorized('member token does not match a member of its group');
  return { token: rawToken, member: m, role: m.is_organizer ? 'organizer' : 'member' };
}

// Cookie from header -> session, with the role freshly read from the DB (§5.12 RBAC is
// server-side: the cookie only proves WHICH member, never WHAT they may do).
export function sessionFromCookie(db, raw) {
  const s = readSession(raw);
  if (!s) throw unauthorized('session is invalid or expired: sign in again');
  const m = get(
    db,
    'SELECT id, group_id, display_name, is_organizer FROM members WHERE id = ? AND group_id = ?',
    s.member_id, s.group_id,
  );
  if (!m) throw unauthorized('session member no longer exists');
  return {
    member_id: m.id, group_id: m.group_id, display_name: m.display_name,
    role: m.is_organizer ? 'organizer' : 'member', exp: s.exp,
  };
}

export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// HttpOnly + SameSite=Strict per §5.12; CSRF is double-covered by the Origin/Sec-Fetch-Site
// check on mutations. ponytail: add `Secure` once this sits behind TLS — localhost HTTP
// would drop the cookie if it were set today.
export function sessionCookie(value, { clear = false } = {}) {
  return clear
    ? `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
    : `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/`;
}

export function generatePassphrase() {
  return randomBytes(12).toString('base64url'); // 16 chars, returned exactly once at creation
}
