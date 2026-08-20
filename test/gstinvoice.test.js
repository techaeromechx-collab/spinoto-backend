/**
 * The purchase invoice as the hub's GST document:
 *   - supplier is the hub, recipient is the company
 *   - tax split from the hub's state, not the company's
 *   - unregistered hub → Bill of Supply, no tax anywhere
 *   - snapshot beats the live join
 *   - hub number used when present, old SI- form when not
 */
const path = require('path'); const assert = require('assert');
const ROOT = require('path').resolve(__dirname, '..') + '/src';
for (const [f,e] of Object.entries({
  [path.join(ROOT,'config/db.js')]: { pool:{ query:async()=>({rows:[],rowCount:0}) } },
  [path.join(ROOT,'socket.js')]:    { getIO:()=>({emit(){}}) },
})) require.cache[f] = { id:f, filename:f, loaded:true, exports:e };

const { buildDocument } = require(path.join(ROOT,'templates/documentAdapter.js'));
const { resolveDocumentConfig } = require(path.join(ROOT,'utils/documentConfig.js'));

const COMPANY = {
  company_name:'Spinoto Auto Pvt Ltd', address_line1:'12 MG Road', city:'Ahmedabad',
  state:'Gujarat', pincode:'380015', gstin:'24AAAAA0000A1Z5', invoice_accent_color:'#4f46e5',
  document_config:{}, invoice_theme:'simple',
};
const ITEM = { description:'Full service', quantity:1, hub_rate:1000, gst_percent:18, gst_amount:180, total_payable:1180, item_type:'service' };
const base = over => ({
  id:123, hub_id:3, hub_name:'QuickFix Auto Hub', invoice_date:'2026-08-11',
  created_at:'2026-08-11T00:00:00Z', subtotal_ex_gst:1000, total_gst:180, grand_total:1180,
  amount_paid:0, items:[ITEM], hub_payments:[], status:'approved',
  hub_legal_name:'QuickFix Automotive LLP', hub_address:'7 Ring Road\nAhmedabad, Gujarat, 380054',
  hub_gstin:'24BBBBB1111B1Z5', hub_has_gst:true, supplier_state_code:'24',
  ...over,
});
const build = (row, role='hub') =>
  buildDocument('purchase_invoice', row, COMPANY, resolveDocumentConfig(COMPANY.document_config, 'purchase_invoice', role));

let n = 0;
// ── 1. parties are the right way round, in BOTH views ──
for (const role of ['hub','admin']) {
  const d = build(base(), role);
  assert.strictEqual(d.seller.name, 'QuickFix Automotive LLP', `${role}: hub must head the page`);
  assert.strictEqual(d.seller.gstin, '24BBBBB1111B1Z5', `${role}: supplier GSTIN`);
  assert.ok(d.seller.address.join(' ').includes('Ring Road'), `${role}: supplier address`);
  assert.strictEqual(d.buyer.name, 'Spinoto Auto Pvt Ltd', `${role}: company must be bill-to`);
  assert.strictEqual(d.buyer.gstin, '24AAAAA0000A1Z5', `${role}: recipient GSTIN`);
  assert.strictEqual(d.seller.logoUrl, null, `${role}: company logo must not head a hub invoice`);
  n += 6;
}

// ── 2. tax split follows the HUB's state ──
const guj = build(base({ hub_gstin:'24BBBBB1111B1Z5', supplier_state_code:'24' }));
assert.deepStrictEqual(guj.gstBreakup.lines.map(g=>g.key).sort(), ['cgst','sgst'], 'Gujarat hub → CGST+SGST');
const mah = build(base({ hub_gstin:'27CCCCC2222C1Z5', supplier_state_code:'27' }));
assert.deepStrictEqual(mah.gstBreakup.lines.map(g=>g.key), ['igst'], 'Maharashtra hub → IGST');
assert.strictEqual(
  guj.gstBreakup.lines.reduce((s,g)=>s+g.amount,0).toFixed(2),
  mah.gstBreakup.lines.reduce((s,g)=>s+g.amount,0).toFixed(2),
  'total tax identical either way — only the heads move');
n += 3;

// ── 3. unregistered hub → Bill of Supply ──
const bos = build(base({ hub_has_gst:false, hub_gstin:null }));
assert.strictEqual(bos.title, 'BILL OF SUPPLY');
assert.deepStrictEqual(bos.gstBreakup.lines, [], 'no tax breakup');
assert.strictEqual(bos.seller.gstin, '', 'no GSTIN on a bill of supply');
assert.ok(!bos.totals.some(t=>t.key==='gst'), 'GST row dropped, not zeroed');
assert.ok(bos.blocks.declarations.some(d=>/not registered under GST/i.test(d)), 'declaration present');
n += 5;

// ── 4. registered hub keeps the tax invoice ──
const ti = build(base());
assert.notStrictEqual(ti.title, 'BILL OF SUPPLY');
assert.ok(ti.totals.some(t=>t.key==='gst'));
assert.ok(ti.blocks.declarations.some(d=>/reverse charge/i.test(d)), 'reverse-charge line mandatory');
assert.ok(ti.blocks.declarations.some(d=>/self-billed/i.test(d)), 'self-billing disclosed');
assert.strictEqual(ti.blocks.signatureUrl, null, "company signature must not sign the hub's invoice");
n += 5;

// ── 5. snapshot beats the live join ──
const moved = build(base({ hub_legal_name:'Old Name LLP', hub_name:'New Branch Name', hub_full_name:'New Legal Name' }));
assert.strictEqual(moved.seller.name, 'Old Name LLP', 'frozen supplier name wins over the live hub row');
n++;

// ── 6. numbering ──
assert.strictEqual(build(base({ invoice_number:'QAH/25-26/0007' })).number, 'QAH/25-26/0007');
assert.strictEqual(build(base()).number, 'SI-000123', 'pre-series invoice keeps its old number');
n += 2;

// ── 7. pre-migration rows (NULL snapshot) must not become bills of supply ──
const legacy = build(base({ hub_has_gst:null, hub_gstin:null, hub_gst:'24BBBBB1111B1Z5', hub_legal_name:null, hub_full_name:'QuickFix Auto Hub' }));
assert.notStrictEqual(legacy.title, 'BILL OF SUPPLY', 'NULL snapshot must keep today’s behaviour');
assert.strictEqual(legacy.seller.gstin, '24BBBBB1111B1Z5', 'falls back to the live hub GSTIN');
n += 2;

// ── 8. margin stays admin-only ──
assert.strictEqual(build(base(),'hub').showMargin, false, 'hub must never see margin columns');
n++;

console.log(`purchase invoice as GST document: ${n} checks passed`);
