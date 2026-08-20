'use strict';

/**
 * whatsappAutomations.service.js — the event → automation → template lookup.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Before migration 151, "what sends when" lived in three places: a
 * trigger_status_slug column, a trigger_lead_status column, and eight
 * controllers hardcoding template keys. The wa_automations table replaces all
 * three READ paths with one: a row that says "when EVENT happens (optionally
 * matching VALUE), send TEMPLATE to the customer".
 *
 * This module is the only place that reads that table at fire time. Call sites
 * declare the business moment — fireWhatsAppEvent(client, { event:
 * 'invoice.approved', entityId }) — and everything else (which templates, to
 * whom, deduped how) is data plus the dispatcher.
 *
 * The DISPATCHER is unchanged. notifyWhatsApp still owns variable resolution,
 * refusal on blanks, dedupe and the transactional queue. An automation row
 * decides only WHICH template keys are handed to it; the template's own
 * is_enabled + auto_send toggles remain the master switches the dispatcher
 * enforces (requireAuto), so an automation pointing at a switched-off template
 * is quietly inert — exactly like a status trigger was.
 *
 * ── The event catalog ────────────────────────────────────────────────────────
 *
 * Closed list, not free text. Every event names a call site in code; a typo'd
 * event string in an automation row would sit silently matching nothing, which
 * is the failure mode template_key hardcoding already had. The catalog is what
 * the admin UI offers and what the CRUD controller validates against.
 *
 * `entity` is which dispatcher context resolves the variables — it is fixed by
 * the event, not chosen per automation, because pairing an event with the
 * wrong context is how a template ends up describing a payment that does not
 * exist. `match` names the dimension a status-changed event filters on.
 */

const AUTOMATION_EVENTS = Object.freeze({
  'lead.status_changed': {
    module: 'lead', entity: 'lead', match: 'lead_status',
    label: 'Lead status becomes…',
  },
  'appointment.status_changed': {
    module: 'appointment', entity: 'appointment', match: 'appointment_status',
    label: 'Appointment status becomes…',
  },
  'appointment.created': {
    module: 'appointment', entity: 'appointment', match: null,
    label: 'Appointment is created',
  },
  'appointment.rescheduled': {
    module: 'appointment', entity: 'appointment', match: null,
    label: 'Appointment date or time is changed',
  },
  'estimate.sent': {
    module: 'estimate', entity: 'estimate', match: null,
    label: 'Estimate is approved by Spinoto and sent to the customer',
  },
  'estimate.customer_approved': {
    module: 'estimate', entity: 'estimate', match: null,
    label: 'Customer approves the estimate online',
  },
  'invoice.approved': {
    module: 'invoice', entity: 'invoice', match: null,
    label: 'Invoice is approved and sent to the customer',
  },
  'invoice.paid': {
    module: 'invoice', entity: 'invoice', match: null,
    label: 'Invoice becomes fully paid',
  },
  'payment.received': {
    module: 'payment', entity: 'payment', match: null,
    label: 'Payment is recorded against an invoice',
  },
  'payment.advance_received': {
    module: 'payment', entity: 'advance', match: null,
    label: 'Advance payment is recorded',
  },
});

/**
 * Reasons that are all flavours of "not switched on yet" — expected states
 * until an admin enables things in Settings, and logging them on every event
 * would bury the reasons that matter (missing variable, no messageable
 * number).
 */
const QUIET_REASONS = Object.freeze([
  'duplicate', 'auto_send_off', 'template_disabled', 'no_such_template',
]);

/**
 * The active automations for one event occurrence.
 *
 * IS NOT DISTINCT FROM, because NULL is a real match value: an eventless match
 * column (invoice.approved) stores NULL and must match only NULL — a bare `=`
 * would match nothing and every non-status automation would silently never
 * fire.
 *
 * The join re-checks the template is alive. is_enabled/auto_send are NOT
 * checked here — the dispatcher owns those (requireAuto) and reports WHY a
 * send was refused, which a WHERE clause would silently swallow.
 */
async function automationsFor(db, event, matchValue = null) {
  const r = await db.query(
    `SELECT a.id, a.event, a.match_value, a.recipient, t.template_key
       FROM wa_automations a
       JOIN wa_templates t ON t.id = a.template_id
      WHERE a.event = $1
        AND a.is_active
        AND a.match_value IS NOT DISTINCT FROM $2
        AND t.is_active
      ORDER BY a.id`,
    [event, matchValue == null || matchValue === '' ? null : String(matchValue)]
  );
  return r.rows;
}

/**
 * Fire one business event: look up its automations and queue one message per
 * matching template, on the CALLER'S transaction client.
 *
 * @param {object} client  An in-transaction pg client — NOT the pool. The
 *                         queued messages must live or die with the caller's
 *                         work, same contract as notifyWhatsApp.
 * @param {string} p.event       A key of AUTOMATION_EVENTS.
 * @param {*}      [p.matchValue] Status slug / name for *.status_changed.
 * @param {number} p.entityId    Id of the event's entity (see catalog).
 * @param {string} p.dedupeKey   The transition identity, per call site.
 * @returns {Promise<Array>}     One outcome per automation; never throws.
 *
 * ── Its own SAVEPOINT, around the LOOKUP as well as the sends ───────────────
 *
 * notifyWhatsApp already savepoints its own work, but the automationsFor query
 * runs before that. If wa_automations does not exist yet — new code, migration
 * 151 not run — that query aborts the caller's transaction (25P02) and a lead
 * save or a payment would fail because of MESSAGING CONFIGURATION. The
 * savepoint makes the swallow honest, exactly as the dispatcher's does.
 */
async function fireWhatsAppEvent(client, { event, matchValue = null, entityId, dedupeKey }) {
  const results = [];
  const spec = AUTOMATION_EVENTS[event];
  if (!spec) {
    console.error(`[whatsapp:automations] unknown event '${event}' — nothing fired`);
    return results;
  }

  const SP = 'wa_auto';
  try {
    await client.query(`SAVEPOINT ${SP}`);
  } catch (err) {
    // Not in a transaction — a programmer error at the call site, not a
    // runtime condition. Refuse loudly rather than sending outside the
    // transaction the contract promises.
    console.error(
      `[whatsapp:automations] fireWhatsAppEvent(${event}) needs an in-transaction client:`,
      err.message
    );
    return results;
  }

  try {
    const { notifyWhatsApp } = require('./whatsapp.dispatcher');
    const autos = await automationsFor(client, event, matchValue);

    for (const a of autos) {
      const out = await notifyWhatsApp(client, {
        templateKey: a.template_key,
        entityType: spec.entity,
        entityId,
        dedupeKey,
      });
      results.push({ ...out, template_key: a.template_key, automation_id: a.id });
      if (!out.queued && !QUIET_REASONS.includes(out.reason)) {
        console.warn(
          `[whatsapp] ${a.template_key} not queued for ${spec.entity} #${entityId} (${event}): ${out.reason}`
        );
      }
      // Every refusal except 'duplicate' is RECORDED (wa_send_skips, migration
      // 154) so the Settings screen can answer "why didn't the customer get a
      // message?" without anyone reading a server terminal. 'duplicate' means
      // the message already exists — the system working, not a question.
      if (!out.queued && out.reason !== 'duplicate') {
        await recordSkip(client, {
          event,
          templateKey: a.template_key,
          entityType: spec.entity,
          entityId,
          reason: out.reason || 'error',
        });
      }
    }

    await client.query(`RELEASE SAVEPOINT ${SP}`);
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${SP}`).catch(() => {});
    if (err && err.code === '42P01') {
      console.error(
        `[whatsapp:automations] wa_automations is missing — run npm run db:migrate. ` +
        `Event '${event}' was dropped.`
      );
    } else {
      console.error(`[whatsapp:automations] ${event} failed:`, err.message);
    }
  }
  return results;
}

/**
 * Record one refused send. Its OWN savepoint, always: a failure to write the
 * skip (most likely 42P01 before migration 154 runs) must neither abort the
 * caller's transaction nor discard messages that DID queue in this event.
 */
async function recordSkip(client, { event, templateKey, entityType, entityId, reason }) {
  const SP = 'wa_skip';
  try {
    await client.query(`SAVEPOINT ${SP}`);
    await client.query(
      `INSERT INTO wa_send_skips (event, template_key, entity_type, entity_id, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [event, templateKey, entityType, entityId, String(reason).slice(0, 120)]
    );
    await client.query(`RELEASE SAVEPOINT ${SP}`);
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${SP}`).catch(() => {});
    if (err.code !== '42P01') {
      console.error('[whatsapp:automations] could not record skip:', err.message);
    }
  }
}

/**
 * fireWhatsAppEvent for call sites that have no transaction of their own —
 * the fire-and-forget pattern advanceAppointmentStatus, invoice approval and
 * the advance receipt already used, in one place instead of five hand-rolled
 * copies. Opens a connection, wraps the fire in BEGIN/COMMIT, never throws.
 */
async function fireWhatsAppEventDetached(pool, args) {
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error(`[whatsapp:automations] no connection for ${args.event}:`, err.message);
    return [];
  }
  try {
    await client.query('BEGIN');
    const results = await fireWhatsAppEvent(client, args);
    await client.query('COMMIT');
    return results;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[whatsapp:automations] ${args.event} failed:`, err.message);
    return [];
  } finally {
    client.release();
  }
}

module.exports = {
  AUTOMATION_EVENTS, QUIET_REASONS,
  automationsFor, fireWhatsAppEvent, fireWhatsAppEventDetached,
};
