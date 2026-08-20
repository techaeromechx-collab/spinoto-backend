'use strict';

/**
 * notifyWhatsApp — the ONLY function that queues a customer WhatsApp message.
 *
 * Five call sites will eventually use it (appointment create, two status
 * transitions, invoice issue, and the manual send button). They all go through
 * here for the same reason resolveVehicle() exists in the vehicle-profile plan:
 * five controllers each deciding what a send is will eventually disagree, and
 * the disagreement is only visible to customers.
 *
 * ── It queues. It does not send. ─────────────────────────────────────────────
 *
 * This writes one `queued` row to wa_messages and returns. The outbox worker
 * (whatsappOutbox.service.js) does the sending, later, off the request path.
 *
 * The row is written on the CALLER'S transaction client, so it commits or rolls
 * back with the status change that caused it. That is what makes "the
 * appointment saved but the message vanished" — and its mirror, "we told the
 * customer their car is ready and then the transaction rolled back" —
 * impossible rather than unlikely.
 *
 * ── It never throws ──────────────────────────────────────────────────────────
 *
 * Callers are inside a transaction that is doing something more important than
 * messaging. A template that is disabled, a customer with no WhatsApp number, a
 * hub with no map link — none of those should abort saving an appointment. Each
 * returns a { queued: false, reason } and the caller carries on.
 */

const { resolveTarget, toE164 } = require('../utils/phone');

/**
 * Format a YYYY-MM-DD date the way a customer reads it.
 * "31 December 2026", not "2026-12-31" — this goes in a WhatsApp message, not
 * a log line.
 */
function fmtDate(v) {
  if (!v) return null;
  const d = new Date(`${String(v).slice(0, 10)}T00:00:00`);
  if (isNaN(d)) return null;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** "14:30" → "2:30 PM". */
function fmtTime(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let h = Number(m[1]);
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${suffix}`;
}

/**
 * Load the active, enabled template for an event.
 *
 * `requireAuto` is false for manual sends — an advisor pressing the button on a
 * record should not need auto-send switched on, which is a statement about
 * automation rather than about whether the template may be used at all.
 */
async function loadTemplate(client, templateKey, { requireAuto, languageCode }) {
  // The unique index is (template_key, language_code) WHERE is_active, so
  // several active rows per key are legal by design — an 'en' and an 'en_US'
  // are different templates to Meta, not variants of one. Without the language
  // filter and the ORDER BY, which one a customer received would be whatever
  // the planner happened to return first.
  const r = await client.query(
    `SELECT id, template_key, provider_template_name, language_code,
            variables, header_variables, is_enabled, auto_send
       FROM wa_templates
      WHERE template_key = $1 AND is_active
        AND ($2::text IS NULL OR language_code = $2)
      ORDER BY (language_code = 'en') DESC, id
      LIMIT 1`,
    [templateKey, languageCode || null]
  );
  const t = r.rows[0];
  if (!t) return { t: null, reason: 'no_such_template' };
  if (!t.is_enabled) return { t: null, reason: 'template_disabled' };
  if (requireAuto && !t.auto_send) return { t: null, reason: 'auto_send_off' };
  return { t, reason: null };
}

/**
 * Everything an appointment-driven template can need, in one query.
 *
 * Deliberately one round trip rather than a helper per variable: the dispatcher
 * runs inside somebody else's transaction, and holding it open for six
 * sequential lookups would extend a lock for the sake of tidiness.
 */
const APPT_CONTEXT = `
  SELECT
    a.id, a.customer_name, a.mobile, a.whatsapp, a.vehicle_number, a.hub_id,
    TO_CHAR(a.scheduled_date, 'YYYY-MM-DD') AS scheduled_date,
    a.scheduled_time,
    mk.name AS make_name,
    md.name AS model_name,
    h.map_url AS hub_map_url,
    h.hub_name,
    (SELECT string_agg(s.name, ', ' ORDER BY s.name)
       FROM appointment_services aps
       JOIN services s ON s.id = aps.service_id
      WHERE aps.appointment_id = a.id) AS service_names,
    -- The appointment's own invoice, so an appointment-driven send can carry
    -- invoice_link. APPROVED OR LATER ONLY — a 'generated' invoice is still
    -- internal and editable, and invoice_ready deliberately fires on approval
    -- for exactly that reason; a status trigger must not leak a draft link
    -- earlier than the approval flow would. No approved invoice → NULL →
    -- the dispatcher refuses with missing_variable:invoice_link, which is a
    -- visible answer rather than a blank line in a customer message.
    (SELECT ci.public_token
       FROM customer_invoices ci
      WHERE ci.appointment_id = a.id
        AND ci.status IN ('approved', 'partially_paid', 'paid')
      ORDER BY ci.id DESC
      LIMIT 1) AS invoice_public_token,
    -- The appointment's own ESTIMATE, same reasoning as the invoice above:
    -- an appointment-driven send can then carry estimate_amount and
    -- estimate_link. Only estimates the CUSTOMER may already see —
    -- 'sent_to_customer' onward (the same set estimates.controller treats as
    -- advanceable). A pending_company_review draft must not leak: the public
    -- page would refuse it and the price on it is nobody's promise yet.
    -- Two subselects with identical predicates deliberately pick the SAME row.
    (SELECT e.public_token
       FROM estimates e
      WHERE e.appointment_id = a.id
        AND e.status IN ('sent_to_customer', 'partially_approved',
                         'fully_approved', 'work_in_progress')
      ORDER BY e.id DESC
      LIMIT 1) AS estimate_public_token,
    (SELECT e.grand_total
       FROM estimates e
      WHERE e.appointment_id = a.id
        AND e.status IN ('sent_to_customer', 'partially_approved',
                         'fully_approved', 'work_in_progress')
      ORDER BY e.id DESC
      LIMIT 1) AS estimate_grand_total
  FROM appointments a
  LEFT JOIN vehicle_makes  mk ON mk.id = a.make_id
  LEFT JOIN vehicle_models md ON md.id = a.model_id
  LEFT JOIN hubs           h  ON h.id  = a.hub_id
  WHERE a.id = $1
`;

/**
 * Leads carry far less than an appointment — no vehicle registration, no
 * scheduled time, no hub. That is fine: the only lead-driven template is
 * "Call Not Received", which needs a name and a number.
 *
 * make/model are joined anyway so `vehicle` resolves when the lead captured it,
 * which keeps the door open for a future lead template without another query.
 */
const LEAD_CONTEXT = `
  SELECT
    l.id, l.name AS customer_name, l.mobile, l.whatsapp,
    mk.name AS make_name,
    md.name AS model_name,
    NULL::int AS hub_id
  FROM leads l
  LEFT JOIN vehicle_makes  mk ON mk.id = l.make_id
  LEFT JOIN vehicle_models md ON md.id = l.model_id
  WHERE l.id = $1
`;

const ESTIMATE_CONTEXT = `
  SELECT
    e.id, e.public_token, e.hub_id, e.grand_total,
    COALESCE(e.customer_name, a.customer_name) AS customer_name,
    COALESCE(e.mobile,        a.mobile)        AS mobile,
    a.whatsapp,
    COALESCE(e.vehicle_number, a.vehicle_number) AS vehicle_number,
    mk.name AS make_name,
    md.name AS model_name
  FROM estimates e
  LEFT JOIN appointments   a  ON a.id = e.appointment_id
  LEFT JOIN vehicle_makes  mk ON mk.id = COALESCE(a.make_id, e.make_id)
  LEFT JOIN vehicle_models md ON md.id = COALESCE(a.model_id, e.model_id)
  WHERE e.id = $1
`;

const INVOICE_CONTEXT = `
  SELECT
    ci.id, ci.public_token, ci.hub_id,
    COALESCE(ci.customer_name, a.customer_name) AS customer_name,
    COALESCE(ci.mobile,        a.mobile)        AS mobile,
    a.whatsapp,
    ci.grand_total
  FROM customer_invoices ci
  LEFT JOIN appointments a ON a.id = ci.appointment_id
  WHERE ci.id = $1
`;


/**
 * An advance receipt. The entity is the LEDGER PAYMENT, not the estimate — one
 * job can take two advances and each has its own numbered voucher, so keying
 * the message on the estimate would make the second one look like a duplicate
 * of the first and never send it.
 */
const ADVANCE_CONTEXT = `
  SELECT
    p.id, p.public_token, p.hub_id, p.amount, p.voucher_no,
    -- ── ON-ACCOUNT PAYMENTS RESOLVE TOO ────────────────────────────────────
    -- Money taken with no job has no estimate and no appointment, so the first
    -- two terms are both NULL and this used to come back blank — the customer
    -- would have received a receipt addressed to nobody. The profile is the
    -- third source and the only one that always exists for a known mobile.
    COALESCE(e.customer_name, a.customer_name,
             NULLIF(TRIM(cp.display_name), '')) AS customer_name,
    COALESCE(p.mobile, e.mobile, a.mobile)     AS mobile,
    a.whatsapp,
    COALESCE(p.vehicle_number, e.vehicle_number, a.vehicle_number) AS vehicle_number,
    vm.name   AS make_name,
    vmod.name AS model_name,
    -- What is left to pay after this receipt. Two different questions depending
    -- on what the money was for, and both have to have an answer:
    --
    --   against an ESTIMATE  → what is left on that job. The customer's next
    --                          question, and the number the receipt is about.
    --   ON ACCOUNT           → there is no job, so the honest figure is what
    --                          they still owe across their open invoices. NULL
    --                          would render an empty variable in a WhatsApp
    --                          template, which reads as a broken message.
    --
    -- COALESCE on the whole estimate branch rather than on grand_total alone:
    -- "NULL - 0" is NULL, so a missing estimate poisons the subtraction before
    -- any fallback inside it could apply.
    COALESCE(
      (e.grand_total - COALESCE((
         SELECT SUM(p2.amount) FROM customer_invoice_payments p2
          WHERE p2.estimate_id = p.estimate_id AND p2.payment_type = 'advance'
       ), 0)),
      (SELECT COALESCE(SUM(ci.grand_total - COALESCE(ci.amount_paid, 0)), 0)
         FROM customer_invoices ci
        WHERE ci.mobile = p.mobile AND ci.status <> 'cancelled'),
      0
    ) AS balance_due
  FROM customer_invoice_payments p
  LEFT JOIN estimates      e    ON e.id   = p.estimate_id
  LEFT JOIN appointments   a    ON a.id   = COALESCE(p.appointment_id, e.appointment_id)
  LEFT JOIN vehicle_makes  vm   ON vm.id  = COALESCE(a.make_id, e.make_id)
  LEFT JOIN vehicle_models vmod ON vmod.id = COALESCE(a.model_id, e.model_id)
  LEFT JOIN customer_profiles cp ON cp.mobile = p.mobile
  WHERE p.id = $1 AND p.payment_type = 'advance'
`;

/**
 * A payment recorded AGAINST AN INVOICE — the counter/gateway "we received
 * your money" receipt. The entity is the LEDGER PAYMENT row, same reasoning as
 * ADVANCE_CONTEXT above: two part-payments on one invoice are two receipts,
 * so keying on the invoice would make the second look like a duplicate.
 *
 * Advances are EXCLUDED here (payment_type <> 'advance') — they have their own
 * template with a voucher number and receipt link, and matching them from both
 * contexts would message the customer twice for one act.
 *
 * balance_due reads the invoice's amount_paid cache, which is safe because the
 * fire sites queue AFTER recalcInvoiceState on the same transaction client —
 * the cache is fresh by construction. NULL invoice (should not happen for a
 * non-advance row) leaves balance_due NULL, which correctly blocks the send.
 */
const PAYMENT_CONTEXT = `
  SELECT
    p.id, p.hub_id, p.amount,
    COALESCE(ci.customer_name, a.customer_name,
             NULLIF(TRIM(cp.display_name), '')) AS customer_name,
    COALESCE(p.mobile, ci.mobile, a.mobile)     AS mobile,
    a.whatsapp,
    ci.public_token,
    (ci.grand_total - COALESCE(ci.amount_paid, 0)) AS balance_due
  FROM customer_invoice_payments p
  LEFT JOIN customer_invoices ci ON ci.id = p.customer_invoice_id
  LEFT JOIN appointments     a  ON a.id = COALESCE(p.appointment_id, ci.appointment_id)
  LEFT JOIN customer_profiles cp ON cp.mobile = p.mobile
  WHERE p.id = $1 AND COALESCE(p.payment_type, '') <> 'advance'
`;

/**
 * Turn a context row into the canonical variable bag.
 *
 * Anything unresolvable stays undefined rather than becoming '' — the caller
 * below refuses to queue a message with a missing variable, and an empty string
 * would slip past that check and reach the customer as a blank line.
 */
function buildValues(kind, row, { publicAppUrl }) {
  if (kind === 'appointment') {
    const vehicle = [row.make_name, row.model_name].filter(Boolean).join(' ') || null;
    return {
      customer_name: row.customer_name || null,
      vehicle,
      reg_number:    row.vehicle_number || null,
      date:          fmtDate(row.scheduled_date),
      time:          fmtTime(row.scheduled_time),
      service_type:  row.service_names || null,
      workshop_link: row.hub_map_url || null,
      // The appointment's APPROVED invoice, resolved by the context query.
      // Same /invoice/<token> URL invoice_ready sends; null (blocking the
      // send) when there is no approved invoice yet or PUBLIC_APP_URL is
      // unset — never a link to a draft or to nowhere.
      invoice_link: (publicAppUrl && row.invoice_public_token)
        ? `${publicAppUrl}/invoice/${row.invoice_public_token}`
        : null,
      // The appointment's customer-visible estimate, same rules: null blocks
      // the send rather than linking a draft or a dead URL.
      estimate_amount: row.estimate_grand_total != null
        ? String(row.estimate_grand_total)
        : null,
      estimate_link: (publicAppUrl && row.estimate_public_token)
        ? `${publicAppUrl}/estimate/${row.estimate_public_token}`
        : null,
    };
  }

  if (kind === 'estimate') {
    return {
      customer_name: row.customer_name || null,
      vehicle: [row.make_name, row.model_name].filter(Boolean).join(' ') || null,
      reg_number: row.vehicle_number || null,
      estimate_amount: row.grand_total != null ? String(row.grand_total) : null,
      // Same URL the printed estimate's QR encodes. Null when PUBLIC_APP_URL is
      // unset, which correctly blocks the send rather than messaging a customer
      // a link to nowhere.
      estimate_link: (publicAppUrl && row.public_token)
        ? `${publicAppUrl}/estimate/${row.public_token}`
        : null,
    };
  }

  if (kind === 'advance') {
    return {
      customer_name: row.customer_name || null,
      // The receipt number, because that is what the customer quotes back when
      // they ring up about it.
      voucher_no: row.voucher_no || null,
      amount: row.amount != null ? String(Number(row.amount).toFixed(2)) : null,
      balance_due: row.balance_due != null ? String(Number(row.balance_due).toFixed(2)) : null,
      // Same URL the printed voucher's QR encodes and the public route serves.
      // Null when PUBLIC_APP_URL is unset, which correctly blocks the send
      // rather than messaging a customer a link to nowhere.
      receipt_link: (publicAppUrl && row.public_token)
        ? `${publicAppUrl}/advance/${row.public_token}`
        : null,
    };
  }

  if (kind === 'payment') {
    return {
      customer_name: row.customer_name || null,
      amount: row.amount != null ? String(Number(row.amount).toFixed(2)) : null,
      // What is still owed on the invoice AFTER this payment. Zero is a real
      // and welcome value ("balance due: ₹0.00"); only NULL — no invoice to
      // read it from — blocks the send.
      balance_due: row.balance_due != null ? String(Number(row.balance_due).toFixed(2)) : null,
      // Same public URL invoice_ready sends. Null when PUBLIC_APP_URL is
      // unset, which correctly blocks the send rather than messaging a
      // customer a link to nowhere.
      invoice_link: (publicAppUrl && row.public_token)
        ? `${publicAppUrl}/invoice/${row.public_token}`
        : null,
    };
  }

  if (kind === 'lead') {
    return {
      customer_name: row.customer_name || null,
      vehicle: [row.make_name, row.model_name].filter(Boolean).join(' ') || null,
    };
  }

  if (kind === 'invoice') {
    return {
      customer_name: row.customer_name || null,
      amount:        row.grand_total != null ? String(row.grand_total) : null,
      // Same URL the printed QR encodes and the public route serves. Null when
      // PUBLIC_APP_URL is unset — which correctly blocks the send rather than
      // messaging a customer a link to nowhere.
      //
      // /invoice/, not /customer-invoices/. The older path shares its address
      // with a staff deep link, so what it shows depends on whether the person
      // opening it happens to be signed in — a hub session following it lands
      // on /hub. /invoice/<token> is public unconditionally and means the same
      // thing to everyone. The old path still redirects here, so links already
      // sent and QR codes already printed keep working.
      invoice_link:  (publicAppUrl && row.public_token)
        ? `${publicAppUrl}/invoice/${row.public_token}`
        : null,
    };
  }

  return {};
}

/**
 * A stable description of the parts of a template that decide what actually
 * gets sent: the provider's template name, the language, and the ordered
 * variable mapping.
 *
 * Not a hash. A hash would be shorter and would make a mismatch impossible to
 * explain — this string appears in a log line and in the failure message, and
 * "invoice_ | en | customer_name,invoice_link" tells whoever reads it exactly
 * what changed.
 */
function templateFingerprint(t) {
  const body = Array.isArray(t.variables) ? t.variables : [];
  const header = Array.isArray(t.header_variables) ? t.header_variables : [];
  return [
    t.provider_template_name || '',
    t.language_code || '',
    body.join(','),
    header.join(','),
  ].join(' | ');
}

/**
 * notifyWhatsApp(client, { templateKey, entityType, entityId, dedupeKey, … })
 *
 * @param {object} client    An in-transaction pg client. NOT the pool — the
 *                           queued row must live or die with the caller's work.
 * @returns {Promise<{queued: boolean, reason?: string, id?: number}>}
 */
async function notifyWhatsApp(client, {
  templateKey,
  entityType,
  entityId,
  dedupeKey,
  manual = false,
  sentBy = null,
  overrideTo = null,
  languageCode = null,
}) {
  // ── SAVEPOINT, and why it is not optional ────────────────────────────────
  //
  // Every query below runs on the CALLER'S transaction. Postgres puts a
  // transaction into an aborted state (25P02) on ANY error — a value too long
  // for a column, an FK violation on sent_by, a transient blip. Catching that
  // error and returning {queued:false} would let the caller "carry on" into a
  // transaction where every subsequent statement fails and COMMIT silently
  // degrades to ROLLBACK.
  //
  // The result would be the exact failure this module exists to prevent, in
  // reverse: not "the appointment saved but the message vanished", but "the
  // message failed so the appointment did not save".
  //
  // The savepoint makes the swallow honest — rolling back to it discards only
  // our own work and leaves the caller's transaction usable.
  const SP = 'wa_notify';
  await client.query(`SAVEPOINT ${SP}`);

  try {
    const { t, reason } = await loadTemplate(client, templateKey, {
      requireAuto: !manual, languageCode,
    });
    if (!t) return { queued: false, reason };

    // Context
    let kind = null;
    let sql = null;
    if (entityType === 'appointment')      { kind = 'appointment'; sql = APPT_CONTEXT; }
    else if (entityType === 'invoice')     { kind = 'invoice';     sql = INVOICE_CONTEXT; }
    else if (entityType === 'lead')        { kind = 'lead';        sql = LEAD_CONTEXT; }
    else if (entityType === 'estimate')    { kind = 'estimate';    sql = ESTIMATE_CONTEXT; }
    else if (entityType === 'advance')     { kind = 'advance';     sql = ADVANCE_CONTEXT; }
    else if (entityType === 'payment')     { kind = 'payment';     sql = PAYMENT_CONTEXT; }
    else return { queued: false, reason: 'unsupported_entity' };

    const ctx = (await client.query(sql, [entityId])).rows[0];
    if (!ctx) return { queued: false, reason: 'entity_not_found' };

    const publicAppUrl = (process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
    const values = buildValues(kind, ctx, { publicAppUrl });

    // Destination. resolveTarget prefers the dedicated WhatsApp number and
    // falls back to the mobile — and says which it used, because "we messaged
    // the mobile because no WhatsApp number was set" is a support answer and
    // silently doing it is a mystery.
    // overrideTo goes through toE164 like everything else. It used to be written
    // verbatim, which skipped both the validity check ('NA' and landlines would
    // pass a truthiness test) and the normalisation — and Interakt upserts its
    // contacts BY PHONE NUMBER, so an unnormalised one splits a customer into
    // two contacts each holding half the conversation.
    const target = overrideTo
      ? { number: toE164(overrideTo), source: 'override' }
      : resolveTarget({ whatsapp: ctx.whatsapp, mobile: ctx.mobile });
    if (!target.number) return { queued: false, reason: 'no_messageable_number' };

    // Resolve in the registry's order — position IS the contract.
    const order = Array.isArray(t.variables) ? t.variables : [];
    const headerOrder = Array.isArray(t.header_variables) ? t.header_variables : [];
    // Header variables are checked for completeness alongside the body ones.
    // They were previously loaded and then dropped, which meant any template
    // with a header would be rejected by Interakt on a value-count mismatch —
    // permanently, since that is a 4xx, with no code path that could fix it.
    const bodyValues = [...order, ...headerOrder].map(k => values[k]);

    // Refuse rather than send a gap.
    //
    // The common real case is a hub with no map_url: the appointment message
    // would go out reading "📍 Workshop Location:" with nothing after it. A
    // message that never arrives is recoverable; one that arrives looking
    // broken is not.
    const missingAt = bodyValues.findIndex(v => v === null || v === undefined || v === '');
    if (missingAt !== -1) {
      const allKeys = [...order, ...headerOrder];
      return { queued: false, reason: `missing_variable:${allKeys[missingAt]}` };
    }

    // What the template looked like at THIS moment.
    //
    // claimBatch re-reads the provider name, language and variable order at send
    // time, while the values above are frozen here. That is deliberate for the
    // good case — correcting a bad mapping should fix messages already queued —
    // and dangerous for one specific bad case: an admin changing
    // provider_template_name between queue and send makes this row fire against
    // a DIFFERENT Meta template, carrying values resolved for the old one.
    //
    // Recording the shape lets the worker notice. See migration 149.
    const fingerprint = templateFingerprint(t);

    // Manual sends get a timestamp bucket so an advisor CAN deliberately
    // resend; automatic sends get the caller's transition identity so a status
    // flapping back and forth cannot. Defaulting both to '' made every manual
    // resend collide with the original and return 'duplicate' forever.
    const effectiveDedupe = dedupeKey ?? (manual ? `manual:${Date.now()}` : '');

    // The frozen record of what the customer actually saw. Rebuilt from the
    // preview rather than left NULL — without it, a message log can say which
    // template was used but not what it said, which is the question anyone
    // reading it back is actually asking.
    const bodyRendered = order
      .map((k, i) => `{{${i + 1}}} ${k} = ${values[k]}`)
      .join('\n');

    const r = await client.query(
      `INSERT INTO wa_messages
         (template_id, template_key, direction, entity_type, entity_id,
          to_number, variables, body_rendered, status, sent_by, hub_id,
          dedupe_key, target_source, template_fingerprint, queued_at)
       VALUES ($1, $2, 'out', $3, $4, $5, $6, $7, 'queued', $8, $9, $10, $11, $12, NOW())
       -- The dedupe index is the real guard against a status flapping back and
       -- forth re-sending. Hitting it is a NORMAL outcome, not an error: it
       -- means this exact message was already queued.
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        t.id, t.template_key, entityType, entityId,
        target.number, JSON.stringify(values), bodyRendered,
        manual ? sentBy : null,
        ctx.hub_id || null,
        effectiveDedupe,
        // WHICH field the number came from. phone.js has always returned this
        // and this call has always discarded it — so "that message went to my
        // husband's phone" had no answer beyond a bare +91 number.
        target.source || null,
        fingerprint,
      ]
    );

    await client.query(`RELEASE SAVEPOINT ${SP}`);

    if (!r.rows[0]) return { queued: false, reason: 'duplicate' };
    return { queued: true, id: r.rows[0].id };
  } catch (err) {
    // Discard only OUR work. Without this the caller's transaction is left in
    // Postgres's aborted state and its COMMIT quietly becomes a ROLLBACK — see
    // the savepoint note above.
    await client.query(`ROLLBACK TO SAVEPOINT ${SP}`).catch(() => {});

    // Swallowed on purpose. The caller is saving an appointment or issuing an
    // invoice; a messaging failure must not roll that back. Logged loudly
    // enough to be found, because a silent return here would make "why did no
    // message go out?" unanswerable.
    console.error('[whatsapp] notifyWhatsApp failed:', templateKey, err.message);
    return { queued: false, reason: 'error' };
  }
}

/**
 * Resolve what a template WOULD send for a record, without queueing anything.
 *
 * Backs the preview an advisor sees before a manual send. Not a debug helper:
 * given that Interakt cannot tell us a template's variable order, the preview
 * is the last point at which a human can notice that position 4 is about to
 * carry a registration number where the customer expects a date.
 *
 * Runs on the pool rather than a caller's transaction — it writes nothing.
 */
async function previewWhatsApp(pool, { templateKey, entityType, entityId }) {
  const { t, reason } = await loadTemplate(pool, templateKey, {
    requireAuto: false, languageCode: null,
  });
  if (!t) return { ok: false, reason };

  let kind = null;
  let sql = null;
  if (entityType === 'appointment')  { kind = 'appointment'; sql = APPT_CONTEXT; }
  else if (entityType === 'invoice') { kind = 'invoice';     sql = INVOICE_CONTEXT; }
  else if (entityType === 'lead')    { kind = 'lead';        sql = LEAD_CONTEXT; }
  else if (entityType === 'estimate'){ kind = 'estimate';    sql = ESTIMATE_CONTEXT; }
  else if (entityType === 'advance') { kind = 'advance';     sql = ADVANCE_CONTEXT; }
  else if (entityType === 'payment') { kind = 'payment';     sql = PAYMENT_CONTEXT; }
  else return { ok: false, reason: 'unsupported_entity' };

  const ctx = (await pool.query(sql, [entityId])).rows[0];
  if (!ctx) return { ok: false, reason: 'entity_not_found' };

  const publicAppUrl = (process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
  const values = buildValues(kind, ctx, { publicAppUrl });
  const order = Array.isArray(t.variables) ? t.variables : [];
  // Header variables count too.
  //
  // notifyWhatsApp validates [...order, ...headerOrder] and refuses to queue if
  // any of them is empty. This function only ever looked at t.variables — so a
  // template with a header could preview as complete, missing: [], and then 422
  // on send for a key the preview never displayed.
  //
  // That is the exact hole the preview exists to close: it is the only check
  // between a hand-transcribed mapping and a real customer, and one that omits
  // a whole component is worse than none, because it is trusted.
  const headerOrder = Array.isArray(t.header_variables) ? t.header_variables : [];
  const allKeys = [...order, ...headerOrder];

  const target = resolveTarget({ whatsapp: ctx.whatsapp, mobile: ctx.mobile });

  return {
    ok: true,
    template: {
      id: t.id,
      template_key: t.template_key,
      provider_template_name: t.provider_template_name,
      language_code: t.language_code,
    },
    to: target.number,
    fell_back_to_mobile: !!target.fellBack,
    // Position, key and resolved value — the three things needed to spot a
    // mis-mapping by eye. Nulls are returned as-is rather than blanked, so a
    // missing value is visible as missing.
    // Body positions keep their 1..n numbering, because that is what the
    // advisor compares against the message on their phone. Header values are
    // flagged rather than numbered into the same sequence — they fill a
    // different component and calling one of them {{3}} would be a lie.
    positions: [
      ...order.map((k, i) => ({ position: i + 1, key: k, value: values[k] ?? null })),
      ...headerOrder.map((k, i) => ({
        position: `H${i + 1}`, key: k, value: values[k] ?? null, header: true,
      })),
    ],
    missing: allKeys.filter(k => values[k] === null || values[k] === undefined || values[k] === ''),
  };
}

module.exports = { notifyWhatsApp, previewWhatsApp, templateFingerprint, fmtDate, fmtTime };
