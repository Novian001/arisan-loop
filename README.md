# ArisanLoop

Rotating savings club (arisan) ledger with an **auditable, client-verifiable draw**.
Organizers run cycles: members contribute a fixed amount per period, a seeded draw picks
the recipient, and every kopek is tracked by a database-level conservation invariant.

Built as a standalone realistic business application — zero npm dependencies, integer
rupiah math everywhere, append-only money history.

## What it does

- **Groups & members** — 2–30 members, fixed amount per period, monthly/weekly schedule,
  K periods, public rotation order.
- **Contributions** — `due → partial → paid → waived` flow with an all-paid readiness gate
  (a half-collected period cannot be drawn; the 409 names the short-payer).
- **Auditable draw** — winner = `sha256-index-v1` sampling over persisted
  `{seed, algo, ordered inputs}`. Not a PRNG: anyone re-hashes the artifacts in their own
  browser (`Verify this draw`, Web Crypto) and reproduces the winner — no server trust.
- **Mid-cycle join/leave (proration)** — preview is a pure function; apply only on an exact
  delta + token, stale preview → 409, drawn periods immutable, contribution rows are never
  deleted (append-only).
- **Defaults** — forfeit path (advance recovered from a later period) and waiver path
  (rotation shift), each with ledger evidence and an audit entry.
- **Closure** — only when every period is drawn, INV-1 = 0 and no advances remain
  (net-zero check with a member/period imbalance breakdown on 422).
- **Audit log** — every state-changing action records actor, reason and payload.

## The invariant

`INV-1: parked_collected + collected − paid_out + advances − recovered = 0`

Enforced by DB views and asserted after every money-moving transaction (there is even a
trigger-level test proving the draw payout cancels the parked collection). Period and
ledger rows reject `UPDATE`/`DELETE` — history is append-only, illegal transitions
`ABORT` in the database itself.

## Stack

- **Backend** — Node.js 22 stdlib (`node:http`) + `node:sqlite` (WAL, `BEGIN IMMEDIATE`
  for money), one process serving JSON API **and** the static frontend. Zero dependencies
  (`npm ls` is empty), tests via `node:test`.
- **Auth** — scrypt-hashed organizer passphrase, signed read-only member tokens (365 days,
  shown once), server-side RBAC (401/403).
- **Frontend** — static HTML/CSS/ES-modules, no build step, honest error states (real HTTP
  status text, local-server hint when the API is unreachable — it never fakes data).

## Run

```bash
cd backend
npm start                 # PORT env, default http://localhost:3000 (DB_FILE env to override)
npm test                  # 58 tests
```

Open `http://localhost:3000` → **Start a group** → organizer passphrase → console.

## API

JSON under `/api/*` (see `backend/src/http/routes.js` for the exact route table):
groups/members, timeline, contributions, draw + `draw/verify`, proration preview/confirm,
defaults + resolve, override, statement, close, audit. Errors are human-readable JSON
(`400` validation, `401/403` auth, `404` not found, `409` state conflict,
`422` invariant violations).

## Deployment status (honest)

- **Backend: GitHub-only, runs locally** — the SQLite single-writer backend is not deployed
  anywhere. Start it with `npm start`.
- **Frontend: static, served by the same local server** — no API is deployed with it; the
  page shows an honest error (with a start hint) instead of pretending when the backend is
  down.
- See `git log` for history; repository policy follows the factory deployment tiers.

## Fairness ceiling (read this)

The draw seed is `sha256(secret ‖ group ‖ seq ‖ nonce)` with the raw secret held only by
the server (env `ARISAN_SECRET` or a mode-600 generated file). Verifiers check that the
served winner **reproduces from the published artifacts**; they cannot prove the secret
itself was chosen fairly. Rotate/commit the secret or add a randomness beacon (the
`nonce` slot in `deriveSeed`) if you need that stronger guarantee.
