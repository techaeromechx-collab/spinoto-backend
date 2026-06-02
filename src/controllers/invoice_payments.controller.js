'use strict';

/**
 * Invoice Payments controller
 *
 * POST   /api/invoices/:id/payments          — record a payment
 * GET    /api/invoices/:id/payments          — list payments for invoice
 * DELETE /api/invoices/:id/payments/:payId   — delete a payment
 *
 * After every add/delete we recalculate invoices.amount_paid from the SUM
 * of all payments so the cached column stays accurate.
 */

const { z }    = require('zod');
const { pool } = require('../config/db');

const idParam = z.coerce.number().int().positive();

const METHODS = ['cash', 'upi', 'card', 'other'];

const addSchema = z.object({
  amount:       z.coerce.number().positive('Amount must be > 0'),
  method:       z.enum(METHODS).default('cash'),
  reference_no: z.string().trim().max(80).optional().nullable(),
  paid_at:      z.string().optional().nullable(),   // ISO datetime or date
  notes:        z.string().trim().max(1000).optional().nullable(),
});

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(err => {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
    next(err);
  });
}

// ── Recalculate invoices.amount_paid (called after every mutation) ─────────────
async function syncAmountPaid(client, invoiceId) {
  await client.query(
    `UPDATE invoices
        SET amount_paid = COALESCE(
              (SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = $1), 0
            ),
            updated_at = NOW()
      WHERE id = $1`,
    [invoiceId]
  );
}

// ── POST /api/invoices/:id/payments ──────────────────────────────────────────
function addPayment(req, res, next) {
  handle(req, res, next, async () => {
    const invoiceId = idParam.parse(req.params.id);
    const data      = addSchema.parse(req.body);

    // Verify invoice exists
    const inv = await pool.query(
      'SELECT id, total, amount_paid, (total - amount_paid) AS outstanding FROM invoices WHERE id = $1',
      [invoiceId]
    );
    if (!inv.rows[0]) return res.status(404).json({ error: 'Invoice not found' });

    // Fix #5: prevent overpayment — reject if this payment would exceed outstanding balance
    const outstanding = Number(inv.rows[0].outstanding);
    if (data.amount > outstanding + 0.005) {   // 0.005 tolerance for floating-point rounding
      return res.status(400).json({
        error: `Payment of ${data.amount} exceeds outstanding balance of ${outstanding.toFixed(2)}.`,
        outstanding,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const ins = await client.query(
        `INSERT INTO invoice_payments
           (invoice_id, amount, method, reference_no, paid_at, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          invoiceId,
          data.amount,
          data.method,
          data.reference_no || null,
          data.paid_at      || new Date(),
          data.notes        || null,
          req.user.id,
        ]
      );

      await syncAmountPaid(client, invoiceId);
      await client.query('COMMIT');

      // Return updated invoice summary + new payment
      const invRow = await pool.query(
        'SELECT id, total, amount_paid, (total - amount_paid) AS outstanding FROM invoices WHERE id = $1',
        [invoiceId]
      );
      return res.status(201).json({ payment: ins.rows[0], invoice: invRow.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

// ── GET /api/invoices/:id/payments ───────────────────────────────────────────
function listPayments(req, res, next) {
  handle(req, res, next, async () => {
    const invoiceId = idParam.parse(req.params.id);

    const inv = await pool.query(
      'SELECT id, total, amount_paid, (total - amount_paid) AS outstanding FROM invoices WHERE id = $1',
      [invoiceId]
    );
    if (!inv.rows[0]) return res.status(404).json({ error: 'Invoice not found' });

    const pays = await pool.query(
      `SELECT p.*, u.name AS created_by_name
         FROM invoice_payments p
         LEFT JOIN users u ON u.id = p.created_by
        WHERE p.invoice_id = $1
        ORDER BY COALESCE(p.paid_at, p.created_at) DESC, p.id DESC`,
      [invoiceId]
    );

    return res.json({ items: pays.rows, invoice: inv.rows[0] });
  });
}

// ── DELETE /api/invoices/:id/payments/:payId ─────────────────────────────────
function deletePayment(req, res, next) {
  handle(req, res, next, async () => {
    const invoiceId = idParam.parse(req.params.id);
    const payId     = idParam.parse(req.params.payId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const del = await client.query(
        'DELETE FROM invoice_payments WHERE id = $1 AND invoice_id = $2 RETURNING id',
        [payId, invoiceId]
      );
      if (!del.rows[0]) return res.status(404).json({ error: 'Payment not found' });

      await syncAmountPaid(client, invoiceId);
      await client.query('COMMIT');

      const invRow = await pool.query(
        'SELECT id, total, amount_paid, (total - amount_paid) AS outstanding FROM invoices WHERE id = $1',
        [invoiceId]
      );
      return res.json({ deleted: true, invoice: invRow.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

module.exports = { addPayment, listPayments, deletePayment };
