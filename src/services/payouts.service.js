'use strict';

/**
 * Hub payouts — money going OUT.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE RULE THAT MUST NOT BE SOFTENED                                        ║
 * ║                                                                           ║
 * ║   hub_payments is written when the gateway CONFIRMS.                      ║
 * ║   Never when the payout is requested.                                     ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * It is the same rule requestRefund already follows on the way in, for the same
 * reason. Writing the ledger at request time would mark a hub paid the instant
 * somebody clicked — before a rupee moved — and leave nothing to correct with
 * when the transfer failed two days later. So:
 *
 *   requestPayout()      → hub_payouts row, status 'created', BEFORE the API
 *                          call. hub_payments UNTOUCHED.
 *   applyPayoutOutcome() → called by the payout.processed / .failed / .reversed
 *                          webhook, and by the manual Refresh. THIS is where
 *                          hub_payments moves.
 *
 * The pending row goes in before the network call, not after: a request that
 * times out after the provider accepted it leaves money on its way to a hub with
 * no record here, and the webhook then arrives carrying a gateway_payout_id that
 * matches nothing. Written first, the worst case is a 'created' row for a
 * transfer that never started — visible, and correctable. Losing track of money
 * leaving the account is not.
 *
 * ── REVERSAL DELETES THE LEDGER ROW ─────────────────────────────────────────
 * A payout can bounce back days later. When it does, the hub_payments rows are
 * DELETED and the purchase invoice reopens. The decision (delete vs. a negative
 * row) was taken once and must not be mixed: every SUM over hub_payments —
 * _recalcHubPaymentStatus, the payout history totals, the CSV export — assumes
 * positive amounts, and a negative row would have to be handled correctly in all
 * of them or silently corrupt one.
 *
 * Nothing is lost by deleting. The hub_payouts row survives with status
 * 'reversed', its failure_reason, its UTR and its lines — THAT is the audit
 * trail, and it is a better one than a pair of cancelling ledger rows.
 *
 * ── THERE IS NO AUTOMATIC PAYOUT ────────────────────────────────────────────
 * Nothing in this file runs on a schedule. purchase_invoices.payout_due_date
 * exists and could trigger one; it must not, until a human has watched the
 * manual flow work for a month. The failure mode of getting it wrong is money
 * leaving unattended, at night, to an account nobody re-checked. Every function
 * here is reached from a button press.
 */

const crypto = require('crypto');
const { pool } = require('../config/db');
const { getPayoutGateway } = require('./gateway');
const { scrubRaw } = require('./gateway/types');
const { recalcHubInvoiceState } = require('./hubBalance.service');

function fail(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

/** Statuses that mean the payout is still in flight. */
const OPEN_STATUSES = ['created', 'queued', 'processing'];
/** Statuses that mean money has left and is accounted for. */
const SETTLED_STATUSES = ['processed'];

/**
 * Our own reference, the way txn_ref is on the way in.
 *
 * Also the provider's idempotency key and the narration the hub sees on its bank
 * statement — which is why it is alphanumeric with one hyphen and short. The
 * random half is 40 bits from crypto, not a counter: a counter would need a
 * sequence and a transaction to claim it, and this value has to exist before the
 * transaction that uses it.
 */
function newPayoutRef() {
  const d = new Date();
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const rand = crypto.randomBytes(5).toString('hex').toUpperCase();   // 10 chars
  return `PO-${stamp}-${rand}`;                                        // 22 chars
}

// ─────────────────────────────────────────────────────────────────────────────
// Registering a hub with the provider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Can this hub be paid automatically right now?
 *
 * Returned to the screen so it can say WHICH hubs are ready, rather than
 * discovering the answer at the moment somebody presses Pay. A hub with no bank
 * details is not an error state — it is the normal state on day one, and it is
 * fixed with paperwork, not code.
 */
async function hubPayoutReadiness(hubId, db = pool) {
  const r = await db.query(
    `SELECT id, hub_name, bank_account_number, bank_ifsc, account_holder_name,
            payout_contact_id, payout_fund_account_id, payout_status
       FROM hubs WHERE id = $1 AND deleted_at IS NULL`,
    [hubId]);
  const h = r.rows[0];
  if (!h) throw fail(404, 'Hub not found');

  const missing = [];
  if (!h.account_holder_name) missing.push('account holder name');
  if (!h.bank_account_number) missing.push('account number');
  if (!h.bank_ifsc)           missing.push('IFSC');

  return {
    hub_id: h.id,
    hub_name: h.hub_name,
    payout_status: h.payout_status,
    has_bank_details: missing.length === 0,
    missing,
    // The id the payout is actually sent to. Returned so the caller does not
    // have to re-read the row — and so the value used for the transfer is the
    // one that was read alongside payout_status, not a second read that could
    // land after the bank details were edited.
    fund_account_id: h.payout_fund_account_id || null,
    // Last four only. This screen has to answer "which account is this going
    // to" without putting a full account number in a page anyone can screenshot.
    account_last4: h.bank_account_number ? String(h.bank_account_number).slice(-4) : null,
    ifsc: h.bank_ifsc || null,
    registered: Boolean(h.payout_fund_account_id) && h.payout_status === 'verified',
    // What the button should say. Three states, not two: "add bank details" and
    // "register with the provider" are different pieces of work for different
    // people, and collapsing them into "cannot pay" tells nobody what to do.
    blocker: missing.length ? 'bank_details'
           : (!h.payout_fund_account_id || h.payout_status !== 'verified') ? 'registration'
           : null,
  };
}

/**
 * Creates the provider-side contact and fund account for a hub, and stores their
 * ids.
 *
 * Idempotent in the direction that matters: an existing contact is reused, and a
 * fund account is only created when the column is empty. Creating a fund account
 * is NOT idempotent at the provider — a second call makes a second payable
 * account on the same contact, indistinguishable from the first — so the guard
 * is the stored id, and migration 144's trigger is what clears that id when the
 * underlying bank account actually changes.
 */
async function registerHubForPayouts(hubId, { userId = null } = {}) {
  const ready = await hubPayoutReadiness(hubId);
  if (ready.blocker === 'bank_details') {
    throw fail(400, `Add the hub's ${ready.missing.join(', ')} before registering it for payouts.`);
  }
  if (ready.registered) return { ...ready, already: true };

  const gateway = getPayoutGateway();

  const h = (await pool.query(
    `SELECT hub_name, company_name, account_holder_name, bank_account_number, bank_ifsc,
            contact_number, payout_contact_id
       FROM hubs WHERE id = $1`, [hubId])).rows[0];

  await pool.query(
    `UPDATE hubs SET payout_status = 'pending', updated_at = NOW() WHERE id = $1`, [hubId]);

  try {
    let contactId = h.payout_contact_id;
    if (!contactId) {
      const c = await gateway.createContact({
        name: h.company_name || h.hub_name,
        referenceId: `hub-${hubId}`,
        contact: h.contact_number || null,
      });
      contactId = c.id;
      // Stored immediately, before the fund account is attempted. If the next
      // call throws, the contact still exists at the provider — forgetting its
      // id here is what creates the duplicate payee on the retry.
      await pool.query(
        `UPDATE hubs SET payout_contact_id = $2, updated_at = NOW() WHERE id = $1`,
        [hubId, contactId]);
    }

    const fa = await gateway.createFundAccount({
      contactId,
      name: h.account_holder_name,
      ifsc: h.bank_ifsc,
      accountNumber: h.bank_account_number,
    });

    // UPDATE … WHERE payout_status = 'pending' is not needed here, but the
    // trigger from migration 144 is: if the bank details were edited while this
    // was in flight, that edit already reset the row, and this write would put a
    // fund account id for the OLD account beside the NEW number. So the write
    // re-asserts the details it registered.
    const upd = await pool.query(
      `UPDATE hubs
          SET payout_fund_account_id = $2,
              payout_status = 'verified',
              payout_registered_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
          AND bank_account_number IS NOT DISTINCT FROM $3
          AND bank_ifsc IS NOT DISTINCT FROM $4
        RETURNING id`,
      [hubId, fa.id, h.bank_account_number, h.bank_ifsc]);

    if (upd.rowCount === 0) {
      // The account changed under us. Leave it unverified — registering the old
      // account against the new number is precisely the mistake that sends money
      // to the wrong place.
      console.warn(`[payouts] hub ${hubId} bank details changed during registration; not marking verified`);
      throw fail(409, 'The hub bank details changed while it was being registered. Check them and register again.');
    }

    return await hubPayoutReadiness(hubId);
  } catch (err) {
    await pool.query(
      `UPDATE hubs SET payout_status = 'failed', updated_at = NOW()
        WHERE id = $1 AND payout_status = 'pending'`, [hubId]).catch(() => {});
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sending money
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Requests a payout for one or more purchase invoices belonging to ONE hub.
 *
 * @param hubId
 * @param lines  [{ purchase_invoice_id, amount }] — the intended split
 * @param userId who pressed the button
 *
 * Everything about the money is validated HERE, not in the controller: a UI
 * cannot be trusted with "does this exceed the balance", and there are now three
 * screens that can start a payout.
 */
async function requestPayout({ hubId, lines, userId = null, notes = null }) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw fail(400, 'Select at least one invoice to pay.');
  }

  const ready = await hubPayoutReadiness(hubId);
  if (ready.blocker === 'bank_details') {
    throw fail(409, `${ready.hub_name} has no bank account on file (missing ${ready.missing.join(', ')}). Add it on the hub, then pay from here.`);
  }
  if (ready.blocker === 'registration') {
    throw fail(409, `${ready.hub_name} is not registered with the payout provider yet. Register it, then pay from here.`);
  }

  const gateway = getPayoutGateway();
  if (!gateway.isWebhookConfigured() && gateway.isConfigured()) {
    // Refused, not warned. Money leaving has NO second channel: without the
    // webhook this payout would go out and then sit at 'queued' for ever, the
    // purchase invoice would never be marked paid, and someone would eventually
    // pay it again by hand. A payout we cannot hear the result of is worse than
    // no payout.
    throw fail(503, 'Payout webhooks are not configured, so the result of a transfer could not be recorded. Set the payout webhook secret before sending money.');
  }

  const payoutRef = newPayoutRef();
  const client = await pool.connect();
  let payout;
  try {
    await client.query('BEGIN');

    // ── Lock the invoices, then validate under the lock ──────────────────────
    //
    // FOR UPDATE is the guard against the worst bug this feature can have: two
    // Pay clicks on the same invoice producing two transfers. It cannot be an
    // index (migration 145 explains why), so it is a lock — and it only works
    // because EVERY path that creates a payout comes through this function.
    // ORDER BY id so two concurrent batches over overlapping invoices take the
    // rows in the same order and cannot deadlock.
    const ids = lines.map(l => Number(l.purchase_invoice_id));
    const locked = await client.query(
      `SELECT id, hub_id, status, grand_total, amount_paid
         FROM purchase_invoices
        WHERE id = ANY($1::int[])
        ORDER BY id
          FOR UPDATE`,
      [ids]);
    const byId = new Map(locked.rows.map(r => [r.id, r]));

    let total = 0;
    const clean = [];
    for (const l of lines) {
      const piId = Number(l.purchase_invoice_id);
      const pi = byId.get(piId);
      if (!pi) throw fail(404, `Purchase invoice ${piId} not found.`);
      if (pi.hub_id !== Number(hubId)) {
        // One payout, one bank account. Mixing hubs would send one hub's money
        // to another's account.
        throw fail(400, `PI-${String(piId).padStart(6, '0')} belongs to a different hub.`);
      }
      if (pi.status !== 'approved') {
        throw fail(409, `PI-${String(piId).padStart(6, '0')} is not approved yet.`);
      }

      const balance = Number(pi.grand_total) - Number(pi.amount_paid || 0);
      const amount = Number(Number(l.amount).toFixed(2));
      if (!Number.isFinite(amount) || amount <= 0) {
        throw fail(400, `Enter a valid amount for PI-${String(piId).padStart(6, '0')}.`);
      }
      if (amount > balance + 0.011) {
        throw fail(409,
          `PI-${String(piId).padStart(6, '0')} only has ₹${balance.toFixed(2)} outstanding.`);
      }

      // Under the same lock: is there already money on its way to this invoice?
      const open = await client.query(
        `SELECT p.payout_ref
           FROM hub_payout_lines l
           JOIN hub_payouts p ON p.id = l.hub_payout_id
          WHERE l.purchase_invoice_id = $1
            AND p.status = ANY($2::text[])
          LIMIT 1`,
        [piId, OPEN_STATUSES]);
      if (open.rows[0]) {
        throw fail(409,
          `PI-${String(piId).padStart(6, '0')} already has a payout in progress (${open.rows[0].payout_ref}). Wait for it to finish or refresh it first.`);
      }

      total += amount;
      clean.push({ purchase_invoice_id: piId, amount });
    }

    total = Number(total.toFixed(2));

    const ins = await client.query(
      `INSERT INTO hub_payouts
         (payout_ref, gateway, mode, hub_id, amount, status, method,
          gateway_fund_account_id, notes, requested_by)
       VALUES ($1,$2,$3,$4,$5,'created','bank_transfer',$6,$7,$8)
       RETURNING *`,
      [payoutRef, gateway.name, gateway.mode(), hubId, total.toFixed(2),
       ready.fund_account_id || null, notes || null, userId]);
    payout = ins.rows[0];

    for (const l of clean) {
      await client.query(
        `INSERT INTO hub_payout_lines (hub_payout_id, purchase_invoice_id, amount)
         VALUES ($1,$2,$3)`,
        [payout.id, l.purchase_invoice_id, l.amount.toFixed(2)]);
    }

    // Committed BEFORE the network call. Holding the transaction open across an
    // HTTP round trip would keep FOR UPDATE locks on the invoices for the whole
    // provider timeout — blocking every other payout, and the customer-invoice
    // paths that touch the same rows.
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw err;
  }
  client.release();

  // ── The network call. Nothing above this line has moved money. ─────────────
  let result;
  try {
    result = await gateway.createPayout({
      // The id read at validation time, not a fresh read. If the bank details
      // were edited in the seconds since, that edit reset the column to NULL and
      // a re-read would send NULL — but worse, a re-read that found a NEW fund
      // account would send this money to an account nobody approved for it.
      fundAccountId: ready.fund_account_id,
      amount: Number(payout.amount),
      reference: payoutRef,
      notes: { hub_id: String(hubId), payout_ref: payoutRef },
    });
  } catch (err) {
    await pool.query(
      `UPDATE hub_payouts
          SET status = 'failed', failure_reason = $2, updated_at = NOW()
        WHERE id = $1 AND status = 'created'`,
      [payout.id, String(err.message || err).slice(0, 2000)]);
    throw err;
  }

  await pool.query(
    `UPDATE hub_payouts
        SET gateway_payout_id = $2,
            gateway_fund_account_id = COALESCE($3, gateway_fund_account_id),
            status = CASE WHEN status = 'created' THEN $4 ELSE status END,
            raw_response = $5::jsonb,
            updated_at = NOW()
      WHERE id = $1`,
    [payout.id, result.id || null, result.fund_account_id || null,
     result.status === 'processed' ? 'queued' : result.status,
     result.raw ? JSON.stringify(scrubRaw(result.raw)) : null]);

  // Some providers settle a small transfer instantly and report 'processed' on
  // the spot — and mock mode always does. Honour that rather than waiting for a
  // webhook that has already fired. The status above is deliberately written as
  // 'queued' first so that applyPayoutOutcome sees a non-final row and does the
  // ledger work exactly once, through the same path a webhook would take.
  if (result.status === 'processed') {
    await applyPayoutOutcome({
      gatewayPayoutId: result.id,
      payoutRef,
      status: 'processed',
      utr: result.utr || null,
      raw: result.raw || null,
    });
  }

  const fresh = await pool.query(`SELECT * FROM hub_payouts WHERE id = $1`, [payout.id]);
  return fresh.rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Applying a result — the only place hub_payments moves
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Applies a payout result. Called by the webhook, by the manual Refresh, and
 * directly when the provider reports an instant settlement.
 *
 * Idempotent by the same three-deep pattern as a capture: a row lock, an
 * explicit already-final check, and a unique index underneath both
 * (uq_hub_payment_payout_invoice). A redelivered payout.processed must not pay
 * an invoice down twice.
 */
async function applyPayoutOutcome({
  gatewayPayoutId, payoutRef = null, status, utr = null, failureReason = null, raw = null,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Match on the provider's id first; fall back to our own reference, which is
    // what an instant-settlement path has before the id is stored.
    let r = await client.query(
      `SELECT * FROM hub_payouts WHERE gateway_payout_id = $1 FOR UPDATE`, [gatewayPayoutId]);
    if (!r.rows[0] && payoutRef) {
      r = await client.query(
        `SELECT * FROM hub_payouts WHERE payout_ref = $1 FOR UPDATE`, [payoutRef]);
    }
    const payout = r.rows[0];
    if (!payout) {
      await client.query('COMMIT');
      // A payout made from the provider's own dashboard, with no request from
      // here. Not recorded as a hub payment: unlike a customer refund, there is
      // nothing that says WHICH purchase invoices it was meant to settle, and
      // guessing would pay down the wrong ones. Logged loudly so it is
      // reconciled by a person.
      console.warn(`[payouts] outcome '${status}' for an unknown payout ${gatewayPayoutId || payoutRef} — ignored`);
      return { skipped: true };
    }

    // Already final. 'reversed' is deliberately allowed to follow 'processed' —
    // that is the whole reason the status exists.
    const FINAL = ['failed', 'cancelled', 'reversed'];
    if (FINAL.includes(payout.status) || (payout.status === 'processed' && status !== 'reversed')) {
      await client.query('COMMIT');
      return { payout, duplicate: true };
    }

    if (status === 'processed') {
      await _writeLedger(client, payout, utr);
    } else if (status === 'reversed') {
      await _reverseLedger(client, payout);
    }

    const upd = await client.query(
      // Every use of $2 is cast to text.
      //
      // Without the casts Postgres deduces the parameter's type from its FIRST
      // use — varchar, from `status = $2` — and then the `$2 = 'processed'`
      // comparisons deduce text, and it refuses the whole statement with
      // "inconsistent types deduced for parameter $2". A parameter used both as
      // an assignment target's value and inside a comparison has to say what it
      // is, once, everywhere.
      `UPDATE hub_payouts
          SET status = $2::text,
              utr = COALESCE($3, utr),
              failure_reason = COALESCE($4, failure_reason),
              gateway_payout_id = COALESCE(gateway_payout_id, $5),
              raw_response = COALESCE($6::jsonb, raw_response),
              processed_at = CASE WHEN $2::text = 'processed' THEN NOW() ELSE processed_at END,
              reversed_at  = CASE WHEN $2::text = 'reversed'  THEN NOW() ELSE reversed_at  END,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [payout.id, status, utr, failureReason ? String(failureReason).slice(0, 2000) : null,
       gatewayPayoutId || null, raw ? JSON.stringify(scrubRaw(raw)) : null]);

    await client.query('COMMIT');
    console.log(`[payouts] ${payout.payout_ref} → ${status}` + (utr ? ` (UTR ${utr})` : ''));
    return { payout: upd.rows[0], duplicate: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * THE MONEY MOVES HERE, AND ONLY HERE.
 *
 * One hub_payments row per purchase invoice, because that is what migration 105
 * requires and what _recalcHubPaymentStatus sums. payment_batch_id carries the
 * payout_ref so the existing payout-history screen groups a multi-invoice
 * transfer into the single line it actually was, with no new rendering code.
 *
 * ON CONFLICT DO NOTHING against uq_hub_payment_payout_invoice: the row lock
 * above already serialises redeliveries, and this is the backstop for the case
 * the lock cannot cover — two application processes, one having committed while
 * the other was still deciding.
 */
async function _writeLedger(client, payout, utr) {
  const lines = await client.query(
    `SELECT purchase_invoice_id, amount FROM hub_payout_lines
      WHERE hub_payout_id = $1 ORDER BY purchase_invoice_id`,
    [payout.id]);

  for (const l of lines.rows) {
    await client.query(
      `INSERT INTO hub_payments
         (purchase_invoice_id, hub_id, amount, method, reference_no, paid_at,
          notes, created_by, payment_batch_id, hub_payout_id)
       VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,$8,$9)
       ON CONFLICT (hub_payout_id, purchase_invoice_id)
         WHERE hub_payout_id IS NOT NULL DO NOTHING`,
      [l.purchase_invoice_id, payout.hub_id, l.amount, payout.method,
       // The UTR is the bank reference. It lands in the same free-text column
       // people type one into by hand, so the export, the search and the hub's
       // own statement all line up whether the transfer was automatic or not.
       utr || payout.utr || payout.payout_ref,
       `Paid automatically — ${payout.payout_ref}`,
       payout.requested_by, payout.payout_ref, payout.id]);

    await recalcHubInvoiceState(client, l.purchase_invoice_id);
  }
}

/**
 * A payout that bounced. The ledger rows go, the invoices reopen.
 *
 * Scoped by hub_payout_id, never by payment_batch_id: a person could in
 * principle have typed the payout_ref into a manual payment's reference field,
 * and deleting by the batch id would take that row with it. The foreign key is
 * the only thing that means "this row was produced by this payout".
 */
async function _reverseLedger(client, payout) {
  const del = await client.query(
    `DELETE FROM hub_payments WHERE hub_payout_id = $1
      RETURNING purchase_invoice_id, amount`,
    [payout.id]);

  const piIds = [...new Set(del.rows.map(r => r.purchase_invoice_id))];
  for (const piId of piIds) {
    await recalcHubInvoiceState(client, piId);
  }

  if (del.rowCount > 0) {
    console.warn(`[payouts] REVERSED ${payout.payout_ref} — ₹${payout.amount} pulled back from `
      + `${piIds.length} purchase invoice(s): ${piIds.map(i => `PI-${String(i).padStart(6, '0')}`).join(', ')}`);
  }
}

/**
 * Asks the provider what happened. The manual Refresh button.
 *
 * Needed because money leaving has no second channel — if a webhook was missed,
 * a payout stays in flight for ever unless somebody asks. Read-only towards the
 * provider; everything it learns goes through applyPayoutOutcome, so the ledger
 * rules are identical whichever way the news arrives.
 */
async function refreshPayout(payoutId) {
  const r = await pool.query(`SELECT * FROM hub_payouts WHERE id = $1`, [payoutId]);
  const payout = r.rows[0];
  if (!payout) throw fail(404, 'Payout not found');
  if (!payout.gateway_payout_id) {
    throw fail(409, 'This payout was never accepted by the provider, so there is nothing to check.');
  }

  const live = await getPayoutGateway().fetchPayout(payout.gateway_payout_id);
  if (live.status === payout.status) {
    return { payout, unchanged: true };
  }
  const out = await applyPayoutOutcome({
    gatewayPayoutId: payout.gateway_payout_id,
    payoutRef: payout.payout_ref,
    status: live.status,
    utr: live.utr,
    failureReason: live.failure_reason,
    raw: live.raw,
  });
  return { ...out, unchanged: false };
}

module.exports = {
  requestPayout,
  applyPayoutOutcome,
  refreshPayout,
  registerHubForPayouts,
  hubPayoutReadiness,
  newPayoutRef,
  OPEN_STATUSES,
  SETTLED_STATUSES,
};
