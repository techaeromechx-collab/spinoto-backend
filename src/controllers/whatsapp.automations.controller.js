'use strict';

/**
 * /api/whatsapp/automations — the "when X happens, send Y" rules
 * (Settings → WhatsApp → Automations).
 *
 * The configuration half of the automation system; the fire-time half is
 * whatsappAutomations.service.js. Same permission as the template registry
 * (MANAGE_WHATSAPP_TEMPLATES): deciding when customers hear from the business
 * is the same trust as deciding what the messages say.
 *
 * What is validated HERE and why:
 *
 *   event          — closed vocabulary (AUTOMATION_EVENTS). A typo'd event
 *                    would sit matching nothing, silently, forever.
 *   match_value    — required for *.status_changed, forbidden otherwise.
 *                    An automation on invoice.paid carrying a status would
 *                    never fire (IS NOT DISTINCT FROM NULL), and one on
 *                    status_changed without a status would fire on nothing.
 *   template pairing — the template's entity_types must include the event's
 *                    entity. This is the same mispairing guard the manual
 *                    send has (templateNotAllowed): an estimate template
 *                    fired with an appointment context fails missing_variable
 *                    on every event, on a screen that says it is configured.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { AUTOMATION_EVENTS } = require('../services/whatsappAutomations.service');
const { logActivity } = require('../services/activityLog.service');

function handle(req, res, next, fn) {
  Promise.resolve(fn()).catch((err) => {
    if (err && err.code === '42P01') {
      return res.status(503).json({
        error: 'Automations are not set up yet. Database is behind the code — run npm run db:migrate.',
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
const EVENT_KEYS = Object.keys(AUTOMATION_EVENTS);

const LIST_SQL = `
  SELECT a.id, a.event, a.match_value, a.recipient, a.timing, a.is_active,
         a.template_id, a.created_at,
         t.template_key, t.provider_template_name, t.is_enabled AS template_enabled,
         t.auto_send AS template_auto_send, t.entity_types,
         u.name AS created_by_name,
         -- Resolve the match to a display name where one exists. A dangling
         -- match (status renamed / deleted) resolves to NULL, which the UI
         -- shows as a warning — same degrade-to-never-fires contract the old
         -- trigger columns had.
         CASE
           WHEN a.event = 'appointment.status_changed'
             THEN (SELECT s.name FROM appointment_statuses s WHERE s.slug = a.match_value LIMIT 1)
           WHEN a.event = 'lead.status_changed'
             THEN (SELECT ls.name FROM lead_statuses ls WHERE ls.name = a.match_value LIMIT 1)
           ELSE NULL
         END AS match_name
    FROM wa_automations a
    JOIN wa_templates t ON t.id = a.template_id
    LEFT JOIN users u ON u.id = a.created_by`;

/** GET /api/whatsapp/automations */
function listAutomations(req, res, next) {
  handle(req, res, next, async () => {
    const r = await pool.query(`${LIST_SQL} WHERE t.is_active ORDER BY a.event, a.id`);

    // Everything the add-form needs, in one response — the same shape the
    // templates screen already loads, so the tab renders without a second
    // round of fetches.
    const templates = await pool.query(
      `SELECT id, template_key, provider_template_name, language_code,
              entity_types, is_enabled, auto_send,
              -- For the preview panel: the pasted copy of the approved body
              -- and the ordered variable mapping. body_preview is reference
              -- text, never parsed for sending — the panel says so on screen.
              body_preview, variables
         FROM wa_templates WHERE is_active ORDER BY id`
    );
    const statuses = await pool.query(
      `SELECT id, name, slug, is_system FROM appointment_statuses
        WHERE is_active ORDER BY sort_order, id`
    );
    const leadStatuses = await pool.query(
      `SELECT id, name FROM lead_statuses WHERE is_active ORDER BY sort_order, id`
    );

    res.json({
      items: r.rows,
      events: AUTOMATION_EVENTS,
      templates: templates.rows,
      statuses: statuses.rows,
      lead_statuses: leadStatuses.rows,
    });
  });
}

/**
 * The pairing rule, shared by create and update: is this template usable for
 * this event? Returns null or a sentence for a 422.
 */
async function pairingProblem(db, event, matchValue, templateId) {
  const spec = AUTOMATION_EVENTS[event];
  if (!spec) return 'That event does not exist.';

  if (spec.match && !matchValue) {
    return 'Pick which status should fire this automation.';
  }
  if (!spec.match && matchValue) {
    return 'This event has no status to match — leave that blank.';
  }

  const t = await db.query(
    `SELECT template_key, entity_types FROM wa_templates WHERE id = $1 AND is_active`,
    [templateId]
  );
  if (!t.rowCount) return 'That template does not exist (or was retired).';

  const types = t.rows[0].entity_types || [];
  // An unmapped template (entity_types = {}) is treated as allowed, matching
  // templateNotAllowed in whatsapp.messages.controller.js — the guard exists
  // to stop a WRONG pairing, not to enforce a column that may be unfilled.
  if (types.length && !types.includes(spec.entity)) {
    return `${t.rows[0].template_key} is a ${types.join('/')} template — this event resolves its variables from a${'aeiou'.includes(spec.entity[0]) ? 'n' : ''} ${spec.entity}, so the send would fail every time.`;
  }

  // For appointment statuses, the match must be a SLUG that exists — a name
  // pasted here would sit matching nothing. Lead statuses ARE matched by name
  // (leads.status stores the name), so any non-empty string is structurally
  // valid there; a dangling one degrades to never-fires and the list flags it.
  if (event === 'appointment.status_changed') {
    const s = await db.query(
      `SELECT 1 FROM appointment_statuses WHERE slug = $1 AND is_active`, [matchValue]
    );
    if (!s.rowCount) return `No active appointment status has the slug '${matchValue}'.`;
  }

  return null;
}

/**
 * supports_auto means "has at least one automation" since migration 151.
 * Recomputed after every mutation, on the same client, so the template card's
 * auto toggle is never lying when the two screens are open side by side.
 * auto_send is forced off first where the flag goes false (CHECK constraint,
 * and the truthful state — nothing can fire it any more).
 */
async function resyncSupportsAuto(db, templateId) {
  await db.query(
    `UPDATE wa_templates t SET auto_send = FALSE
      WHERE t.id = $1 AND t.auto_send
        AND NOT EXISTS (SELECT 1 FROM wa_automations a WHERE a.template_id = t.id)`,
    [templateId]
  );
  await db.query(
    `UPDATE wa_templates t
        SET supports_auto = EXISTS (SELECT 1 FROM wa_automations a WHERE a.template_id = t.id)
      WHERE t.id = $1`,
    [templateId]
  );
}

const createSchema = z.object({
  event: z.enum(EVENT_KEYS),
  match_value: z.string().trim().min(1).max(100).nullable().optional(),
  template_id: z.coerce.number().int().positive(),
  is_active: z.boolean().default(true),
});

/** POST /api/whatsapp/automations */
function createAutomation(req, res, next) {
  handle(req, res, next, async () => {
    const d = createSchema.parse(req.body);
    const match = d.match_value || null;

    const problem = await pairingProblem(pool, d.event, match, d.template_id);
    if (problem) return res.status(422).json({ error: problem });

    const client = await pool.connect();
    let id;
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO wa_automations (event, match_value, template_id, is_active, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [d.event, match, d.template_id, d.is_active, req.user?.id || null]
      );
      if (!r.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'That automation already exists — edit or re-activate the existing one.',
        });
      }
      id = r.rows[0].id;
      await resyncSupportsAuto(client, d.template_id);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'CREATE',
      entity: 'wa_automation',
      entityId: id,
      description: `WhatsApp automation: ${d.event}${match ? ` = ${match}` : ''} → template #${d.template_id}`,
    });

    const fresh = await pool.query(`${LIST_SQL} WHERE a.id = $1`, [id]);
    res.status(201).json({ item: fresh.rows[0] });
  });
}

const updateSchema = z.object({
  is_active: z.boolean().optional(),
  match_value: z.string().trim().min(1).max(100).nullable().optional(),
  template_id: z.coerce.number().int().positive().optional(),
});

/** PATCH /api/whatsapp/automations/:id */
function updateAutomation(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const d = updateSchema.parse(req.body);

    const cur = await pool.query(
      `SELECT id, event, match_value, template_id FROM wa_automations WHERE id = $1`, [id]
    );
    if (!cur.rowCount) return res.status(404).json({ error: 'Automation not found' });
    const row = cur.rows[0];

    // Validate the RESULTING pairing, same principle as updateTemplate:
    // changing the template can orphan a match just as changing the match can.
    const nextMatch = d.match_value !== undefined ? (d.match_value || null) : row.match_value;
    const nextTemplate = d.template_id !== undefined ? d.template_id : row.template_id;
    if (d.match_value !== undefined || d.template_id !== undefined) {
      const problem = await pairingProblem(pool, row.event, nextMatch, nextTemplate);
      if (problem) return res.status(422).json({ error: problem });
    }

    const fields = [];
    const params = [];
    const set = (col, val) => { params.push(val); fields.push(`${col} = $${params.length}`); };
    if (d.is_active !== undefined) set('is_active', d.is_active);
    if (d.match_value !== undefined) set('match_value', d.match_value || null);
    if (d.template_id !== undefined) set('template_id', d.template_id);
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      params.push(id);
      await client.query(
        `UPDATE wa_automations SET ${fields.join(', ')} WHERE id = $${params.length}`,
        params
      );
      // Both sides when the template moved: the old one may have lost its last
      // automation, the new one certainly gained one.
      await resyncSupportsAuto(client, row.template_id);
      if (d.template_id !== undefined && d.template_id !== row.template_id) {
        await resyncSupportsAuto(client, d.template_id);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err && err.code === '23505') {
        return res.status(409).json({ error: 'That automation already exists.' });
      }
      throw err;
    } finally {
      client.release();
    }

    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'UPDATE',
      entity: 'wa_automation',
      entityId: id,
      description: `WhatsApp automation ${row.event}: ${Object.keys(d).join(', ')}`,
    });

    const fresh = await pool.query(`${LIST_SQL} WHERE a.id = $1`, [id]);
    res.json({ item: fresh.rows[0] });
  });
}

/**
 * DELETE /api/whatsapp/automations/:id — hard delete.
 *
 * Unlike templates there is no history to preserve: wa_messages references the
 * TEMPLATE, never the automation, so the message log keeps answering "what did
 * we send" after the rule that sent it is gone.
 */
function deleteAutomation(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    const client = await pool.connect();
    let row;
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `DELETE FROM wa_automations WHERE id = $1 RETURNING event, match_value, template_id`, [id]
      );
      row = r.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Automation not found' });
      }
      await resyncSupportsAuto(client, row.template_id);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    logActivity({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'DELETE',
      entity: 'wa_automation',
      entityId: id,
      description: `WhatsApp automation removed: ${row.event}${row.match_value ? ` = ${row.match_value}` : ''}`,
    });

    res.json({ ok: true });
  });
}

module.exports = { listAutomations, createAutomation, updateAutomation, deleteAutomation };
