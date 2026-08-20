'use strict';

/**
 * /api/whatsapp — the template registry (Settings → WhatsApp).
 *
 * This is NOT a template editor. Meta owns the body text; editing one there
 * sends it back through approval. What this manages is the mapping that says
 * how to FILL an approved template, plus the two switches that decide whether
 * it is used.
 *
 * ── Why the test send is the centrepiece ─────────────────────────────────────
 *
 * Interakt exposes no API to read a template's definition. So the order in
 * `variables` — which canonical field becomes bodyValues[0], [1], [2] — is
 * transcribed by a human from the Interakt dashboard.
 *
 * A wrong order does not error. The message sends, with the vehicle in the date
 * slot, to a real customer. There is no validation that can catch it, because
 * both orders are structurally identical: seven strings in an array.
 *
 * The only mechanism that can catch it is a human reading the result. Hence
 * POST /:id/test, and hence stage 3 of the plan coming before anything is wired
 * to a trigger.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { sendTemplate, isConfigured } = require('../utils/interakt');
const { toE164 } = require('../utils/phone');
const { logActivity } = require('../services/activityLog.service');
const {
  getSetting, settingSource, putSetting,
} = require('../services/integrationSettings.service');

function handle(req, res, next, fn) {
  Promise.resolve(fn()).catch((err) => {
    if (err && err.code === '42P01') {
      return res.status(503).json({
        error: 'WhatsApp is not set up yet. Database is behind the code — run npm run db:migrate.',
        code: 'MIGRATION_PENDING',
      });
    }
    if (err instanceof z.ZodError) {
      return res.status(422).json({ error: err.errors[0]?.message || 'Invalid input' });
    }
    next(err);
  });
}

const idParam = z.coerce.number().int().positive();

/**
 * Canonical variable vocabulary.
 *
 * The approved templates spell the same thing four ways —
 * {{customer_name}}, {{Customer Name}}, {{customer Name}}, {{customer name}} —
 * and Meta does not care, because it matches on position. Spinoto uses ONE
 * spelling, and the registry maps canonical key → position.
 *
 * A closed list rather than free text: a typo'd key here would resolve to
 * undefined at send time, and the adapter would refuse the send. Better to
 * refuse it in the form.
 */
const VARIABLE_KEYS = Object.freeze([
  'customer_name',
  'vehicle',          // "Hero Passion Pro" — make + model
  'reg_number',
  'date',
  'time',
  'service_type',
  'workshop_link',    // hubs.map_url
  'invoice_link',     // public document URL
  'amount',
  'estimate_amount',
  'estimate_link',
  'voucher_no',
  'balance_due',
  'receipt_link',
]);

/**
 * Which keys each KIND of record can actually produce.
 *
 * The flat list above says what the vocabulary is; this says what is available
 * where. They are different questions and conflating them was a real hole: a
 * template mapped to an appointment could be given 'estimate_link', which
 * passes validation and then fails at every send with missing_variable, on a
 * template that looks correctly configured.
 *
 * This mirrors buildValues() in whatsapp.dispatcher.js — the branches there are
 * the source of truth, and these lists must be kept in step with them. Anything
 * here that buildValues does not return resolves to undefined and blocks the
 * send; anything buildValues returns that is missing here is simply unofferable
 * in the form, which is the safe direction to be wrong in.
 */
const ENTITY_VARIABLE_KEYS = Object.freeze({
  lead:        Object.freeze(['customer_name', 'vehicle', 'reg_number']),
  // invoice_link / estimate_amount / estimate_link resolve from an
  // appointment too: the context query fetches the appointment's latest
  // APPROVED invoice and latest CUSTOMER-VISIBLE estimate (drafts never
  // leak). This is what lets Invoice / Bill and the estimate templates be
  // offered on the appointment screen and fire from appointment-status
  // automations.
  appointment: Object.freeze(['customer_name', 'vehicle', 'reg_number', 'date', 'time',
                              'service_type', 'workshop_link', 'invoice_link',
                              'estimate_amount', 'estimate_link']),
  estimate:    Object.freeze(['customer_name', 'vehicle', 'reg_number',
                              'estimate_amount', 'estimate_link']),
  invoice:     Object.freeze(['customer_name', 'amount', 'invoice_link']),
  advance:     Object.freeze(['customer_name', 'amount', 'voucher_no',
                              'balance_due', 'receipt_link']),
  // A payment recorded against an invoice (counter or gateway, not an
  // advance). Mirrors PAYMENT_CONTEXT in whatsapp.dispatcher.js.
  payment:     Object.freeze(['customer_name', 'amount', 'balance_due',
                              'invoice_link']),
});

const ENTITY_TYPES = Object.freeze(Object.keys(ENTITY_VARIABLE_KEYS));

/**
 * Templates fired from CODE at a specific business moment, not by a status
 * transition. The value is the sentence the Settings screen shows in place of
 * the trigger dropdowns.
 *
 * This list used to live only in the frontend (DIRECT_FIRE in
 * WhatsAppSettings.jsx), which is exactly how it went stale: estimate_approve
 * and advance_receipt were added as code-fired templates and never added there,
 * so their cards grew trigger dropdowns again — the trap migration 128
 * documents. The server knows which keys its controllers hardcode; the frontend
 * should not have to.
 *
 * A key listed here keeps supports_auto TRUE regardless of trigger columns,
 * because its trigger is a call site rather than data.
 */
const CODE_FIRED = Object.freeze({
  appointment_created:    'an appointment is created',
  appointment_reschedule: 'an appointment’s date or time is changed',
  invoice_ready:          'Spinoto approves the invoice',
  estimate_approval:      'Spinoto approves the estimate and it is sent to the customer',
  estimate_approve:       'the customer approves their estimate online',
  advance_receipt:        'an advance payment is recorded',
  invoice_paid:           'an invoice becomes fully paid',
  payment_received:       'a payment is recorded against an invoice (counter or online)',
});

/**
 * The keys a template may use, given the records it is mapped to.
 *
 * INTERSECTION, not union. A template on both lead and appointment must render
 * from either one, so it may only use keys BOTH supply — which is why
 * call_not_received, mapped to two records, can only use customer_name. A union
 * would let the form offer 'date' on that template and produce a send that
 * fails on exactly half its records, which is the worst of both.
 */
function keysFor(entityTypes) {
  const list = (entityTypes || []).filter(e => ENTITY_VARIABLE_KEYS[e]);
  if (!list.length) return [];
  return list
    .map(e => ENTITY_VARIABLE_KEYS[e])
    .reduce((a, b) => a.filter(k => b.includes(k)));
}

/**
 * Are these variables usable by these records? Returns null or a sentence.
 *
 * Checked on create AND on update, because the failure is reachable from both
 * directions: picking a bad key, or narrowing entity_types until a key that was
 * fine no longer is.
 */
function variablesNotAllowed(entityTypes, ...lists) {
  const allowed = keysFor(entityTypes);
  if (!allowed.length) return null;   // unmapped: nothing to check against
  const used = [...new Set(lists.flat().filter(Boolean))];
  const bad = used.filter(k => !allowed.includes(k));
  if (!bad.length) return null;
  return `${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} not available on `
       + `${entityTypes.join(' + ')}. Available: ${allowed.join(', ')}.`;
}

// Sample values for the test send. Deliberately obvious and DIFFERENT from each
// other in shape — a date that cannot be mistaken for a registration, a
// registration that cannot be mistaken for a time. If the mapping is wrong, the
// test message reads as visibly wrong rather than merely odd.
const SAMPLE = Object.freeze({
  customer_name: 'TEST Customer',
  vehicle:       'TEST Hero Passion Pro',
  reg_number:    'GJ01TEST1234',
  date:          '31 December 2026',
  time:          '4:30 PM',
  service_type:  'TEST General Service',
  workshop_link: 'https://maps.google.com/?q=TEST+workshop',
  invoice_link:  'https://example.com/TEST-invoice',
  amount:          '1234',
  estimate_amount: '4321',
  estimate_link:   'https://example.com/TEST-estimate',
  voucher_no:      'ADV-TEST-0001',
  balance_due:     '567',
  receipt_link:    'https://example.com/TEST-receipt',
});

const LIST_COLS = `
  t.id, t.template_key, t.provider_template_name, t.language_code, t.category,
  t.variables, t.header_variables, t.body_preview,
  t.is_enabled, t.auto_send, t.supports_auto,
  t.trigger_status_slug, t.trigger_lead_status,
  t.entity_types, t.last_tested_at,
  t.auto_send_changed_at,
  u.name AS auto_send_changed_by_name,
  s.name AS trigger_status_name`;

/** GET /api/whatsapp/templates */
function listTemplates(req, res, next) {
  handle(req, res, next, async () => {
    const r = await pool.query(`
      SELECT ${LIST_COLS}
        FROM wa_templates t
        LEFT JOIN users u ON u.id = t.auto_send_changed_by
        -- Not a foreign key by design (see migration 110): a template pointing
        -- at a slug that no longer exists must degrade to "never fires", not
        -- block someone deleting a status. So this join can miss, and a NULL
        -- name here is exactly the signal the UI needs to show a warning.
        LEFT JOIN appointment_statuses s ON s.slug = t.trigger_status_slug
       WHERE t.is_active
       ORDER BY t.id
    `);

    // Choices for the trigger dropdown.
    //
    // Slug, not name — renaming a status in Master Data must not break a
    // trigger. Statuses WITHOUT a slug are returned too, flagged rather than
    // hidden: a custom status someone added in Master Data cannot be a trigger
    // (only migration 036's eleven system statuses were given slugs), and
    // showing it disabled answers "why isn't my status in the list?" where
    // omitting it just raises the question.
    const st = await pool.query(
      `SELECT id, name, slug, is_system, sort_order
         FROM appointment_statuses
        WHERE is_active
        ORDER BY sort_order, id`
    );

    // Lead statuses, by NAME — leads.status stores the name, not an id, so
    // that is what a trigger has to match on.
    const ls = await pool.query(
      `SELECT id, name FROM lead_statuses WHERE is_active ORDER BY sort_order, id`
    );

    res.json({
      items: r.rows,
      statuses: st.rows,
      lead_statuses: ls.rows,
      variable_keys: VARIABLE_KEYS,
      // What the form needs to offer only the keys a record can actually
      // produce, and to know which record types exist at all.
      entity_variable_keys: ENTITY_VARIABLE_KEYS,
      entity_types: ENTITY_TYPES,
      // Which template keys are fired from code, and the sentence to show
      // instead of trigger dropdowns. Served rather than hardcoded client-side
      // so adding a code-fired template cannot silently resurrect the dropdowns
      // (the migration-128 trap).
      direct_fire: CODE_FIRED,
      // Drives the banner explaining why nothing can send yet. Never the key
      // itself, or its length, or a masked prefix — a boolean is the whole of
      // what the screen needs to know.
      provider_configured: isConfigured(),
      test_number_configured: Boolean(toE164(getSetting('whatsapp_test_number'))),
    });
  });
}

const updateSchema = z.object({
  provider_template_name: z.string().trim().min(1).max(120).optional(),
  language_code: z.string().trim().min(2).max(10).optional(),
  variables: z.array(z.enum(VARIABLE_KEYS)).max(20).optional(),
  header_variables: z.array(z.enum(VARIABLE_KEYS)).max(10).optional(),
  // trigger_status_slug / trigger_lead_status are gone from this schema:
  // deprecated by migration 151, superseded by /api/whatsapp/automations.
  is_enabled: z.boolean().optional(),
  auto_send: z.boolean().optional(),
  // Which records may send it. Not template_key: six controllers hardcode keys
  // like 'invoice_ready', and renaming one here would silently kill its
  // automatic send with nothing to show for it. Settable on create, where no
  // such reference can exist yet, and never after.
  entity_types: z.array(z.enum(ENTITY_TYPES)).max(5).optional(),
});

/** PATCH /api/whatsapp/templates/:id */
function updateTemplate(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const d = updateSchema.parse(req.body);

    const cur = await pool.query(
      `SELECT id, template_key, supports_auto, auto_send, is_enabled,
              entity_types, variables, header_variables, last_tested_at,
              trigger_status_slug, trigger_lead_status
         FROM wa_templates WHERE id = $1 AND is_active`,
      [id]
    );
    if (cur.rowCount === 0) return res.status(404).json({ error: 'Template not found' });
    const row = cur.rows[0];

    // ── The mapping must be usable by the records it is offered on ────────
    //
    // Checked against the RESULTING state, not the submitted fields: narrowing
    // entity_types is just as capable of orphaning a key as picking a bad one,
    // and a request that does both is the case a per-field check would miss.
    const nextEntities  = d.entity_types      ?? row.entity_types  ?? [];
    const nextVars      = d.variables         ?? row.variables     ?? [];
    const nextHeaderVars = d.header_variables ?? row.header_variables ?? [];
    const varsBad = variablesNotAllowed(nextEntities, nextVars, nextHeaderVars);
    if (varsBad) return res.status(422).json({ error: varsBad });

    // ── Enabling requires a test that passed for THIS mapping ─────────────
    //
    // The registry's whole failure mode is a mapping that is wrong but valid:
    // the right number of values in the wrong order sends cleanly, to a real
    // customer, with the vehicle in the amount slot. Meta matches on position
    // and never sees our key names, so nothing here can detect it. A human
    // reading the test message is the only check that exists, and this is what
    // makes it a step rather than a suggestion.
    const clearsTest =
      (d.variables !== undefined && JSON.stringify(d.variables) !== JSON.stringify(row.variables)) ||
      (d.header_variables !== undefined && JSON.stringify(d.header_variables) !== JSON.stringify(row.header_variables)) ||
      (d.provider_template_name !== undefined && d.provider_template_name !== row.provider_template_name);

    // Enabling in the SAME request that changes the mapping is refused rather
    // than silently ordered — "save and enable" must not slip a reorder past
    // the gate on the strength of a test that was passing before it.
    const stillTested = row.last_tested_at && !clearsTest;
    if (d.is_enabled === true && !stillTested) {
      return res.status(422).json({
        error: clearsTest
          ? 'The mapping changed — send a test to your own number, then switch it on.'
          : 'Send a test to your own number before switching this on.',
        reason: 'test_required',
      });
    }

    // ── supports_auto is DERIVED, not stored opinion ──────────────────────
    //
    // Since migration 151 the truthful definition is "has at least one
    // automation row" — the wa_automations controller keeps the stored flag in
    // step on every create/update/delete, and this endpoint only needs the
    // current value to gate auto_send. Read live rather than trusting
    // row.supports_auto so a stale flag cannot unlock the toggle.
    //
    // The catch swallows exactly one condition: wa_automations not existing
    // yet (42P01, migration behind the code). Falling back to the stored flag
    // keeps this screen working during a half-finished deploy.
    let derivedSupportsAuto = row.supports_auto;
    try {
      const auto = await pool.query(
        `SELECT EXISTS (SELECT 1 FROM wa_automations a WHERE a.template_id = $1) AS has`,
        [id]
      );
      derivedSupportsAuto = auto.rows[0].has;
    } catch (err) {
      if (err.code !== '42P01') throw err;
    }

    // The DB CHECK enforces this too. Returning a sentence rather than letting
    // a constraint violation surface as a 500 is the difference between "this
    // template has no automatic trigger" and "Internal server error".
    if (d.auto_send === true && !derivedSupportsAuto) {
      return res.status(422).json({
        error: 'This template has no automatic trigger — pick a status for it to fire on, or it can only be sent by hand.',
      });
    }

    const fields = [];
    const params = [];
    const set = (col, val) => { params.push(val); fields.push(`${col} = $${params.length}`); };

    if (d.provider_template_name !== undefined) set('provider_template_name', d.provider_template_name);
    if (d.language_code !== undefined) set('language_code', d.language_code);
    if (d.variables !== undefined) set('variables', JSON.stringify(d.variables));
    if (d.header_variables !== undefined) set('header_variables', JSON.stringify(d.header_variables));
    // Reconcile a stale stored flag while we are here. The automations
    // controller is the primary writer since migration 151; this is only the
    // backstop for rows it has not touched yet.
    if (derivedSupportsAuto !== row.supports_auto) {
      set('supports_auto', derivedSupportsAuto);
    }
    if (!derivedSupportsAuto && row.auto_send && d.auto_send === undefined) {
      set('auto_send', false);
      set('auto_send_changed_by', req.user?.id || null);
      fields.push('auto_send_changed_at = NOW()');
    }
    if (d.is_enabled !== undefined) set('is_enabled', d.is_enabled);
    if (d.entity_types !== undefined) set('entity_types', d.entity_types);

    // A changed mapping invalidates the test that passed, and switches the
    // template off. Leaving it enabled would mean the untested mapping is
    // already reaching customers while the gate above politely waits.
    if (clearsTest) {
      fields.push('last_tested_at = NULL');
      if (d.is_enabled === undefined && row.is_enabled) set('is_enabled', false);
    }

    // Auto-send is stamped, not just set. "Why did customers stop getting
    // appointment messages?" is otherwise unanswerable — someone flipped this
    // three weeks ago and nobody remembers. Only stamped on an actual change,
    // so re-saving the form does not rewrite the history.
    if (d.auto_send !== undefined && d.auto_send !== row.auto_send) {
      set('auto_send', d.auto_send);
      set('auto_send_changed_by', req.user?.id || null);
      fields.push('auto_send_changed_at = NOW()');
    }

    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(id);
    await pool.query(
      `UPDATE wa_templates SET ${fields.join(', ')} WHERE id = $${params.length}`,
      params
    );

    // Fire-and-forget: logActivity is synchronous and swallows its own errors
    // (activityLog.service.js:38-44). Not awaited, not .catch()ed — it returns
    // undefined, so a .catch() here would throw on the happy path.
    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'UPDATE',
      entity: 'wa_template',
      entityId: id,
      description: `WhatsApp template ${row.template_key}: ${Object.keys(d).join(', ')}`,
    });

    const fresh = await pool.query(
      `SELECT ${LIST_COLS}
         FROM wa_templates t
         LEFT JOIN users u ON u.id = t.auto_send_changed_by
         LEFT JOIN appointment_statuses s ON s.slug = t.trigger_status_slug
        WHERE t.id = $1`,
      [id]
    );
    res.json({ item: fresh.rows[0] });
  });
}

/* ══ CREATE ═══════════════════════════════════════════════════════════════
 *
 * Registers a template that ALREADY EXISTS and is approved in Interakt. It does
 * not create one — Meta owns the wording and the approval, and no API on this
 * side can shortcut that. What this writes is the pointer: the code name, the
 * language, the ordered mapping, and which records may send it.
 *
 * Before this endpoint every template arrived as a migration (110, 117, 128,
 * 140, 147), which meant a deploy to add a message.
 */
const createSchema = z.object({
  // Settable HERE and nowhere else. Six controllers hardcode keys like
  // 'invoice_ready' to fire automatic sends; a new row has no such reference
  // yet, so it may name itself. updateSchema deliberately omits it.
  template_key: z.string().trim().min(2).max(40)
    .regex(/^[a-z][a-z0-9_]*$/, 'Use lower-case letters, digits and underscores, starting with a letter.'),
  provider_template_name: z.string().trim().min(1).max(120),
  language_code: z.string().trim().min(2).max(10).default('en'),
  entity_types: z.array(z.enum(ENTITY_TYPES)).min(1, 'Pick at least one record type.').max(5),
  variables: z.array(z.enum(VARIABLE_KEYS)).max(20).default([]),
  header_variables: z.array(z.enum(VARIABLE_KEYS)).max(10).default([]),
  body_preview: z.string().trim().max(2000).optional(),
  // supports_auto and the trigger columns are gone from this schema since
  // migration 151. WHEN a template fires is a wa_automations row now
  // (POST /api/whatsapp/automations, whose controller also maintains
  // supports_auto); a freshly created template starts with no automations,
  // so the flag starts FALSE unless the key is code-fired.
});

/** POST /api/whatsapp/templates */
function createTemplate(req, res, next) {
  handle(req, res, next, async () => {
    const d = createSchema.parse(req.body);

    const varsBad = variablesNotAllowed(d.entity_types, d.variables, d.header_variables);
    if (varsBad) return res.status(422).json({ error: varsBad });

    // Checked before the insert so the message names the conflict. The partial
    // unique index is (template_key, language_code) WHERE is_active, so the
    // same key in a second language is legal and must not be blocked here.
    const dupe = await pool.query(
      `SELECT id FROM wa_templates
        WHERE template_key = $1 AND language_code = $2 AND is_active`,
      [d.template_key, d.language_code]
    );
    if (dupe.rowCount) {
      return res.status(409).json({
        error: `A template named ${d.template_key} already exists in ${d.language_code}. Edit that one, or use a different key.`,
      });
    }

    // is_enabled and auto_send are NOT accepted from the request. Every
    // migration-seeded template arrives off, and one added here arrives off for
    // the same reason: nothing reaches a customer until somebody tests it and
    // switches it on, and an "enabled: true" in the create body would be a way
    // around the gate in updateTemplate.
    const r = await pool.query(
      `INSERT INTO wa_templates
         (template_key, provider_template_name, language_code, entity_types,
          variables, header_variables, body_preview, supports_auto,
          is_enabled, auto_send, is_active)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8, FALSE, FALSE, TRUE)
       RETURNING id`,
      [d.template_key, d.provider_template_name, d.language_code, d.entity_types,
       JSON.stringify(d.variables), JSON.stringify(d.header_variables),
       d.body_preview || null,
       // Derived, never trusted from the client. A new row has no automations
       // yet, so only a code-fired key arrives able to auto-send; everything
       // else flips TRUE when its first automation is created.
       Boolean(CODE_FIRED[d.template_key])]
    );
    const id = r.rows[0].id;

    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'CREATE',
      entity: 'wa_template',
      entityId: id,
      description: `WhatsApp template ${d.template_key} added (${d.provider_template_name}, ${d.entity_types.join('+')})`,
    });

    const fresh = await pool.query(
      `SELECT ${LIST_COLS}
         FROM wa_templates t
         LEFT JOIN users u ON u.id = t.auto_send_changed_by
         LEFT JOIN appointment_statuses s ON s.slug = t.trigger_status_slug
        WHERE t.id = $1`,
      [id]
    );
    res.status(201).json({ item: fresh.rows[0] });
  });
}

/* ══ RETIRE ═══════════════════════════════════════════════════════════════
 *
 * Soft by default: is_active = false, which the partial unique index treats as
 * gone and every read filters out.
 *
 * HARD delete when the template has never sent anything. A row with no
 * wa_messages against it has no history worth keeping, and a settings screen
 * quietly accumulating invisible tombstones is its own mess — the next person
 * adding the same key hits a unique-index error against a row they cannot see.
 *
 * Once it HAS sent, the row stays: wa_messages.template_id references it, and
 * the message log's ability to answer "what did we send this customer" depends
 * on the template still being there to join to.
 */
function deleteTemplate(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    const cur = await pool.query(
      `SELECT id, template_key, is_enabled FROM wa_templates WHERE id = $1 AND is_active`,
      [id]
    );
    if (cur.rowCount === 0) return res.status(404).json({ error: 'Template not found' });
    const row = cur.rows[0];

    // Refuse while enabled rather than switching it off silently. Retiring a
    // live template is a bigger act than the button admits, and making it two
    // steps is the cheapest way to say so.
    if (row.is_enabled) {
      return res.status(422).json({
        error: 'Switch this template off before retiring it.',
        reason: 'still_enabled',
      });
    }

    const used = await pool.query(
      'SELECT 1 FROM wa_messages WHERE template_id = $1 LIMIT 1', [id]
    );
    const hard = used.rowCount === 0;

    if (hard) {
      await pool.query('DELETE FROM wa_templates WHERE id = $1', [id]);
    } else {
      await pool.query('UPDATE wa_templates SET is_active = FALSE WHERE id = $1', [id]);
    }

    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'DELETE',
      entity: 'wa_template',
      entityId: id,
      description: `WhatsApp template ${row.template_key} ${hard ? 'deleted' : 'retired (kept for message history)'}`,
    });

    res.json({ ok: true, deleted: hard });
  });
}

const testSchema = z.object({
  // Optional override so an admin can send to their own handset without
  // changing an env var and restarting.
  to: z.string().trim().max(20).optional(),
});

/**
 * POST /api/whatsapp/templates/:id/test
 *
 * Sends the template, filled with obviously-fake values, to a staff number.
 *
 * Not written to wa_messages. That table is the record of what customers were
 * sent; a test to an admin's own handset is neither a customer message nor
 * something that should appear on any record's Messages tab. It is also
 * deliberately not deduplicated — pressing the button twice must send twice,
 * because the whole point is to look at the result again after a fix.
 */
function testTemplate(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const d = testSchema.parse(req.body || {});

    const r = await pool.query(
      `SELECT id, template_key, provider_template_name, language_code,
              variables, header_variables
         FROM wa_templates WHERE id = $1 AND is_active`,
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Template not found' });
    const t = r.rows[0];

    const to = toE164(d.to || getSetting('whatsapp_test_number'));
    if (!to) {
      return res.status(422).json({
        error: d.to
          ? 'That is not a valid 10-digit Indian mobile number.'
          : 'No test number configured. Set one in the Connection tab, or enter a number here.',
      });
    }

    // A test send ignores is_enabled entirely. Verifying the mapping is the
    // step that comes BEFORE you would be willing to enable it — requiring it
    // to be on first would invert the whole point of the button.
    const result = await sendTemplate({
      to,
      templateName: t.provider_template_name,
      languageCode: t.language_code,
      bodyValues: (t.variables || []).map((k) => SAMPLE[k] ?? `TEST_${k}`),
      headerValues: (t.header_variables || []).map((k) => SAMPLE[k] ?? `TEST_${k}`),
    });

    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'UPDATE',
      entity: 'wa_template',
      entityId: id,
      description: `Test send of ${t.template_key} to ${to}: ${result.ok ? 'sent' : `failed (${result.errorCode})`}`,
    });

    if (!result.ok) {
      // 200, not an error status. The send failing is the ANSWER to the
      // question the admin asked, not a fault in their request — and a 4xx
      // here would render as a generic toast instead of the provider's own
      // message, which is the useful part.
      return res.json({
        ok: false,
        error_code: result.errorCode,
        error: result.errorMessage,
      });
    }

    // The gate in updateTemplate reads this. Stamped only on a send the
    // provider accepted — a 4xx means the mapping was never exercised, and
    // recording it as tested would unlock the very thing the gate exists for.
    //
    // Note what is NOT verified: that a human then read the message. Nothing
    // can verify that. What this records is that a message with these values
    // in this order reached a phone somebody controls, which is the most the
    // system can know and the point at which the responsibility becomes theirs.
    await pool.query('UPDATE wa_templates SET last_tested_at = NOW() WHERE id = $1', [id]);

    res.json({
      ok: true,
      provider_message_id: result.providerMessageId,
      sent_to: to,
      // Echoed back so the screen can show "position 1 → customer_name" beside
      // the message that just arrived. Reading the WhatsApp message against
      // this list is how a wrong order gets caught.
      sent_values: (t.variables || []).map((k, i) => ({
        position: i + 1, key: k, value: SAMPLE[k] ?? `TEST_${k}`,
      })),
    });
  });
}

/* ══ CONNECTION (provider settings) ════════════════════════════════════════
 *
 * The Interakt API key, webhook secret and default test number, settable from
 * the UI (migration 152). The values themselves NEVER leave the backend: the
 * GET returns {configured, last4, source} per key and nothing else, so there
 * is no response a stale browser tab or a screenshot can leak a credential
 * from. Writes are one-way — send a new value, or an empty string to clear
 * the DB row and fall back to the environment variable.
 */

/** {configured, last4, source} — the whole of what the screen may know. */
function describeSetting(key) {
  const v = getSetting(key);
  return {
    configured: v.length > 0,
    last4: v.length > 0 ? v.slice(-4) : null,
    // 'database' (set from this screen), 'environment' (.env fallback), null.
    source: settingSource(key),
  };
}

/** GET /api/whatsapp/provider-settings */
function getProviderSettings(req, res, next) {
  handle(req, res, next, async () => {
    res.json({
      api_key:        describeSetting('interakt_api_key'),
      webhook_secret: describeSetting('interakt_webhook_secret'),
      // The test number is not a secret — it is a staff phone number the
      // screen may show whole, so the admin can see WHERE tests will land.
      test_number: {
        ...describeSetting('whatsapp_test_number'),
        value: getSetting('whatsapp_test_number') || null,
      },
    });
  });
}

const providerSettingsSchema = z.object({
  // undefined = leave alone; '' = clear (fall back to env); string = set.
  api_key:        z.string().trim().max(500).optional(),
  webhook_secret: z.string().trim().max(500).optional(),
  test_number:    z.string().trim().max(20).optional(),
});

/** PUT /api/whatsapp/provider-settings */
function saveProviderSettings(req, res, next) {
  handle(req, res, next, async () => {
    const d = providerSettingsSchema.parse(req.body || {});
    if (d.api_key === undefined && d.webhook_secret === undefined && d.test_number === undefined) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    // A test number that cannot receive a WhatsApp is worse than none — it
    // fails every test send with a message that blames the template.
    if (d.test_number !== undefined && d.test_number !== '' && !toE164(d.test_number)) {
      return res.status(422).json({ error: 'That is not a valid 10-digit Indian mobile number.' });
    }

    const uid = req.user?.id || null;
    const changed = [];
    if (d.api_key !== undefined)        { await putSetting(pool, 'interakt_api_key', d.api_key, uid);               changed.push('api_key'); }
    if (d.webhook_secret !== undefined) { await putSetting(pool, 'interakt_webhook_secret', d.webhook_secret, uid); changed.push('webhook_secret'); }
    if (d.test_number !== undefined)    { await putSetting(pool, 'whatsapp_test_number', d.test_number, uid);       changed.push('test_number'); }

    // Which fields changed, NEVER their values. "Someone rotated the API key
    // on Tuesday" is the answerable question this exists for.
    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'UPDATE',
      entity: 'integration_settings',
      entityId: null,
      description: `WhatsApp connection settings changed: ${changed.join(', ')}`,
    });

    res.json({
      api_key:        describeSetting('interakt_api_key'),
      webhook_secret: describeSetting('interakt_webhook_secret'),
      test_number: {
        ...describeSetting('whatsapp_test_number'),
        value: getSetting('whatsapp_test_number') || null,
      },
    });
  });
}

module.exports = {
  listTemplates, createTemplate, updateTemplate, deleteTemplate, testTemplate,
  getProviderSettings, saveProviderSettings,
  VARIABLE_KEYS, ENTITY_VARIABLE_KEYS, ENTITY_TYPES, CODE_FIRED,
};
