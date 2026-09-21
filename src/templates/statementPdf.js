'use strict';

/**
 * The statement of account, as a printable page.
 *
 * ══ WHY THIS DOES NOT GO THROUGH documentAdapter ═══════════════════════════
 *
 * Every other PDF in this system is a tax document, so it runs through
 * documentAdapter and one of seven themes to get GST breakups, HSN columns,
 * place of supply and a signature block.
 *
 * A statement is none of those things. It is not a tax document, it carries no
 * tax of its own, and it summarises documents that each already did that work.
 * Pushing it through the theme machinery would mean teaching seven templates
 * about a document that needs none of what they do, and every future theme
 * change would have to consider a case it has no business knowing about.
 *
 * So it renders standalone, borrowing only the company's identity and accent
 * colour so it still looks like it came from the same place.
 */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const money = (n) => Number(n || 0).toLocaleString('en-IN',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dmy = (v) => {
  if (!v) return '';
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
};

/* A zero-value document is still a document. Leaving both money cells empty
   made three real invoices look like a rendering fault in the very first
   statement this produced, so a row prints 0.00 in the column it belongs to
   and stays blank in the other. */
function cell(row, side) {
  const v = Number(row[side] || 0);
  if (v) return money(v);
  return row.col === side ? money(0) : '';
}

const TYPE_LABEL = {
  opening: 'Opening', invoice: 'Invoice', payment: 'Payment',
  credit_note: 'Credit note', debit_note: 'Debit note',
  refund: 'Refund', purchase_invoice: 'Purchase invoice',
};

/**
 * @param {object} ledger  the response from ledger.controller
 * @param {object} company company_settings row
 * @param {object} opts    { accent }
 */
function statementHtml(ledger, company, opts = {}) {
  const { party, rows, totals, ageing } = ledger;
  const accent = opts.accent || company?.invoice_accent_color || '#16b994';
  const isCustomer = party.type === 'customer';

  /* "Customer owes" beats "Closing balance Dr" on a document that goes to
     somebody who does not read ledgers for a living. The Dr/Cr stays in the
     table for whoever does. */
  const owing = totals.closing_direction === (isCustomer ? 'dr' : 'cr');
  const closingLabel = isCustomer
    ? (owing ? 'Amount due from customer' : 'Amount in credit')
    : (owing ? 'Amount payable to hub' : 'Overpaid');

  /* clean() strips a trailing comma: company_settings.state holds "Gujarat,"
     in the live data, and a stray comma on a document sent to a customer is
     the kind of thing they notice and nobody ever fixes. */
  const clean = (v) => String(v ?? '').trim().replace(/[,;]+$/, '').trim();
  const companyAddr = [company?.address_line1, company?.address_line2,
    [clean(company?.city), clean(company?.pincode)].filter(Boolean).join(' '),
    clean(company?.state)]
    .map(clean).filter(Boolean).map(esc).join('<br>');

  const rowsHtml = rows.map(r => `
    <tr class="${r.type === 'opening' ? 'op' : ''}">
      <td class="d">${esc(dmy(r.date))}</td>
      <td class="r">${esc(r.ref)}</td>
      <td>${esc(r.particulars)}</td>
      <td class="n">${cell(r, 'debit')}</td>
      <td class="n">${cell(r, 'credit')}</td>
      <td class="n b">${money(r.balance)} <span class="dc">${esc(r.balance_direction.toUpperCase())}</span></td>
    </tr>`).join('');

  const ageingHtml = (ageing && owing && totals.closing > 0.011) ? `
    <div class="ageing">
      <span class="ageing-label">Age of the amount due</span>
      ${[['Current', ageing.current], ['31&ndash;60 days', ageing.d30],
         ['61&ndash;90 days', ageing.d60], ['Over 90 days', ageing.d90plus]]
        .map(([k, v]) => `<div class="age${v > 0 ? ' on' : ''}"><span>${k}</span><strong>${v > 0 ? '&#8377;' + money(v) : '&mdash;'}</strong></div>`)
        .join('')}
    </div>` : '';

  /* Named on the document rather than left implicit. A statement that shows a
     customer two different names for themselves needs to say why. */
  const namesNote = (party.names?.length > 1)
    ? `<p class="note">This account has been invoiced under ${party.names.length} names: ${esc(party.names.join(', '))}.</p>`
    : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  /* Arial leads deliberately. This is rendered by headless Chromium on a
     Linux server, where -apple-system and Segoe UI never resolve and the
     stack fell through to Arial anyway — so the output is unchanged. But the
     bundled invoice fonts are registered under the FIRST name in each stack
     (see templates/fonts/index.js), so a stack that starts with a name we
     don't ship silently gets the host's fonts instead of ours. */
  body { font-family: Arial, Helvetica, sans-serif;
         color: #1a2433; font-size: 9.5pt; margin: 0; -webkit-print-color-adjust: exact; }
  .head { display: flex; justify-content: space-between; align-items: flex-start;
          border-bottom: 2.5pt solid ${esc(accent)}; padding-bottom: 7mm; margin-bottom: 6mm; }
  .co h1 { margin: 0 0 1.5mm; font-size: 15pt; font-weight: 800; letter-spacing: -0.3pt; }
  .co p  { margin: 0; font-size: 8pt; color: #5b6878; line-height: 1.45; }
  .co .gst { margin-top: 1.5mm; font-weight: 700; color: #1a2433; }
  .title { text-align: right; }
  .title h2 { margin: 0; font-size: 13pt; font-weight: 800; color: ${esc(accent)}; letter-spacing: -0.2pt; }
  .title p  { margin: 1.5mm 0 0; font-size: 8pt; color: #5b6878; }

  .party { background: #f5f7fa; border-radius: 2mm; padding: 4mm 5mm; margin-bottom: 5mm;
           display: flex; justify-content: space-between; align-items: flex-start; gap: 8mm; }
  .party h3 { margin: 0 0 1mm; font-size: 11pt; font-weight: 800; }
  .party p  { margin: 0; font-size: 8pt; color: #5b6878; }
  .closing { text-align: right; white-space: nowrap; }
  .closing span  { display: block; font-size: 7.5pt; font-weight: 700; color: #5b6878;
                   text-transform: uppercase; letter-spacing: 0.4pt; margin-bottom: 1mm; }
  .closing strong { font-size: 16pt; font-weight: 800; letter-spacing: -0.4pt;
                    color: ${esc(accent)}; }

  .note { font-size: 7.5pt; color: #7a8698; margin: 0 0 4mm; font-style: italic; }

  .ageing { display: flex; gap: 3mm; align-items: center; margin-bottom: 5mm; flex-wrap: wrap; }
  .ageing-label { font-size: 7.5pt; font-weight: 700; color: #5b6878;
                  text-transform: uppercase; letter-spacing: 0.4pt; }
  .age { border: 0.4pt solid #dfe5ec; border-radius: 1.5mm; padding: 1.5mm 3mm; min-width: 22mm; }
  .age span   { display: block; font-size: 7pt; color: #7a8698; }
  .age strong { display: block; font-size: 9pt; color: #9aa5b4; }
  .age.on strong { color: #1a2433; }

  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }   /* repeat the header on every page */
  th { font-size: 7.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4pt;
       color: #5b6878; background: #f5f7fa; padding: 2.5mm 3mm; text-align: left;
       border-bottom: 0.6pt solid #dfe5ec; }
  td { padding: 2.2mm 3mm; border-bottom: 0.4pt solid #eef1f5; vertical-align: top; }
  tr { page-break-inside: avoid; }
  .n  { text-align: right; white-space: nowrap; }
  .b  { font-weight: 700; }
  .d  { white-space: nowrap; color: #5b6878; }
  .r  { font-weight: 700; white-space: nowrap; }
  .dc { font-size: 7pt; color: #7a8698; font-weight: 700; }
  tr.op td { background: #fafbfc; font-style: italic; }

  tfoot td { border-top: 1.2pt solid #1a2433; border-bottom: 0; padding-top: 3mm;
             font-weight: 800; font-size: 10pt; }

  .foot { margin-top: 7mm; padding-top: 4mm; border-top: 0.4pt solid #dfe5ec;
          font-size: 7.5pt; color: #7a8698; line-height: 1.5; }
  </style></head><body>

  <div class="head">
    <div class="co">
      <h1>${esc(company?.company_name || 'Statement')}</h1>
      <p>${companyAddr}</p>
      ${company?.gstin ? `<p class="gst">GSTIN ${esc(company.gstin)}</p>` : ''}
    </div>
    <div class="title">
      <h2>Statement of Account</h2>
      <p>Generated ${esc(dmy(new Date().toISOString().slice(0, 10)))}</p>
      <p>${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}</p>
    </div>
  </div>

  <div class="party">
    <div>
      <h3>${esc(party.name)}</h3>
      <p>
        ${party.mobile ? esc(party.mobile) : ''}${party.mobile && party.gstin ? ' &middot; ' : ''}
        ${party.gstin ? 'GSTIN ' + esc(party.gstin) : ''}
      </p>
    </div>
    <div class="closing">
      <span>${closingLabel}</span>
      <strong>&#8377;${money(totals.closing)}</strong>
    </div>
  </div>

  ${namesNote}
  ${ageingHtml}

  <table>
    <thead><tr>
      <th>Date</th><th>Reference</th><th>Particulars</th>
      <th class="n">Debit</th><th class="n">Credit</th><th class="n">Balance</th>
    </tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="6" style="padding:12mm;text-align:center;color:#7a8698">Nothing on this account.</td></tr>'}</tbody>
    <tfoot><tr>
      <td colspan="3">Total</td>
      <td class="n">${money(totals.debit)}</td>
      <td class="n">${money(totals.credit)}</td>
      <td class="n">&#8377;${money(totals.closing)} <span class="dc">${esc(totals.closing_direction.toUpperCase())}</span></td>
    </tr></tfoot>
  </table>

  <div class="foot">
    This statement is assembled from issued documents and carries no tax of its own &mdash;
    the GST on each transaction is shown on the invoice or credit note it came from.
    Please report any discrepancy within 7 days.
  </div>
  </body></html>`;
}

module.exports = { statementHtml, TYPE_LABEL };
