const { z } = require('zod');
const { pool } = require('../config/db');
const { getIO } = require('../socket');

// ── Validators ────────────────────────────────────────────────────────────────
const VALID_DIMENSIONS = ['vehicle_type', 'body_type', 'segment', 'make', 'model', 'cc_category'];

const categorySchema = z.object({
  name:           z.string().trim().min(1).max(120),
  description:    z.string().trim().optional().nullable(),
  is_active:      z.boolean().optional(),
  pricing_config: z.array(z.enum(['vehicle_type', 'body_type', 'segment', 'make', 'model', 'cc_category'])).optional(),
  vehicle_class:  z.enum(['2W', '4W', 'both']).optional().default('both'),
});

const serviceSchema = z.object({
  category_id:   z.coerce.number().int().positive(),
  name:          z.string().trim().min(1).max(160),
  description:   z.string().trim().optional().nullable(),
  is_active:     z.boolean().optional(),
  vehicle_class: z.enum(['2W', '4W', 'both']).optional().default('both'),
  customer_rate: z.coerce.number().min(0).optional().nullable(),
  gst_percent:   z.coerce.number().min(0).max(100).optional().nullable(),
  sac_code:      z.string().trim().max(20).optional().nullable(),
});

const idParam = z.coerce.number().int().positive();

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch((err) => {
    if (err.name === 'ZodError')
      return res.status(400).json({ error: err.errors.map((e) => e.message).join('; ') });
    if (err.code === '23505')
      return res.status(409).json({ error: 'Already exists' });
    if (err.code === '23503')
      return res.status(409).json({ error: 'In use — cannot delete' });
    next(err);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVICE CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════
function listCategories(req, res, next) {
  handle(req, res, next, async () => {
    const search       = req.query.search       ? `%${req.query.search}%` : null;
    const vehicleClass = req.query.vehicle_class || null; // '2W' | '4W' | null = all
    const r = await pool.query(
      `SELECT sc.id, sc.name, sc.description, sc.is_active, sc.pricing_config, sc.vehicle_class,
              COUNT(s.id)::int AS service_count
         FROM service_categories sc
         LEFT JOIN services s ON s.category_id = sc.id
        WHERE ($1::text IS NULL OR sc.name ILIKE $1)
          AND ($2::text IS NULL OR sc.vehicle_class = $2 OR sc.vehicle_class = 'both')
        GROUP BY sc.id
        ORDER BY sc.sort_order ASC, sc.name ASC`,
      [search, vehicleClass]
    );
    res.json({ items: r.rows });
  });
}

function createCategory(req, res, next) {
  handle(req, res, next, async () => {
    const data = categorySchema.parse(req.body);
    const r = await pool.query(
      `INSERT INTO service_categories (name, description, is_active, pricing_config, vehicle_class)
       VALUES ($1, $2, COALESCE($3, TRUE), COALESCE($4, '[]'::jsonb), COALESCE($5, 'both'))
       RETURNING id, name, description, is_active, pricing_config, vehicle_class`,
      [data.name, data.description ?? null, data.is_active, data.pricing_config ? JSON.stringify(data.pricing_config) : null, data.vehicle_class ?? null]
    );
    getIO().emit('invalidate', { topic: 'services' });
    res.status(201).json({ item: r.rows[0] });
  });
}

function updateCategory(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = categorySchema.partial().parse(req.body);

    const fields = [];
    const values = [];
    let   n      = 1;

    if (data.name           !== undefined) { fields.push(`name = $${n++}`);            values.push(data.name); }
    if (data.description    !== undefined) { fields.push(`description = $${n++}`);     values.push(data.description ?? null); }
    if (data.is_active      !== undefined) { fields.push(`is_active = $${n++}`);       values.push(data.is_active); }
    if (data.pricing_config !== undefined) { fields.push(`pricing_config = $${n++}`);  values.push(JSON.stringify(data.pricing_config)); }
    if (data.vehicle_class  !== undefined) { fields.push(`vehicle_class = $${n++}`);   values.push(data.vehicle_class); }

    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

    values.push(id);
    const r = await pool.query(
      `UPDATE service_categories SET ${fields.join(', ')} WHERE id = $${n}
       RETURNING id, name, description, is_active, pricing_config, vehicle_class`,
      values
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Category not found' });
    getIO().emit('invalidate', { topic: 'services' });
    res.json({ item: r.rows[0] });
  });
}

function deleteCategory(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query('DELETE FROM service_categories WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Category not found' });
    getIO().emit('invalidate', { topic: 'services' });
    res.status(204).end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVICE ITEMS
// ═══════════════════════════════════════════════════════════════════════════
function listServices(req, res, next) {
  handle(req, res, next, async () => {
    const categoryId   = req.query.category_id ? idParam.parse(req.query.category_id) : null;
    const search       = req.query.search ? `%${req.query.search}%` : null;
    // vehicle_class filter: '2W' or '4W' → return matching + 'both'; omit → return all
    const vehicleClass = req.query.vehicle_class || null; // '2W' | '4W' | null

    const r = await pool.query(
      `SELECT s.id, s.category_id, sc.name AS category_name,
              s.name, s.description, s.is_active, s.vehicle_class,
              s.customer_rate, s.gst_percent, s.sac_code
         FROM services s
         JOIN service_categories sc ON sc.id = s.category_id
        WHERE ($1::int IS NULL OR s.category_id = $1)
          AND ($2::text IS NULL OR s.name ILIKE $2)
          AND ($3::text IS NULL OR s.vehicle_class = $3 OR s.vehicle_class = 'both')
        ORDER BY s.sort_order ASC, s.name ASC`,
      [categoryId, search, vehicleClass]
    );
    res.json({ items: r.rows });
  });
}

function getService(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query(
      `SELECT s.id, s.category_id, sc.name AS category_name,
              s.name, s.description, s.is_active, s.vehicle_class,
              s.customer_rate, s.gst_percent, s.sac_code
         FROM services s
         JOIN service_categories sc ON sc.id = s.category_id
        WHERE s.id = $1`,
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Service not found' });
    res.json({ item: r.rows[0] });
  });
}

function createService(req, res, next) {
  handle(req, res, next, async () => {
    const data = serviceSchema.parse(req.body);
    const r    = await pool.query(
      `INSERT INTO services (category_id, name, description, is_active, vehicle_class, customer_rate, gst_percent, sac_code)
       VALUES ($1, $2, $3, COALESCE($4, TRUE), COALESCE($5, 'both'), $6, $7, $8)
       RETURNING id, category_id, name, description, is_active, vehicle_class, customer_rate, gst_percent, sac_code`,
      [data.category_id, data.name, data.description ?? null, data.is_active, data.vehicle_class ?? null,
       data.customer_rate ?? null, data.gst_percent ?? null, data.sac_code ?? null]
    );
    getIO().emit('invalidate', { topic: 'services' });
    res.status(201).json({ item: r.rows[0] });
  });
}

function updateService(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = serviceSchema.partial().parse(req.body);
    const r    = await pool.query(
      `UPDATE services
          SET category_id   = COALESCE($1, category_id),
              name          = COALESCE($2, name),
              description   = COALESCE($3, description),
              is_active     = COALESCE($4, is_active),
              vehicle_class = COALESCE($5, vehicle_class),
              customer_rate = COALESCE($6, customer_rate),
              gst_percent   = COALESCE($7, gst_percent),
              sac_code      = COALESCE($8, sac_code)
        WHERE id = $9
        RETURNING id, category_id, name, description, is_active, vehicle_class, customer_rate, gst_percent, sac_code`,
      [data.category_id ?? null, data.name ?? null, data.description ?? null,
       data.is_active ?? null, data.vehicle_class ?? null,
       data.customer_rate ?? null, data.gst_percent ?? null, data.sac_code ?? null, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Service not found' });
    getIO().emit('invalidate', { topic: 'services' });
    res.json({ item: r.rows[0] });
  });
}

function deleteService(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query('DELETE FROM services WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Service not found' });
    getIO().emit('invalidate', { topic: 'services' });
    res.status(204).end();
  });
}

// GET /api/services/services/:id/hubs
// Reverse lookup for hub_service_mappings — which hubs have this service assigned.
function getServiceHubs(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    const svcCheck = await pool.query('SELECT id FROM services WHERE id = $1', [id]);
    if (svcCheck.rowCount === 0) return res.status(404).json({ error: 'Service not found' });

    const r = await pool.query(
      `SELECT h.id, h.hub_name, h.vehicle_class, h.is_active
         FROM hub_service_mappings hsm
         JOIN hubs h ON h.id = hsm.hub_id AND h.deleted_at IS NULL
        WHERE hsm.service_id = $1
        ORDER BY h.hub_name ASC`,
      [id]
    );
    res.json({ items: r.rows });
  });
}

// Body schema for assigning a service to a hub
const assignHubSchema = z.object({
  hub_id: z.coerce.number().int().positive(),
});

// Vehicle class compatibility check — mirrors hubs.controller.js's hubVcToSvcVc logic.
// 'both' is always compatible with anything; otherwise the two classes must match.
function vcCompatible(hubVc, svcVc) {
  if (hubVc === 'both' || svcVc === 'both') return true;
  return hubVc === svcVc;
}

// POST /api/services/services/:id/hubs
// Assigns this service (and its category, as a fallback mapping) to a hub.
function assignServiceToHub(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = assignHubSchema.parse(req.body);

    const svcRes = await pool.query(
      'SELECT id, category_id, vehicle_class FROM services WHERE id = $1', [id]
    );
    if (svcRes.rowCount === 0) return res.status(404).json({ error: 'Service not found' });
    const svc = svcRes.rows[0];

    const hubRes = await pool.query(
      'SELECT id, vehicle_class FROM hubs WHERE id = $1 AND deleted_at IS NULL', [data.hub_id]
    );
    if (hubRes.rowCount === 0) return res.status(404).json({ error: 'HUB not found' });
    const hub = hubRes.rows[0];

    if (!vcCompatible(hub.vehicle_class, svc.vehicle_class)) {
      return res.status(400).json({
        error: `Vehicle class mismatch — this service is ${svc.vehicle_class} but the hub is ${hub.vehicle_class}`,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Ensure the category fallback mapping exists too — the hub's own dashboard
      // (HubDashboardPage ServicesTab) filters on category_mapped as well as service_mapped.
      await client.query(
        'INSERT INTO hub_category_mappings (hub_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [data.hub_id, svc.category_id]
      );
      await client.query(
        `INSERT INTO hub_service_mappings (hub_id, service_id, category_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [data.hub_id, id, svc.category_id]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({ success: true });
  });
}

// DELETE /api/services/services/:id/hubs/:hubId
// Removes just this service's mapping for the hub — leaves the category
// mapping in place (other services in the category may still be assigned).
function unassignServiceFromHub(req, res, next) {
  handle(req, res, next, async () => {
    const id    = idParam.parse(req.params.id);
    const hubId = idParam.parse(req.params.hubId);

    const r = await pool.query(
      'DELETE FROM hub_service_mappings WHERE hub_id = $1 AND service_id = $2',
      [hubId, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'This service is not assigned to that hub' });

    res.status(204).end();
  });
}

// GET /api/services/categories/:id/hubs
// Reverse lookup for hub_category_mappings — which hubs have this category assigned.
function getCategoryHubs(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);

    const catCheck = await pool.query('SELECT id FROM service_categories WHERE id = $1', [id]);
    if (catCheck.rowCount === 0) return res.status(404).json({ error: 'Category not found' });

    const r = await pool.query(
      `SELECT h.id, h.hub_name, h.vehicle_class, h.is_active
         FROM hub_category_mappings hcm
         JOIN hubs h ON h.id = hcm.hub_id AND h.deleted_at IS NULL
        WHERE hcm.category_id = $1
        ORDER BY h.hub_name ASC`,
      [id]
    );
    res.json({ items: r.rows });
  });
}

// POST /api/services/categories/:id/hubs
// Assigns a hub to a whole category — bulk-assigns every active service under
// the category to the hub (same effect as checking the category in the Hub
// page's "Manage Services" modal and hitting "Select All"), so the hub can
// actually use these services elsewhere (AppointmentsPage / HubDashboardPage
// both key off individual service_mapped rows, not just the category flag).
function assignCategoryToHub(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = assignHubSchema.parse(req.body);

    const catRes = await pool.query(
      'SELECT id, vehicle_class FROM service_categories WHERE id = $1', [id]
    );
    if (catRes.rowCount === 0) return res.status(404).json({ error: 'Category not found' });
    const cat = catRes.rows[0];

    const hubRes = await pool.query(
      'SELECT id, vehicle_class FROM hubs WHERE id = $1 AND deleted_at IS NULL', [data.hub_id]
    );
    if (hubRes.rowCount === 0) return res.status(404).json({ error: 'HUB not found' });
    const hub = hubRes.rows[0];

    if (!vcCompatible(hub.vehicle_class, cat.vehicle_class)) {
      return res.status(400).json({
        error: `Vehicle class mismatch — this category is ${cat.vehicle_class} but the hub is ${hub.vehicle_class}`,
      });
    }

    const client = await pool.connect();
    let assignedCount = 0;
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO hub_category_mappings (hub_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [data.hub_id, id]
      );

      const svcRes = await client.query(
        'SELECT id FROM services WHERE category_id = $1 AND is_active = TRUE', [id]
      );
      for (const svc of svcRes.rows) {
        await client.query(
          `INSERT INTO hub_service_mappings (hub_id, service_id, category_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [data.hub_id, svc.id, id]
        );
      }
      assignedCount = svcRes.rows.length;

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({ success: true, services_assigned: assignedCount });
  });
}

// DELETE /api/services/categories/:id/hubs/:hubId
// Unassigns a hub from a whole category — mirrors assignCategoryToHub by also
// removing every one of that category's hub_service_mappings rows for the hub,
// so the hub cleanly loses everything it gained when the category was assigned.
function unassignCategoryFromHub(req, res, next) {
  handle(req, res, next, async () => {
    const id    = idParam.parse(req.params.id);
    const hubId = idParam.parse(req.params.hubId);

    const client = await pool.connect();
    let svcRemoved = 0, catRemoved = 0;
    try {
      await client.query('BEGIN');
      const svcDel = await client.query(
        'DELETE FROM hub_service_mappings WHERE hub_id = $1 AND category_id = $2',
        [hubId, id]
      );
      svcRemoved = svcDel.rowCount;

      const catDel = await client.query(
        'DELETE FROM hub_category_mappings WHERE hub_id = $1 AND category_id = $2',
        [hubId, id]
      );
      catRemoved = catDel.rowCount;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (svcRemoved === 0 && catRemoved === 0) {
      return res.status(404).json({ error: 'This category is not assigned to that hub' });
    }
    res.status(204).end();
  });
}

function reorderCategories(req, res, next) {
  handle(req, res, next, async () => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < ids.length; i++) {
        await client.query('UPDATE service_categories SET sort_order = $1 WHERE id = $2', [i + 1, ids[i]]);
      }
      await client.query('COMMIT');
      getIO().emit('invalidate', { topic: 'services' });
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

function reorderServices(req, res, next) {
  handle(req, res, next, async () => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < ids.length; i++) {
        await client.query('UPDATE services SET sort_order = $1 WHERE id = $2', [i + 1, ids[i]]);
      }
      await client.query('COMMIT');
      getIO().emit('invalidate', { topic: 'services' });
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

module.exports = {
  listCategories, createCategory, updateCategory, deleteCategory, reorderCategories,
  listServices, getService, createService, updateService, deleteService, reorderServices,
  getServiceHubs, assignServiceToHub, unassignServiceFromHub,
  getCategoryHubs, assignCategoryToHub, unassignCategoryFromHub,
};
