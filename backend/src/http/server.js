// server.js — node:http wiring (build spec §19/§20/§22): static frontend in front of the
// JSON router, one process, same origin, zero deps. Static first so the browser gets pages
// while every unknown path still answers JSON (a 404 on /api/typo is a test, not a page).
// Tests import start() and get a real socket on port 0 — nothing is mocked.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb, migrate } from '../db.js';
import { createHandler } from './routes.js';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'frontend');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.map': 'application/json',
};

async function serveStatic(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { return next(); } // malformed percent-encoding -> router 404s it as JSON
  if (pathname.startsWith('/api')) return next();
  // normalize() collapses '..' (also once %-decoded above); the prefix check is the guard
  // against anything that still escapes the frontend root — no directory traversal.
  const file = join(FRONTEND, normalize(pathname === '/' ? '/index.html' : pathname));
  if (file !== FRONTEND && !file.startsWith(FRONTEND + '/')) return next();
  let body;
  try { body = await readFile(file); } catch { return next(); }
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': body.length,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// listen() is async: start() resolves only once the socket is bound, so callers (and tests)
// get a usable URL immediately instead of racing a server that is not up yet. A listen
// failure (EADDRINUSE) rejects with the original error so the CLI can explain it.
export function start({ port = 0, db = null, dbFile } = {}) {
  const database = db ?? openDb(dbFile);
  migrate(database); // idempotent (IF NOT EXISTS everywhere) — one code path, tests included
  const handler = createHandler(database);
  const server = createServer((req, res) => {
    serveStatic(req, res, () => handler(req, res)).catch((e) => {
      process.stderr.write(`[500] static ${req.method} ${req.url}: ${e?.stack ?? e}\n`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'internal server error' }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 only: §5.14 — backend runs locally, never exposed, never on the VPS.
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        db: database,
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => { database.close(); done(); });
        }),
      });
    });
  });
}

// `npm start` -> `node src/http/server.js`: PORT env, default 3000 (the port the frontend's
// local-server hint quotes when the API is not running).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  let app;
  try {
    app = await start({ port, dbFile: process.env.DB_FILE });
  } catch (e) {
    if (e?.code === 'EADDRINUSE') {
      process.stderr.write(`port ${port} is already in use — stop it or run with PORT=<other>\n`);
      process.exit(1);
    }
    throw e;
  }
  process.stdout.write(`ArisanLoop on ${app.url} (frontend + /api, db ${process.env.DB_FILE ?? 'backend/data/arisan.db'})\n`);
  const bye = () => { app.close().then(() => process.exit(0)); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
