'use strict';

/**
 * Opening balances — what a party owed before Spinoto started recording.
 *
 * ══ NOTHING IS EVER UPDATED ════════════════════════════════════════════════
 *
 * Setting a balance where one already exists SUPERSEDES the old row and
 * inserts a new one. Both stay. See migration 186 for why: this is the one
 * figure in the ledger a human types, which makes it the one figure a human
 * could quietly change, and Rule 56 and the Companies Act audit-trail rule
 * both want the correction visible rather than the original gone.
 *
 * Clearing a balance supersedes with no replacement. The history survives that
 * too — "there used to be one and somebody removed it" is a question worth
 * being able to answer.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { logActivity } = require('../services/activityLog.service');
const { isHubUser } = require('../utils/hubScope');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const setSchema = z.object({
  party_type: z.enum(['customer', 'hub']),
  party_key:  z.string().trim().min(1).max(40),
  amount:     z.number().min(0),
  direction:  z.enum(['dr', 'cr']),
  as_of_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note:       z.string().trim().max(2000).nullable().optional(),
});

/** The live figure for one party, with everything it replaced behind it. */
async function getOpeningBalance(req, res, next) {
  try {
    if (isHubUser(req)) return res.status(403).json({ error: 'Not available to hub logins.' });
    const { party_type, party_key } = req.query;
    if (!party_type || !party_key) {
      return res.status(400).json({ error: 'party_type and party_key are required.' });
    }
    const rows = await pool.query(
      `SELECT b.*, u.name AS created_by_name, s.name AS superseded_by_name
         FROM party_opening_balances b
         LEFT JOIN users u ON u.id = b.created_by
         LEFT JOIN users s ON s.id = b.superseded_by
        WHERE b.party_type = $1 AND b.party_key = $2
        ORDER BY b.id DESC`,
      [party_type, String(party_key)]
    );
    const current = rows.rows.find(r => r.superseded_at === null) || null;
    res.json({ current, history: rows.rows.filter(r => r.superseded_at !== null) });
  } catch (err) { next(err); }
}

/** Set, or correct. Either way it is an insert. */
async function setOpeningBalance(req, res, next) {
  const client = await pool.connect();
  try {
    if (isHubUser(req)) return res.status(403).json({ error: 'Not available to hub logins.' });

    const parsed = setSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid opening balance' });
    }
    const d = parsed.data;
    const amount = r2(d.amount);

    await client.query('BEGIN');
    /* Serialise per party, so two people saving at once cannot both supersede
       the same row and leave two live ones — which the partial unique index
       would reject anyway, but with a constraint error rather than a queue. */
    await client.query(`SELECT pg_advisory_xact_lock(6, hashtext($1))`, [`${d.party_type}:${d.party_key}`]);

    const prev = await client.query(
      `SELECT id, amount, direction FROM party_opening_balances
        WHERE party_type = $1 AND party_key = $2 AND superseded_at IS NULL
        FOR UPDATE`,
      [d.party_type, d.party_key]
    );

    if (prev.rows[0]) {
      await client.query(
        `UPDATE party_opening_balances
            SET superseded_at = NOW(), superseded_by = $1
          WHERE id = $2`,
        [req.user?.id || null, prev.rows[0].id]
      );
    }

    const ins = await client.query(
      `INSERT INTO party_opening_balances
         (party_type, party_key, amount, direction, as_of_date, note, created_by)
       VALUES ($1,$2,$3,$4,$5::date,$6,$7) RETURNING *`,
      [d.party_type, d.party_key, amount.toFixed(2), d.direction, d.as_of_date,
       d.note || null, req.user?.id || null]
    );

    await client.query('COMMIT');

    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: prev.rows[0] ? 'UPDATE' : 'CREATE',
      entity: 'opening_balance', entityId: ins.rows[0].id,
      description: prev.rows[0]
        ? `Opening balance for ${d.party_type} ${d.party_key} corrected from ₹${prev.rows[0].amount} ${prev.rows[0].direction} to ₹${amount.toFixed(2)} ${d.direction}`
        : `Opening balance set for ${d.party_type} ${d.party_key}: ₹${amount.toFixed(2)} ${d.direction} as at ${d.as_of_date}`,
    });

    res.status(prev.rows[0] ? 200 : 201).json({ current: ins.rows[0], replaced: !!prev.rows[0] });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* the original error is the one that matters */ }
    next(err);
  } finally { client.release(); }
}

/** Remove the live figure. The row stays, superseded with nothing after it. */
async function clearOpeningBalance(req, res, next) {
  const client = await pool.connect();
  try {
    if (isHubUser(req)) return res.status(403).json({ error: 'Not available to hub logins.' });
    const { party_type, party_key } = req.params;

    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE party_opening_balances
          SET superseded_at = NOW(), superseded_by = $1
        WHERE party_type = $2 AND party_key = $3 AND superseded_at IS NULL
      RETURNING id, amount, direction`,
      [req.user?.id || null, party_type, String(party_key)]
    );
    await client.query('COMMIT');

    if (!r.rows[0]) return res.status(404).json({ error: 'No opening balance set for this party.' });

    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'DELETE', entity: 'opening_balance', entityId: r.rows[0].id,
      description: `Opening balance removed for ${party_type} ${party_key} (was ₹${r.rows[0].amount} ${r.rows[0].direction})`,
    });
    res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    next(err);
  } finally { client.release(); }
}

/**
 * Who plausibly needs one — the worklist.
 *
 * Deliberately narrow. Every customer COULD have an opening balance, but a
 * one-invoice walk-in almost certainly does not, and a list of 232 names with
 * four that matter is a list nobody finishes. So: B2B customers, and hubs with
 * money outstanding. On the current data that is 4 and 9.
 */
async function listCandidates(req, res, next) {
  try {
    if (isHubUser(req)) return res.status(403).json({ error: 'Not available to hub logins.' });

    const customers = await pool.query(
      `SELECT ci.mobile AS party_key,
              COALESCE(NULLIF(TRIM(MAX(ci.b2b_company_name)), ''), MAX(ci.customer_name)) AS name,
              MAX(TRIM(ci.b2b_gst_number)) AS gstin,
              COUNT(*)::int                 AS invoices,
              ROUND(SUM(ci.grand_total), 2) AS billed,
              ROUND(SUM(ci.grand_total - ci.amount_paid), 2) AS outstanding,
              b.amount AS opening_amount, b.direction AS opening_direction, b.as_of_date
         FROM customer_invoices ci
         LEFT JOIN party_opening_balances b
                ON b.party_type = 'customer' AND b.party_key = ci.mobile
               AND b.superseded_at IS NULL
        WHERE ci.is_b2b
        GROUP BY ci.mobile, b.amount, b.direction, b.as_of_date
        ORDER BY 6 DESC NULLS LAST`
    );

    const hubs = await pool.query(
      `SELECT h.id::text AS party_key, h.hub_name AS name,
              COUNT(pi.id)::int AS invoices,
              ROUND(SUM(pi.grand_total), 2) AS billed,
              ROUND(SUM(pi.grand_total), 2) AS outstanding,
              b.amount AS opening_amount, b.direction AS opening_direction, b.as_of_date
         FROM purchase_invoices pi
         JOIN hubs h ON h.id = pi.hub_id
         LEFT JOIN party_opening_balances b
                ON b.party_type = 'hub' AND b.party_key = h.id::text
               AND b.superseded_at IS NULL
        WHERE pi.payment_status = 'pending' AND pi.grand_total > 0
        GROUP BY h.id, h.hub_name, b.amount, b.direction, b.as_of_date
        ORDER BY 5 DESC`
    );

    res.json({ customers: customers.rows, hubs: hubs.rows });
  } catch (err) { next(err); }
}

module.exports = { getOpeningBalance, setOpeningBalance, clearOpeningBalance, listCandidates };
