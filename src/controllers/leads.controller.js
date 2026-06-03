const { z } = require('zod');
const { pool } = require('../config/db');
const {
  fireHighPriorityAlert,
  fireDuplicateLeadAlert,
  fireLeadConversionAlert,
} = require('../services/smartAlerts.service');
const { logActivity } = require('../services/activityLog.service');

// ---------- validators ----------
const leadSchema = z.object({
  name: z.string().trim().max(160).optional().nullable(),
  mobile: z.string().trim().min(1).max(20),
  status: z.string().trim().max(100).optional().nullable(),
  whatsapp: z.string().trim().max(20).optional().nullable(),
  priority: z.enum(['normal','high','urgent','vip']).optional().default('normal'),
  tags: z.array(z.string().trim().max(50)).optional().default([]),
  state_id: z.coerce.number().int().positive().optional().nullable(),
  city_id: z.coerce.number().int().positive().optional().nullable(),
  area_id: z.coerce.number().int().positive().optional().nullable(),
  vehicle_type_id: z.coerce.number().int().positive().optional().nullable(),
  make_id: z.coerce.number().int().positive().optional().nullable(),
  model_id: z.coerce.number().int().positive().optional().nullable(),
  body_type_id: z.coerce.number().int().positive().optional().nullable(),
  segment_ids: z.array(z.number().int()).optional().default([]),
  lead_source: z.string().trim().max(80).optional().nullable(),
  notes: z.string().trim().optional().nullable(),
  assigned_to: z.coerce.number().int().positive().optional().nullable(),
  services: z.array(z.object({
    service_id: z.coerce.number().int().positive(),
    price: z.coerce.number().nonnegative(),
  })).optional().default([]),
  category_ids: z.array(z.coerce.number().int().positive()).optional().default([]),
});

const lookupSchema = z.object({
  service_id:      z.coerce.number().int().positive(),
  vehicle_type_id: z.coerce.number().int().positive().optional().nullable(),
  body_type_id:    z.coerce.number().int().positive().optional().nullable(),
  segment_id:      z.coerce.number().int().positive().optional().nullable(),
  make_id:         z.coerce.number().int().positive().optional().nullable(),
  model_id:        z.coerce.number().int().positive().optional().nullable(),
  cc_category_id:  z.coerce.number().int().positive().optional().nullable(),
});

function handle(req, res, next, fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: err.errors.map((e) => e.message).join('; ') });
      }
      next(err);
    });
}

// =====================================================================
// LEAD CRUD
// =====================================================================

// Full SELECT fragment reused by list + get
const LEAD_SELECT = `
  SELECT
    l.id, l.name, l.mobile, l.whatsapp, l.status, l.total_price,
    l.priority, l.tags,
    l.lead_source, l.lost_reason, l.notes, l.created_at, l.updated_at,
    s.name  AS state_name,  l.state_id,
    c.name  AS city_name,   l.city_id,
    a.name  AS area_name,   l.area_id,
    vt.name AS vehicle_type_name, l.vehicle_type_id,
    mk.name AS make_name,   l.make_id,
    md.name AS model_name,  l.model_id,
    bt.name AS body_type_name, l.body_type_id,
    l.segment_ids,
    (SELECT COALESCE(array_agg(sg.name ORDER BY sg.name), '{}')
       FROM segments sg WHERE sg.id = ANY(l.segment_ids)) AS segment_names,
    u.id    AS created_by_id,
    u.name  AS created_by_name,
    au.id   AS assigned_to_id,
    au.name AS assigned_to_name,
    l.assigned_to,
    EXISTS (SELECT 1 FROM appointments a WHERE a.lead_id = l.id) AS is_converted
  FROM leads l
  LEFT JOIN states        s  ON s.id  = l.state_id
  LEFT JOIN cities        c  ON c.id  = l.city_id
  LEFT JOIN areas         a  ON a.id  = l.area_id
  LEFT JOIN vehicle_types vt ON vt.id = l.vehicle_type_id
  LEFT JOIN vehicle_makes mk ON mk.id = l.make_id
  LEFT JOIN vehicle_models md ON md.id = l.model_id
  LEFT JOIN body_types    bt ON bt.id = l.body_type_id
  LEFT JOIN users         u  ON u.id  = l.created_by
  LEFT JOIN users         au ON au.id = l.assigned_to
`;

function listLeads(req, res, next) {
  handle(req, res, next, async () => {
    const search = (req.query.search || '').trim();
    const status = req.query.status || '';
    const user   = req.user;

    const conditions = [];
    const params     = [];

    // ── Scope by permission level ──────────────────────────────────────────
    if (!user.is_super_admin && !user.permissions.has('VIEW_LEAD')) {
      if (user.permissions.has('VIEW_TEAM_LEADS')) {
        // Find all callers whose manager_id = this user's id, then include own leads too
        const teamRows = await pool.query(
          `SELECT id FROM users WHERE manager_id = $1`,
          [user.id]
        );
        const teamIds = teamRows.rows.map(r => r.id);
        teamIds.push(user.id); // include manager's own leads as well
        params.push(teamIds);
        conditions.push(`l.created_by = ANY($${params.length})`);
      } else {
        // VIEW_OWN_LEADS — leads they created OR are assigned to
        params.push(user.id);
        conditions.push(`(l.created_by = $${params.length} OR l.assigned_to = $${params.length})`);
      }
    }

    // ── Search & status filters ────────────────────────────────────────────
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(`(LOWER(COALESCE(l.name,'')) LIKE $${params.length} OR l.mobile LIKE $${params.length})`);
    }
    if (status) {
      params.push(status);
      conditions.push(`l.status = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Separate SELECT for list view — adds service/category subqueries in SELECT clause
    const LIST_SELECT = `
      SELECT
        l.id, l.name, l.mobile, l.whatsapp, l.status, l.total_price,
        l.priority, l.tags,
        l.lead_source, l.lost_reason, l.notes, l.created_at, l.updated_at,
        s.name  AS state_name,  l.state_id,
        c.name  AS city_name,   l.city_id,
        a.name  AS area_name,   l.area_id,
        vt.name AS vehicle_type_name, l.vehicle_type_id,
        mk.name AS make_name,   l.make_id,
        md.name AS model_name,  l.model_id,
        bt.name AS body_type_name, l.body_type_id,
        l.segment_ids,
        u.id    AS created_by_id,
        u.name  AS created_by_name,
        au.id   AS assigned_to_id,
        au.name AS assigned_to_name,
        l.assigned_to,
        (SELECT sc.name FROM lead_services ls
          JOIN services sv ON sv.id = ls.service_id
          JOIN service_categories sc ON sc.id = sv.category_id
          WHERE ls.lead_id = l.id ORDER BY ls.id LIMIT 1
        ) AS first_category_name,
        (SELECT sv.name FROM lead_services ls
          JOIN services sv ON sv.id = ls.service_id
          WHERE ls.lead_id = l.id ORDER BY ls.id LIMIT 1
        ) AS first_service_name,
        (SELECT COUNT(*)::int FROM lead_services ls WHERE ls.lead_id = l.id
        ) AS service_count,
        (SELECT sc.name FROM lead_categories lc
          JOIN service_categories sc ON sc.id = lc.category_id
          WHERE lc.lead_id = l.id ORDER BY lc.id LIMIT 1
        ) AS first_cat_interest_name,
        EXISTS (SELECT 1 FROM appointments ap WHERE ap.lead_id = l.id) AS is_converted
      FROM leads l
      LEFT JOIN states        s  ON s.id  = l.state_id
      LEFT JOIN cities        c  ON c.id  = l.city_id
      LEFT JOIN areas         a  ON a.id  = l.area_id
      LEFT JOIN vehicle_types vt ON vt.id = l.vehicle_type_id
      LEFT JOIN vehicle_makes mk ON mk.id = l.make_id
      LEFT JOIN vehicle_models md ON md.id = l.model_id
      LEFT JOIN body_types    bt ON bt.id = l.body_type_id
      LEFT JOIN users         u  ON u.id  = l.created_by
      LEFT JOIN users         au ON au.id = l.assigned_to
    `;

    const r = await pool.query(`${LIST_SELECT} ${where} ORDER BY l.created_at DESC`, params);

    // Tell the frontend what scope was applied so it can show the right heading
    const scope = user.is_super_admin || user.permissions.has('VIEW_LEAD')
      ? 'all'
      : user.permissions.has('VIEW_TEAM_LEADS')
      ? 'team'
      : 'own';

    res.json({ items: r.rows, scope });
  });
}

function getLead(req, res, next) {
  handle(req, res, next, async () => {
    const id = parseInt(req.params.id, 10);
    const leadRow = await pool.query(`${LEAD_SELECT} WHERE l.id = $1`, [id]);
    if (!leadRow.rows[0]) return res.status(404).json({ error: 'Lead not found' });

    // Fetch services for this lead
    const svcRows = await pool.query(
      `SELECT ls.id, ls.service_id, ls.price, sv.name AS service_name, sc.name AS category_name
       FROM lead_services ls
       JOIN services sv ON sv.id = ls.service_id
       JOIN service_categories sc ON sc.id = sv.category_id
       WHERE ls.lead_id = $1
       ORDER BY sc.name, sv.name`,
      [id]
    );

    // Fetch category-level interests for this lead
    const catRows = await pool.query(
      `SELECT lc.id, lc.category_id, sc.name AS category_name
       FROM lead_categories lc
       JOIN service_categories sc ON sc.id = lc.category_id
       WHERE lc.lead_id = $1
       ORDER BY sc.name`,
      [id]
    );

    const lead = leadRow.rows[0];

    // Compute vehicle_in_master (4W) and cc_missing (2W):
    // If the lead has make + model set, check Vehicle Master for completeness.
    // 4W → needs body_type_id on lead (auto-fetched from vehicle_models during import).
    // 2W → needs cc_category_id on the vehicle_models row (not stored on lead, so query live).
    let vehicle_in_master = null;
    let cc_missing = null;

    let engine_cc       = null;
    let cc_category_name = null;

    if (lead.make_id && lead.model_id) {
      const vtName = (lead.vehicle_type_name || '').toLowerCase();
      const is2W   = vtName === '2w' || vtName.includes('two') || vtName.includes('2w') || vtName.includes('2-w');

      if (is2W) {
        // 2W: fetch engine_cc + cc_category name for display, and check completeness
        const vmRow = await pool.query(
          `SELECT vm.engine_cc, vm.cc_category_id, cc.name AS cc_category_name
           FROM vehicle_models vm
           LEFT JOIN cc_categories cc ON cc.id = vm.cc_category_id
           WHERE vm.id = $1`,
          [lead.model_id]
        );
        if (vmRow.rows[0]) {
          engine_cc        = vmRow.rows[0].engine_cc        || null;
          cc_category_name = vmRow.rows[0].cc_category_name || null;
          cc_missing       = vmRow.rows[0].cc_category_id   === null;
        }
        // body_type / vehicle_in_master not relevant for 2W
      } else {
        // 4W (or unknown type): check body_type stored on the lead
        vehicle_in_master = lead.body_type_id !== null;
      }
    }

    res.json({ item: { ...lead, vehicle_in_master, cc_missing, engine_cc, cc_category_name, services: svcRows.rows, categories: catRows.rows } });
  });
}

function updateLead(req, res, next) {
  handle(req, res, next, async () => {
    const id = parseInt(req.params.id, 10);
    const updateSchema = z.object({
      status:          z.string().trim().min(1).max(100).optional(),
      lost_reason:     z.string().trim().max(120).optional().nullable(),
      notes:           z.string().trim().optional().nullable(),
      name:            z.string().trim().max(160).optional().nullable(),
      mobile:          z.string().trim().min(1).max(20).optional(),
      whatsapp:        z.string().trim().max(20).optional().nullable(),
      lead_source:     z.string().trim().max(80).optional().nullable(),
      state_id:        z.coerce.number().int().positive().optional().nullable(),
      city_id:         z.coerce.number().int().positive().optional().nullable(),
      area_id:         z.coerce.number().int().positive().optional().nullable(),
      vehicle_type_id: z.coerce.number().int().positive().optional().nullable(),
      make_id:         z.coerce.number().int().positive().optional().nullable(),
      model_id:        z.coerce.number().int().positive().optional().nullable(),
      body_type_id:    z.coerce.number().int().positive().optional().nullable(),
      cc_category_id:  z.coerce.number().int().positive().optional().nullable(),
      segment_ids:     z.array(z.number().int()).optional(),
      assigned_to:     z.coerce.number().int().positive().optional().nullable(),
      priority:        z.enum(['normal','high','urgent','vip']).optional(),
      tags:            z.array(z.string().trim().max(50)).optional(),
      services:        z.array(z.object({
        service_id: z.coerce.number().int().positive(),
        price:      z.coerce.number().nonnegative(),
      })).optional(),
      category_ids: z.array(z.coerce.number().int().positive()).optional(),
    });
    const data = updateSchema.parse(req.body);
    // cc_category_id is not a column on the leads table — exclude it
    const { services, cc_category_id: _cc, category_ids, ...coreData } = data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Capture current status + assigned_to BEFORE update so we can detect changes after commit
      const prevLeadRow = await client.query(
        `SELECT l.assigned_to, l.status, l.name, l.mobile,
                u.name AS assigned_to_name
         FROM leads l
         LEFT JOIN users u ON u.id = l.assigned_to
         WHERE l.id = $1`, [id]
      );
      const prevLead = prevLeadRow.rows[0];

      // Block assigned_to changes once lead is converted to an appointment
      if ('assigned_to' in coreData) {
        const convCheck = await client.query(
          `SELECT 1 FROM appointments WHERE lead_id = $1 LIMIT 1`, [id]
        );
        if (convCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Cannot reassign a lead that has already been converted to an appointment.' });
        }
      }

      // Update core lead fields if any provided
      const fields = [];
      const params = [];
      for (const [key, val] of Object.entries(coreData)) {
        params.push(val);
        fields.push(`${key} = $${params.length}`);
      }

      // Replace services if provided
      let prevServices = [];
      if (services !== undefined) {
        // Capture old services BEFORE deleting so we can log what changed
        const prevSvcRes = await client.query(
          `SELECT s.id, s.name FROM lead_services ls
           JOIN services s ON s.id = ls.service_id
           WHERE ls.lead_id = $1`, [id]
        );
        prevServices = prevSvcRes.rows;

        await client.query('DELETE FROM lead_services WHERE lead_id = $1', [id]);
        for (const s of services) {
          await client.query(
            'INSERT INTO lead_services (lead_id, service_id, price) VALUES ($1, $2, $3)',
            [id, s.service_id, s.price]
          );
        }
        const totalPrice = services.reduce((sum, s) => sum + s.price, 0);
        params.push(totalPrice);
        fields.push(`total_price = $${params.length}`);
      }

      // Replace category-level interests if provided
      if (category_ids !== undefined) {
        await client.query('DELETE FROM lead_categories WHERE lead_id = $1', [id]);
        for (const catId of category_ids) {
          await client.query(
            'INSERT INTO lead_categories (lead_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [id, catId]
          );
        }
      }

      if (fields.length) {
        params.push(id);
        const r = await client.query(
          `UPDATE leads SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING id`,
          params
        );
        if (!r.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Lead not found' }); }
      }

      // ── Schedule a follow-up event if the frontend provided a date ──────────
      // (The old auto-timing via follow_up_days/follow_up_hours has been replaced
      //  by the manual follow-up modal on the frontend.)
      if (req.body.follow_up_date) {
        // Close any existing open follow-ups for this lead
        await client.query(
          `UPDATE lead_events SET is_done = TRUE, done_at = NOW()
           WHERE lead_id = $1 AND is_done = FALSE`,
          [id]
        );

        // Build due_at from the provided date + optional time
        const dateStr = req.body.follow_up_date;                         // 'YYYY-MM-DD'
        const timeStr = req.body.follow_up_time || '09:00';              // 'HH:MM'
        const dueAt   = new Date(`${dateStr}T${timeStr}:00`);

        await client.query(
          `INSERT INTO lead_events (lead_id, status_name, due_date, due_at, note)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, coreData.status, dateStr, dueAt.toISOString(), req.body.follow_up_note || 'Follow-up scheduled']
        );

        // Notify the lead's creator, assigned agent, and the person who scheduled it.
        // Use client (inside transaction) so we read the already-updated assigned_to.
        const leadRow = await client.query(
          `SELECT created_by, assigned_to, name, mobile FROM leads WHERE id = $1`, [id]
        );
        const leadMeta   = leadRow.rows[0];
        const leadLabel  = leadMeta?.name || leadMeta?.mobile || `Lead #${id}`;
        const notifyUsers = [...new Set(
          [leadMeta?.created_by, leadMeta?.assigned_to, req.user.id].filter(Boolean)
        )];
        for (const uid of notifyUsers) {
          await client.query(
            `INSERT INTO notifications (user_id, type, title, body, lead_id)
             VALUES ($1, 'follow_up_scheduled', $2, $3, $4)`,
            [uid, `Follow-up scheduled`, `Follow up for "${leadLabel}" on ${dateStr} at ${timeStr}`, id]
          );
        }
      }

      // ── Log status change to activity timeline ─────────────────────────
      if (coreData.status && coreData.status !== prevLead?.status) {
        const actNote = coreData.lost_reason ? `Lost reason: ${coreData.lost_reason}` : null;
        await client.query(
          `INSERT INTO lead_activities (lead_id, type, old_value, new_value, note, created_by)
           VALUES ($1, 'status_changed', $2, $3, $4, $5)`,
          [id, prevLead?.status || null, coreData.status, actNote, req.user.id]
        );
      }

      // ── Log assignment change ───────────────────────────────────────────
      if ('assigned_to' in coreData && coreData.assigned_to !== (prevLead?.assigned_to ?? null)) {
        let newAssigneeName = null;
        if (coreData.assigned_to) {
          const nr = await client.query(`SELECT name FROM users WHERE id = $1`, [coreData.assigned_to]);
          newAssigneeName = nr.rows[0]?.name || `User #${coreData.assigned_to}`;
        }
        await client.query(
          `INSERT INTO lead_activities (lead_id, type, old_value, new_value, created_by)
           VALUES ($1, 'assigned_changed', $2, $3, $4)`,
          [id, prevLead?.assigned_to_name || null, newAssigneeName, req.user.id]
        );
      }

      // ── Log service changes ─────────────────────────────────────────────
      if (services !== undefined) {
        const newServiceIds = new Set(services.map(s => s.service_id));
        const oldServiceIds = new Set(prevServices.map(s => s.id));

        // Removed services
        for (const svc of prevServices) {
          if (!newServiceIds.has(svc.id)) {
            await client.query(
              `INSERT INTO lead_activities (lead_id, type, old_value, new_value, created_by)
               VALUES ($1, 'service_removed', $2, NULL, $3)`,
              [id, svc.name, req.user.id]
            );
          }
        }

        // Added services — fetch names for new service ids
        for (const s of services) {
          if (!oldServiceIds.has(s.service_id)) {
            const svcRow = await client.query(`SELECT name FROM services WHERE id = $1`, [s.service_id]);
            const svcName = svcRow.rows[0]?.name || `Service #${s.service_id}`;
            await client.query(
              `INSERT INTO lead_activities (lead_id, type, old_value, new_value, created_by)
               VALUES ($1, 'service_added', NULL, $2, $3)`,
              [id, svcName, req.user.id]
            );
          }
        }
      }

      await client.query('COMMIT');

      // ── Notify assignee if assigned_to changed ──────────────────────────
      if ('assigned_to' in coreData && coreData.assigned_to) {
        // prevLead was captured before the update so this comparison is correct
        const isNewAssignment = prevLead?.assigned_to !== coreData.assigned_to;
        if (isNewAssignment) {
          const assignerRow = await pool.query(
            `SELECT name FROM users WHERE id = $1`, [req.user.id]
          );
          const assignerName = assignerRow.rows[0]?.name || 'Someone';
          const parts = [prevLead?.name, prevLead?.mobile].filter(Boolean);
          const leadLabel = parts.join(' • ') || `Lead #${id}`;
          await pool.query(
            `INSERT INTO notifications (user_id, type, title, body, lead_id)
             VALUES ($1, 'lead_assigned', $2, $3, $4)`,
            [
              coreData.assigned_to,
              `Lead assigned to you by ${assignerName}`,
              `${leadLabel}`,
              id,
            ]
          );
        }
      }

      // ── Alert #9 Lead Conversion ─────────────────────────────────────────
      if (coreData.status) {
        const conversionStatuses = ['won', 'converted', 'closed won'];
        if (conversionStatuses.includes(coreData.status.toLowerCase())) {
          fireLeadConversionAlert(id, req.user.id).catch(() => {});
        }
      }

      // ── Alert #2 High Priority (on update) ───────────────────────────────
      if (coreData.priority || coreData.tags || (coreData.services !== undefined)) {
        fireHighPriorityAlert(id).catch(() => {});
      }

      const full = await pool.query(`${LEAD_SELECT} WHERE l.id = $1`, [id]);
      res.json({ item: full.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

function deleteLead(req, res, next) {
  handle(req, res, next, async () => {
    const id = parseInt(req.params.id, 10);
    const r = await pool.query('DELETE FROM leads WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Lead not found' });
    logActivity({ userId: req.user?.id, userName: req.user?.name, action: 'DELETE', entity: 'lead', entityId: id, description: `Deleted lead #${id}` });
    res.status(204).end();
  });
}

function createLead(req, res, next) {
  handle(req, res, next, async () => {
    const data = leadSchema.parse(req.body);
    const userId = req.user.id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const totalPrice = data.services.reduce((sum, s) => sum + s.price, 0);

      // status = NULL means "New Lead" — no status assigned yet
      // Only use data.status if explicitly passed
      const initialStatus = data.status || null;

      const leadRes = await client.query(
        `INSERT INTO leads (
          name, mobile, whatsapp, state_id, city_id, area_id,
          vehicle_type_id, make_id, model_id, body_type_id, segment_ids,
          lead_source, status, total_price, notes, created_by, assigned_to,
          priority, tags
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
          $18, $19
        ) RETURNING id`,
        [
          data.name, data.mobile, data.whatsapp || null,
          data.state_id || null, data.city_id || null, data.area_id || null,
          data.vehicle_type_id || null, data.make_id || null, data.model_id || null,
          data.body_type_id || null, data.segment_ids,
          data.lead_source || null, initialStatus, totalPrice, data.notes || null,
          userId, data.assigned_to || null,
          data.priority || 'normal', data.tags || [],
        ]
      );

      const leadId = leadRes.rows[0].id;

      for (const s of data.services) {
        await client.query(
          'INSERT INTO lead_services (lead_id, service_id, price) VALUES ($1, $2, $3)',
          [leadId, s.service_id, s.price]
        );
      }

      // Save category-level interests (leads where only category is known, no specific service)
      for (const catId of (data.category_ids || [])) {
        await client.query(
          'INSERT INTO lead_categories (lead_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [leadId, catId]
        );
      }

      // Follow-up events on lead creation are no longer auto-scheduled by timing config.
      // They are created manually via the follow-up modal when a status with
      // needs_follow_up = true is selected on the lead.

      // ── Log lead creation to activity timeline ──────────────────────────
      await client.query(
        `INSERT INTO lead_activities (lead_id, type, old_value, new_value, created_by)
         VALUES ($1, 'created', NULL, $2, $3)`,
        [leadId, initialStatus || null, req.user.id]
      );

      await client.query('COMMIT');

      // ── Activity log ────────────────────────────────────────────────────
      logActivity({ userId, userName: req.user.name, action: 'CREATE', entity: 'lead', entityId: leadId, description: `Created lead for ${data.name || data.mobile}` });

      // ── Alert #7 Duplicate Lead ─────────────────────────────────────────
      fireDuplicateLeadAlert(leadId, data.mobile, userId).catch(() => {});

      // ── Alert #2 High Priority ──────────────────────────────────────────
      fireHighPriorityAlert(leadId).catch(() => {});

      res.status(201).json({ id: leadId });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

// =====================================================================
// PRICING LOOKUP
// =====================================================================

function lookupPrice(req, res, next) {
  handle(req, res, next, async () => {
    const {
      service_id, vehicle_type_id, body_type_id, segment_id,
      make_id, model_id, cc_category_id,
    } = lookupSchema.parse(req.body);

    // Shared dimension args (same for both service-level and category-level queries)
    const dims = [
      vehicle_type_id || null,
      body_type_id    || null,
      segment_id      || null,
      make_id         || null,
      model_id        || null,
      cc_category_id  || null,
    ];

    // Specificity scoring: model(64) > make(32) > segment/body_type/cc_category(8) > vehicle_type(4)
    // A NULL dimension on a rule means "match any value" for that dimension.
    const DIM_FILTER = `
         AND (vehicle_type_id IS NULL OR vehicle_type_id = $2)
         AND (body_type_id    IS NULL OR body_type_id    = $3)
         AND (segment_id      IS NULL OR segment_id      = $4)
         AND (make_id         IS NULL OR make_id         = $5)
         AND (model_id        IS NULL OR model_id        = $6)
         AND (cc_category_id  IS NULL OR cc_category_id  = $7)
       ORDER BY
         (CASE WHEN model_id        IS NOT NULL THEN 64 ELSE 0 END +
          CASE WHEN make_id         IS NOT NULL THEN 32 ELSE 0 END +
          CASE WHEN segment_id      IS NOT NULL THEN  8 ELSE 0 END +
          CASE WHEN body_type_id    IS NOT NULL THEN  8 ELSE 0 END +
          CASE WHEN cc_category_id  IS NOT NULL THEN  8 ELSE 0 END +
          CASE WHEN vehicle_type_id IS NOT NULL THEN  4 ELSE 0 END) DESC
       LIMIT 1`;

    // ── Step 1: service-level rules ──────────────────────────────────────────
    const svcResult = await pool.query(
      `SELECT price FROM pricing
       WHERE service_id = $1 AND is_active = TRUE ${DIM_FILTER}`,
      [service_id, ...dims]
    );

    if (svcResult.rowCount > 0) {
      return res.json({ price: Number(svcResult.rows[0].price), source: 'service' });
    }

    // ── Step 2: category-level fallback ──────────────────────────────────────
    // Look up the service's parent category, then search category-level rules.
    const catRow = await pool.query(
      `SELECT category_id FROM services WHERE id = $1`,
      [service_id]
    );
    if (catRow.rowCount === 0) return res.json({ price: null });

    const categoryId = catRow.rows[0].category_id;
    const catResult  = await pool.query(
      `SELECT price FROM pricing
       WHERE category_id = $1 AND is_active = TRUE ${DIM_FILTER}`,
      [categoryId, ...dims]
    );

    if (catResult.rowCount > 0) {
      return res.json({ price: Number(catResult.rows[0].price), source: 'category' });
    }

    res.json({ price: null });
  });
}

// ── Export leads as CSV ───────────────────────────────────────────────────────
function exportLeads(req, res, next) {
  handle(req, res, next, async () => {
    const search = (req.query.search || '').trim();
    const status = req.query.status || '';
    const user   = req.user;

    const conditions = [];
    const params     = [];

    // Same scope rules as listLeads
    if (!user.is_super_admin && !user.permissions.has('VIEW_LEAD')) {
      if (user.permissions.has('VIEW_TEAM_LEADS')) {
        const teamRows = await pool.query(
          `SELECT id FROM users WHERE manager_id = $1`, [user.id]
        );
        const teamIds = teamRows.rows.map(r => r.id);
        teamIds.push(user.id);
        params.push(teamIds);
        conditions.push(`l.created_by = ANY($${params.length})`);
      } else {
        // VIEW_OWN_LEADS — leads they created OR are assigned to
        params.push(user.id);
        conditions.push(`(l.created_by = $${params.length} OR l.assigned_to = $${params.length})`);
      }
    }

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(`(LOWER(COALESCE(l.name,'')) LIKE $${params.length} OR l.mobile LIKE $${params.length})`);
    }
    if (status) {
      params.push(status);
      conditions.push(`l.status = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const r = await pool.query(`${LEAD_SELECT} ${where} ORDER BY l.created_at DESC`, params);

    // Build CSV
    const csvEscape = v => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const headers = [
      'ID', 'Name', 'Mobile', 'WhatsApp', 'Status',
      'State', 'City', 'Area',
      'Vehicle Type', 'Make', 'Model', 'Body Type',
      'Lead Source', 'Total Price',
      'Assigned To', 'Created By', 'Created At',
    ];

    const rows = r.rows.map(l => [
      l.id,
      l.name || '',
      l.mobile || '',
      l.whatsapp || '',
      l.status || '',
      l.state_name || '',
      l.city_name || '',
      l.area_name || '',
      l.vehicle_type_name || '',
      l.make_name || '',
      l.model_name || '',
      l.body_type_name || '',
      l.lead_source || '',
      l.total_price || '',
      l.assigned_to_name || '',
      l.created_by_name || '',
      l.created_at ? new Date(l.created_at).toISOString().slice(0, 19).replace('T', ' ') : '',
    ].map(csvEscape).join(','));

    const csv = [headers.join(','), ...rows].join('\r\n');
    const date = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads_${date}.csv"`);
    res.send('﻿' + csv); // BOM for Excel UTF-8 compatibility
  });
}

// ── Stage Conversion Time (Step 4) ───────────────────────────────────────────
// Returns avg seconds each status holds a lead, computed from lead_activities.
async function getStageStats(req, res) {
  try {
    const { rows } = await pool.query(`
      WITH ordered AS (
        SELECT
          lead_id,
          CASE WHEN type = 'created' THEN 'New Lead' ELSE new_value END AS status,
          created_at,
          LEAD(created_at) OVER (PARTITION BY lead_id ORDER BY created_at) AS next_at
        FROM lead_activities
        WHERE type IN ('status_changed', 'created')
      )
      SELECT
        status,
        ROUND(AVG(EXTRACT(EPOCH FROM (next_at - created_at))))::int AS avg_seconds,
        COUNT(*)::int AS sample_count
      FROM ordered
      WHERE next_at IS NOT NULL
      GROUP BY status
      ORDER BY avg_seconds DESC
    `);
    res.json({ items: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ── Bulk Assign ──────────────────────────────────────────────────────────────
function bulkAssign(req, res, next) {
  handle(req, res, next, async () => {
    const schema = z.object({
      lead_ids:    z.array(z.coerce.number().int().positive()).min(1),
      assigned_to: z.coerce.number().int().positive(),
    });
    const { lead_ids, assigned_to } = schema.parse(req.body);

    // Exclude leads that have already been converted to an appointment
    const convertedRes = await pool.query(
      `SELECT lead_id FROM appointments WHERE lead_id = ANY($1)`,
      [lead_ids]
    );
    const convertedIds = new Set(convertedRes.rows.map(r => r.lead_id));
    const assignable_ids = lead_ids.filter(id => !convertedIds.has(id));

    if (!assignable_ids.length) {
      return res.status(400).json({ error: 'All selected leads are already converted to appointments and cannot be reassigned.' });
    }

    // Capture old assigned_to names before updating (for activity log)
    const prevAssignedRes = await pool.query(
      `SELECT l.id, u.name AS assigned_to_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_to
       WHERE l.id = ANY($1)`,
      [assignable_ids]
    );
    const prevAssignedMap = Object.fromEntries(prevAssignedRes.rows.map(r => [r.id, r.assigned_to_name]));

    await pool.query(
      `UPDATE leads SET assigned_to = $1, updated_at = NOW() WHERE id = ANY($2)`,
      [assigned_to, assignable_ids]
    );

    // Notify the assigned user for each lead
    const assignerRow = await pool.query(`SELECT name FROM users WHERE id = $1`, [req.user.id]);
    const assignerName = assignerRow.rows[0]?.name || 'Someone';

    // Get new assignee name for activity log
    const newAssigneeRow = await pool.query(`SELECT name FROM users WHERE id = $1`, [assigned_to]);
    const newAssigneeName = newAssigneeRow.rows[0]?.name || `User #${assigned_to}`;

    for (const leadId of assignable_ids) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, body, lead_id)
         VALUES ($1, 'lead_assigned', $2, $3, $4)`,
        [assigned_to, `Lead assigned to you by ${assignerName}`, `Lead #${leadId} assigned`, leadId]
      );
      // Log assignment change to activity timeline
      await pool.query(
        `INSERT INTO lead_activities (lead_id, type, old_value, new_value, created_by)
         VALUES ($1, 'assigned_changed', $2, $3, $4)`,
        [leadId, prevAssignedMap[leadId] || null, newAssigneeName, req.user.id]
      );
    }

    res.json({ updated: assignable_ids.length, skipped_converted: convertedIds.size });
  });
}

// ── Bulk Delete ───────────────────────────────────────────────────────────────
function bulkDelete(req, res, next) {
  handle(req, res, next, async () => {
    const schema = z.object({
      lead_ids: z.array(z.coerce.number().int().positive()).min(1),
    });
    const { lead_ids } = schema.parse(req.body);

    const r = await pool.query(
      `DELETE FROM leads WHERE id = ANY($1)`,
      [lead_ids]
    );

    logActivity({
      userId:      req.user?.id,
      userName:    req.user?.name,
      action:      'DELETE',
      entity:      'lead',
      description: `Bulk deleted ${r.rowCount} lead(s): IDs ${lead_ids.join(', ')}`,
    });

    res.json({ deleted: r.rowCount });
  });
}

// ── GET /api/leads/check-mobile?mobile=xxx&exclude_id=yyy ─────────────────────
async function checkMobile(req, res, next) {
  try {
    const mobile     = (req.query.mobile || '').trim();
    const excludeId  = parseInt(req.query.exclude_id, 10) || 0;
    if (!mobile) return res.json({ duplicates: [] });

    // Only return leads that are still OPEN (not yet converted to an appointment,
    // not lost, not cancelled). Leads that already have an appointment linked are
    // excluded — they are done; showing them as duplicates is misleading.
    const r = await pool.query(
      `SELECT l.id, l.name, l.mobile, l.status, l.created_at,
              u.name AS created_by_name
         FROM leads l
         LEFT JOIN users          u   ON u.id  = l.created_by
         LEFT JOIN lead_statuses  ls  ON LOWER(ls.name) = LOWER(l.status)
        WHERE l.mobile = $1
          ${excludeId ? 'AND l.id != $2' : ''}
          -- Exclude leads that already have an appointment created from them
          AND NOT EXISTS (
            SELECT 1 FROM appointments a WHERE a.lead_id = l.id
          )
          -- Exclude leads whose status is non-pipeline (converted / lost / cancelled)
          AND COALESCE(ls.is_pipeline, TRUE) = TRUE
          AND COALESCE(ls.converts_to_appointment, FALSE) = FALSE
        ORDER BY l.created_at DESC LIMIT 5`,
      excludeId ? [mobile, excludeId] : [mobile]
    );
    res.json({ duplicates: r.rows });
  } catch (err) { next(err); }
}

module.exports = {
  listLeads, getLead, createLead, updateLead, deleteLead, lookupPrice, exportLeads, getStageStats, bulkAssign, bulkDelete, checkMobile,
};
