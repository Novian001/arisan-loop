// INV-1 (R3) and INV-2/closure (R10) read from the SQL views — one source of truth lives
// in schema.sql; every mutating module asserts immediately after its own write so an
// invariant break fails at the transition that caused it, not at some later audit.
import { get, unprocessable } from './db.js';

export function inv1(db, groupId) {
  return get(db, 'SELECT balance FROM v_group_inv1 WHERE group_id = ?', groupId).balance;
}

export function assertInv1(db, groupId) {
  const balance = inv1(db, groupId);
  if (balance !== 0) {
    throw unprocessable(
      `INV-1 violated for group ${groupId}: balance ${balance} != 0`,
      { group_id: groupId, balance },
    );
  }
  return balance;
}

export function closureBalance(db, groupId) {
  return get(db, 'SELECT balance FROM v_closure WHERE group_id = ?', groupId).balance;
}

export function assertClosure(db, groupId) {
  const balance = closureBalance(db, groupId);
  if (balance !== 0) {
    throw unprocessable(
      `closure refused for group ${groupId}: net ${balance} != 0`,
      { group_id: groupId, balance },
    );
  }
  return balance;
}
