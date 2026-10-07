// override.js — §22 POST /api/periods/:id/override + §5.6 R7 (rotation vs draw) and §5.7
// case 7: the organizer may redirect a DRAWN payout to another eligible member, reason
// required. The DrawEvent row is never touched — the original draw still re-verifies to its
// own winner, and the override lands as its own audited pair of legs.
//
// Money: payout legs are append-only (R12), so the correction is two NEW legs —
// adjustment(+pot) refunding the drawn recipient and payout(-pot) paying the override
// recipient. +pot and −pot cancel inside INV-1/INV-2, statements' group_net stays 0, and each
// member's net follows the money. One override per period: a second override would need
// netting across three members — ponytail: chain overrides only if the product asks.
import { tx, get, run, bad, conflict, notFound } from './db.js';
import { audit } from './ledger.js';
import { assertInv1 } from './invariant.js';

const REASON_MAX = 500;

export function overrideRecipient(db, { periodId, recipientId, reason, actorId = null }) {
  if (!Number.isInteger(periodId)) throw bad('periodId must be an integer');
  if (!Number.isInteger(recipientId) || recipientId < 1) throw bad('recipient_id must be a positive integer');
  const why = typeof reason === 'string' ? reason.trim() : '';
  // §5.7 case 7: an empty reason is a 400 (schema also CHECKs reason NOT NULL empty).
  if (why.length === 0) throw bad('reason is required: an override must say why (R7)');
  if (why.length > REASON_MAX) throw bad(`reason must be at most ${REASON_MAX} characters`);

  return tx(db, () => {
    const p = get(db, 'SELECT * FROM periods WHERE id = ?', periodId);
    if (!p) throw notFound(`period ${periodId} not found`);
    const de = get(db, 'SELECT * FROM draw_events WHERE period_id = ?', periodId);
    if (!de) {
      throw conflict(`period ${periodId} has not been drawn: an override redirects a drawn payout (R7)`, {
        period_id: periodId, status: p.status,
      });
    }
    if (get(db, 'SELECT id FROM overrides WHERE period_id = ?', periodId)) {
      throw conflict(`period ${periodId} already has an override: the recorded recipient stands`, {
        period_id: periodId,
      });
    }
    if (recipientId === p.drawn_recipient) throw bad('recipient_id is already the drawn recipient');
    const m = get(db, 'SELECT * FROM members WHERE id = ? AND group_id = ?', recipientId, p.group_id);
    if (!m) throw notFound(`member ${recipientId} not found in group ${p.group_id}`);
    if (!get(db, 'SELECT id FROM contributions WHERE period_id = ? AND member_id = ?', periodId, recipientId)) {
      throw conflict(`member ${recipientId} is not an eligible participant of period ${periodId}`, {
        period_id: periodId, member_id: recipientId,
      });
    }
    // The exact pot that was paid out (ref pins the draw leg; a period's payouts can also
    // hold advance recoveries, which must not be refunded here).
    const leg = get(
      db, 'SELECT amount FROM ledger WHERE period_id = ? AND kind = ? AND ref = ?',
      periodId, 'payout', `draw:${de.id}`,
    );
    if (!leg) throw conflict(`draw payout leg for period ${periodId} not found`, { period_id: periodId });
    if (!p.drawn_recipient) throw conflict(`period ${periodId} has no drawn recipient to refund`);
    const pot = leg.amount;

    const ovrId = Number(run(
      db,
      `INSERT INTO overrides (period_id, recipient_member_id, reason, actor_id) VALUES (?, ?, ?, ?)`,
      periodId, recipientId, why, actorId,
    ).lastInsertRowid);
    run(
      db,
      `INSERT INTO ledger (group_id, period_id, member_id, kind, amount, sign, actor_id, reason, ref)
       VALUES (?, ?, ?, 'adjustment', ?, 1, ?, 'override_refund', ?)`,
      p.group_id, periodId, p.drawn_recipient, pot, actorId, `override:${ovrId}`,
    );
    run(
      db,
      `INSERT INTO ledger (group_id, period_id, member_id, kind, amount, sign, actor_id, reason, ref)
       VALUES (?, ?, ?, 'payout', ?, -1, ?, 'override_recipient', ?)`,
      p.group_id, periodId, recipientId, pot, actorId, `override:${ovrId}`,
    );
    const upd = run(db, 'UPDATE periods SET drawn_recipient = ? WHERE id = ? AND drawn_recipient = ?',
      recipientId, periodId, p.drawn_recipient);
    if (Number(upd.changes) !== 1) throw conflict(`period ${periodId} was modified concurrently`);

    audit(db, {
      groupId: p.group_id, entity: 'override', entityId: ovrId, action: 'override_recipient',
      actorId, reason: why,
      payload: { period_id: periodId, from: p.drawn_recipient, to: recipientId, amount: pot },
    });
    assertInv1(db, p.group_id);

    return {
      override: get(db, 'SELECT * FROM overrides WHERE id = ?', ovrId),
      period: get(db, 'SELECT * FROM periods WHERE id = ?', periodId),
      previous_recipient: p.drawn_recipient,
      amount: pot,
    };
  });
}
