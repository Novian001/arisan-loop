// api.mjs — one fetch wrapper (same convention as the sister project): the backend writes
// 4xx messages for humans, and that exact wording is what the screen shows. Two honest
// failure classes only: status 0 = the local server is not running (never "pretend OK"),
// otherwise the real HTTP status + the server's own message. No fixture, no localStorage
// cache, no fake API — this app talks to one origin or it says so.
export class ApiError extends Error {
  constructor(message, { status = 0, detail = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
  get network() { return this.status === 0; }
}

// The backend is GitHub-only and runs locally (§5.14). Quoted port 3000 matches
// backend/src/http/server.js default; when THIS page is served by the backend, its own
// origin is the address to check.
function networkHint() {
  const origin = location.origin;
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const start = 'cd backend && npm start  (PORT env, default http://localhost:3000)';
  return local
    ? `Cannot reach the ArisanLoop backend at ${origin}. It runs locally only — start it with:\n    ${start}\nthen reload this page.`
    : `Cannot reach the ArisanLoop backend. No API is deployed with this static demo — run it locally:\n    ${start}\nand open http://localhost:3000.`;
}

async function request(method, path, { body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(networkHint(), { status: 0 });
  }
  const text = await res.text();
  let payload = null;
  if (text) { try { payload = JSON.parse(text); } catch { payload = { error: text }; } }
  if (!res.ok) {
    throw new ApiError(payload?.error ?? `HTTP ${res.status}`, {
      status: res.status, detail: payload?.detail ?? null,
    });
  }
  return payload;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, { body: body ?? {} }),
};

/** One line for the role=alert box: real status + server wording (or the local hint). */
export function describeError(e) {
  if (e instanceof ApiError) return e.status === 0 ? e.message : `HTTP ${e.status} — ${e.message}`;
  return String(e?.message ?? e);
}
