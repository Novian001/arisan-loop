// R1 / §5.12: raw secret lives in ARISAN_SECRET env or backend/data/.secret (mode 600,
// gitignored) — never in the repo, never in the DB. Only sha256(secret) (secret_commit)
// and derived seeds leave this module.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function getSecret() {
  if (process.env.ARISAN_SECRET) return process.env.ARISAN_SECRET;
  const file = join(HERE, '..', 'data', '.secret');
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(32).toString('hex') + '\n');
    chmodSync(file, 0o600);
  }
  return readFileSync(file, 'utf8').trim();
}

export function secretCommit() {
  return createHash('sha256').update(getSecret()).digest('hex');
}
