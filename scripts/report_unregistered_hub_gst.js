'use strict';
/**
 * READ-ONLY report: GST charged on purchase invoices for hubs that are not
 * GST-registered.
 *
 * WHY THIS EXISTS
 * ───────────────
 * purchase_invoices.controller.js never consults hubs.has_gst. Every line is
 * computed as:
 *
 *     gstAmount    = hubAmount × gst_percent / 100
 *     totalPayable = hubAmount + gstAmount
 *
 * and grand_total — the figure hub payments settle against — is the sum of
 * total_payable. So a hub with no GST registration has been invoiced, and in
 * most cases paid, an extra 18% on every job. They cannot legally charge that
 * tax and will not remit it.
 *
 * There is a second cost on the company side: input tax credit claimed against
 * a supplier with no GSTIN will not match GSTR-2B and gets reversed.
 *
 * Run this BEFORE the fix goes in. Once the generator stops adding GST the
 * evidence gets harder to assemble cleanly, because new invoices will look
 * correct and only the historical ones will carry the problem.
 *
 *   node backend/scripts/report_unregistered_hub_gst.js
 *   node backend/scripts/report_unregistered_hub_gst.js --csv > overpaid.csv
 *
 * Touches nothing. No writes, no transaction, safe on production.
 *
 * IMPORTANT CAVEAT ON has_gst
 * ───────────────────────────
 * hubs.has_gst is read LIVE, not as it stood when each invoice was raised —
 * nothing snapshots it today (that is part of the fix). So a hub that has
 * since registered will look registered here, and its earlier invoices will be
 * missed. Numbers below are therefore a FLOOR, not an exact figure. Where a
 * hub has has_gst = true but no gst_number recorded, that is flagged
 * separately — those are the likely misses.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { Client } = require('pg');

const asCsv = process.argv.includes('--csv');
const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const isProduction = process.env.NODE_ENV === 'production';
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
  });
  await client.connect();

  try {
    // amount_paid is invoice-level, not per-tax-component, so the GST actually
    // handed over is apportioned: a half-paid invoice has handed over half its
    // GST. LEAST() guards the overpaid-invoice case so a rounding artefact can
    // never report more GST paid than the invoice carried.
    const rows = (await client.query(`
      SELECT
        h.id                                   AS hub_id,
        h.hub_code,
        h.hub_name,
        h.gst_number,
        pi.id                                  AS pi_id,
        pi.invoice_date::text                  AS invoice_date,
        pi.status,
        pi.payment_status,
        pi.grand_total,
        pi.total_gst,
        pi.amount_paid,
        CASE
          WHEN pi.grand_total > 0
            THEN LEAST(pi.total_gst, ROUND(pi.total_gst * (pi.amount_paid / pi.grand_total), 2))
          ELSE 0
        END                                    AS gst_paid_out,
        GREATEST(pi.total_gst - CASE
          WHEN pi.grand_total > 0
            THEN LEAST(pi.total_gst, ROUND(pi.total_gst * (pi.amount_paid / pi.grand_total), 2))
          ELSE 0
        END, 0)                                AS gst_still_owed
      FROM purchase_invoices pi
      JOIN hubs h ON h.id = pi.hub_id
      WHERE COALESCE(h.has_gst, FALSE) = FALSE
        AND COALESCE(pi.total_gst, 0) > 0
      ORDER BY h.hub_name, pi.invoice_date, pi.id
    `)).rows;

    if (asCsv) {
      console.log('hub_code,hub_name,purchase_invoice_id,invoice_date,status,payment_status,grand_total,total_gst,amount_paid,gst_paid_out,gst_still_owed');
      for (const r of rows) {
        console.log([
          r.hub_code || '', `"${(r.hub_name || '').replace(/"/g, '""')}"`, r.pi_id, r.invoice_date || '',
          r.status, r.payment_status, r.grand_total, r.total_gst, r.amount_paid, r.gst_paid_out, r.gst_still_owed,
        ].join(','));
      }
      return;
    }

    console.log('\n═══ GST charged on invoices from NON-GST-REGISTERED hubs ═══\n');

    if (rows.length === 0) {
      console.log('  None. No purchase invoice carries GST for a hub with has_gst = false.');
    } else {
      // Per hub, because the conversation and any recovery happens per hub.
      const byHub = new Map();
      for (const r of rows) {
        const k = r.hub_id;
        if (!byHub.has(k)) byHub.set(k, { ...r, count: 0, gst: 0, paid: 0, owed: 0 });
        const g = byHub.get(k);
        g.count += 1;
        g.gst  += Number(r.total_gst || 0);
        g.paid += Number(r.gst_paid_out || 0);
        g.owed += Number(r.gst_still_owed || 0);
      }

      console.log('  HUB'.padEnd(34) + 'INVOICES'.padStart(9) + 'GST BILLED'.padStart(16) + 'GST PAID OUT'.padStart(16) + 'NOT YET PAID'.padStart(16));
      console.log('  ' + '─'.repeat(89));
      let tG = 0, tP = 0, tO = 0, tC = 0;
      for (const g of [...byHub.values()].sort((a, b) => b.paid - a.paid)) {
        const label = `${g.hub_code ? g.hub_code + ' · ' : ''}${g.hub_name}`;
        console.log(
          '  ' + label.slice(0, 32).padEnd(32) +
          String(g.count).padStart(9) + inr(g.gst).padStart(16) +
          inr(g.paid).padStart(16) + inr(g.owed).padStart(16)
        );
        tG += g.gst; tP += g.paid; tO += g.owed; tC += g.count;
      }
      console.log('  ' + '─'.repeat(89));
      console.log('  ' + 'TOTAL'.padEnd(32) + String(tC).padStart(9) + inr(tG).padStart(16) + inr(tP).padStart(16) + inr(tO).padStart(16));

      console.log(`\n  ${inr(tP)} has already been paid out as GST to hubs that cannot remit it.`);
      console.log(`  ${inr(tO)} is still owed and can be corrected before it leaves.`);
      console.log('\n  Re-run with --csv for the invoice-by-invoice detail.');
    }

    // The blind spot named in the header — hubs whose registration state is
    // suspect, whose older invoices this report cannot see.
    const suspect = (await client.query(`
      SELECT h.id, h.hub_code, h.hub_name,
             (SELECT COUNT(*)::int FROM purchase_invoices p WHERE p.hub_id = h.id) AS invoices
        FROM hubs h
       WHERE h.deleted_at IS NULL
         AND COALESCE(h.has_gst, FALSE) = TRUE
         AND (h.gst_number IS NULL OR TRIM(h.gst_number) = '')
       ORDER BY h.hub_name
    `)).rows;

    if (suspect.length) {
      console.log('\n─── Marked GST-registered but hold no GST number ───');
      console.log('  These are the likeliest misses above: if the flag is wrong, their');
      console.log('  invoices belong in the table and are not counted in the totals.\n');
      for (const h of suspect) {
        console.log(`  ${(h.hub_code ? h.hub_code + ' · ' : '') + h.hub_name}  —  ${h.invoices} purchase invoice(s)`);
      }
    }

    const active = (await client.query(`
      SELECT COUNT(*)::int AS n FROM hubs
       WHERE deleted_at IS NULL AND is_active = TRUE AND COALESCE(has_gst, FALSE) = FALSE
    `)).rows[0].n;
    console.log(`\n─── Going forward ───`);
    console.log(`  ${active} active hub(s) are not GST-registered. Until the fix ships,`);
    console.log(`  every new job they complete adds GST to their payout.\n`);

  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('[report] Failed:', err.message);
  process.exit(1);
});
