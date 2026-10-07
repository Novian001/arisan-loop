// WHY one function owns the connection: PRAGMA state is per-connection, and the whole
// point of this repo is that the DB enforces the money rules (foreign_keys, busy_timeout,
// IMMEDIATE transactions). Callers opening their own connections would silently weaken it.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function openDb(file = join(HERE, '..', 'data', 'arisan.db')) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

// WHY migrate separate from open: schema.sql is plain SQL, so `sqlite3 db < file` stays a
// valid manual path and every statement (CHECK, trigger, view) is diffable in the repo.
export function migrate(db) {
  db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
}

// WHY BEGIN IMMEDIATE for money: contribution/draw paths are read-check-write. IMMEDIATE
// takes the write lock up front so the precondition re-check inside the txn is serialised.
// Re-entrant on purpose: nested BEGINs are a hard error in SQLite; a depth counter makes
// the inner call join the outer transaction — still exactly one commit point.
const BEGIN_DEPTH = Symbol('txDepth');

export function tx(db, fn) {
  const depth = (db[BEGIN_DEPTH] ?? 0);
  if (depth > 0) {
    db[BEGIN_DEPTH] = depth + 1;
    try { return fn(); } finally { db[BEGIN_DEPTH] = depth; }
  }
  db.exec('BEGIN IMMEDIATE');
  db[BEGIN_DEPTH] = 1;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* aborted txn is already rolled back */ }
    throw e;
  } finally {
    db[BEGIN_DEPTH] = 0;
  }
}

// One error shape for domain and HTTP layers: a 4xx problem must not be logged as a 500.
export class ValidationError extends Error {
  constructor(message, status = 400, detail = null) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
    this.detail = detail;
  }
}

export const bad = (msg, detail) => new ValidationError(msg, 400, detail);
export const conflict = (msg, detail) => new ValidationError(msg, 409, detail);
export const notFound = (msg) => new ValidationError(msg, 404);
export const unprocessable = (msg, detail) => new ValidationError(msg, 422, detail);

export function all(db, sql, ...params) { return db.prepare(sql).all(...params); }
export function get(db, sql, ...params) { return db.prepare(sql).get(...params); }
export function run(db, sql, ...params) { return db.prepare(sql).run(...params); }
