const { z } = require('zod');
const { pool } = require('../config/db');

// ---------- validators ----------
const idParam = z.coerce.number().int().positive();

const typeSchema    = z.object({
  name: z.string().trim().min(1).max(60),
  is_active: z.boolean().optional(),
});
const makeSchema    = z.object({
  vehicle_type_id: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(80),
  is_active: z.boolean().optional(),
});
const modelSchema   = z.object({
  make_id: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  is_active: z.boolean().optional(),
});
const segmentSchema = z.object({
  name: z.string().trim().min(1).max(40),
  is_active: z.boolean().optional(),
});
const bodySchema    = z.object({
  name: z.string().trim().min(1).max(60),
  is_active: z.boolean().optional(),
});

// Re-usable error funnel
function handle(req, res, next, fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: err.errors.map((e) => e.message).join('; ') });
      }
      if (err.code === '23505') return res.status(409).json({ error: 'Already exists' });
      if (err.code === '23503') return res.status(409).json({ error: 'In use — cannot delete' });
      next(err);
    });
}

// =====================================================================
// VEHICLE TYPES
// =====================================================================
function listTypes(req, res, next) {
  handle(req, res, next, async () => {
    // ?all=true → management UI (show inactive too). Default: active only.
    const all = req.query.all === 'true';
    const r = await pool.query(
      all
        ? 'SELECT id, name, is_active FROM vehicle_types ORDER BY name ASC'
        : 'SELECT id, name, is_active FROM vehicle_types WHERE is_active = TRUE ORDER BY name ASC'
    );
    res.json({ items: r.rows });
  });
}
function createType(req, res, next) {
  handle(req, res, next, async () => {
    const data = typeSchema.parse(req.body);
    const r = await pool.query(
      'INSERT INTO vehicle_types (name, is_active) VALUES ($1, COALESCE($2, TRUE)) RETURNING id, name, is_active',
      [data.name, data.is_active]
    );
    res.status(201).json({ item: r.rows[0] });
  });
}
function updateType(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const data = typeSchema.partial().parse(req.body);
    const r = await pool.query(
      `UPDATE vehicle_types SET
         name      = COALESCE($1, name),
         is_active = COALESCE($2, is_active)
       WHERE id = $3
       RETURNING id, name, is_active`,
      [data.name ?? null, data.is_active ?? null, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Vehicle type not found' });
    res.json({ item: r.rows[0] });
  });
}
function deleteType(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r = await pool.query('DELETE FROM vehicle_types WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Vehicle type not found' });
    res.status(204).end();
  });
}

// =====================================================================
// MAKES
// =====================================================================
function listMakes(req, res, next) {
  handle(req, res, next, async () => {
    const typeId     = req.query.type_id     ? idParam.parse(req.query.type_id)     : null;
    const typeClass  = req.query.type_class  || null; // '2W' | '4W'
    const bodyTypeId = req.query.body_type_id ? idParam.parse(req.query.body_type_id) : null;
    const segmentId  = req.query.segment_id  ? idParam.parse(req.query.segment_id)  : null;

    const conds  = ['vm.is_active = TRUE'];
    const params = [];
    let n = 1;

    if (typeId) { conds.push(`vm.vehicle_type_id = $${n++}`); params.push(typeId); }

    // Filter by 2W or 4W class via a sub-query on vehicle_types name
    if (typeClass === '2W') {
      conds.push(`vm.vehicle_type_id IN (SELECT id FROM vehicle_types WHERE ${TW_COND.replace(/vt\./g, '')})`);
    } else if (typeClass === '4W') {
      conds.push(`vm.vehicle_type_id IN (SELECT id FROM vehicle_types WHERE NOT ${TW_COND.replace(/vt\./g, '')})`);
    }

    if (bodyTypeId) {
      // Match by name (case-insensitive) to handle duplicate body_type rows from different imports
      conds.push(`vm.id IN (
        SELECT DISTINCT vmod.make_id FROM vehicle_models vmod
        JOIN body_types bt ON bt.id = vmod.body_type_id
        WHERE LOWER(bt.name) = (SELECT LOWER(name) FROM body_types WHERE id = $${n++} LIMIT 1)
      )`);
      params.push(bodyTypeId);
    }
    if (segmentId) {
      // Match by name (case-insensitive) to handle duplicate segment rows from different imports
      conds.push(`vm.id IN (
        SELECT DISTINCT vmod.make_id FROM vehicle_models vmod
        JOIN segments sg ON sg.id = vmod.segment_id
        WHERE LOWER(sg.name) = (SELECT LOWER(name) FROM segments WHERE id = $${n++} LIMIT 1)
      )`);
      params.push(segmentId);
    }

    const where = `WHERE ${conds.join(' AND ')}`;
    const r = await pool.query(
      `SELECT vm.id, vm.vehicle_type_id, vt.name AS vehicle_type_name, vm.name, vm.is_active
       FROM vehicle_makes vm
       JOIN vehicle_types vt ON vt.id = vm.vehicle_type_id
       ${where} ORDER BY vm.name ASC`,
      params
    );
    res.json({ items: r.rows });
  });
}
function createMake(req, res, next) {
  handle(req, res, next, async () => {
    const data = makeSchema.parse(req.body);
    const r = await pool.query(
      'INSERT INTO vehicle_makes (vehicle_type_id, name, is_active) VALUES ($1, $2, COALESCE($3, TRUE)) RETURNING id, vehicle_type_id, name, is_active',
      [data.vehicle_type_id, data.name, data.is_active]
    );
    res.status(201).json({ item: r.rows[0] });
  });
}
function updateMake(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const data = makeSchema.partial().parse(req.body);
    const r = await pool.query(
      `UPDATE vehicle_makes SET
         vehicle_type_id = COALESCE($1, vehicle_type_id),
         name            = COALESCE($2, name),
         is_active       = COALESCE($3, is_active)
       WHERE id = $4
       RETURNING id, vehicle_type_id, name, is_active`,
      [data.vehicle_type_id ?? null, data.name ?? null, data.is_active ?? null, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Make not found' });
    res.json({ item: r.rows[0] });
  });
}
function deleteMake(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r = await pool.query('DELETE FROM vehicle_makes WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Make not found' });
    res.status(204).end();
  });
}

// =====================================================================
// MODELS
// =====================================================================
function listModels(req, res, next) {
  handle(req, res, next, async () => {
    const makeId     = req.query.make_id      ? idParam.parse(req.query.make_id)      : null;
    const bodyTypeId = req.query.body_type_id ? idParam.parse(req.query.body_type_id) : null;
    const segmentId  = req.query.segment_id  ? idParam.parse(req.query.segment_id)  : null;
    const typeClass  = req.query.type_class   || null; // '2W' | '4W'

    const conds  = [];
    const params = [];
    let n = 1;

    if (makeId) { conds.push(`vm.make_id = $${n++}`); params.push(makeId); }
    if (bodyTypeId) {
      conds.push(`vm.body_type_id IN (
        SELECT id FROM body_types WHERE LOWER(name) = (SELECT LOWER(name) FROM body_types WHERE id = $${n++} LIMIT 1)
      )`);
      params.push(bodyTypeId);
    }
    if (segmentId) {
      conds.push(`vm.segment_id IN (
        SELECT id FROM segments WHERE LOWER(name) = (SELECT LOWER(name) FROM segments WHERE id = $${n++} LIMIT 1)
      )`);
      params.push(segmentId);
    }
    if (typeClass === '2W') {
      conds.push(`vm.make_id IN (
        SELECT m.id FROM vehicle_makes m
        JOIN vehicle_types vt ON vt.id = m.vehicle_type_id
        WHERE LOWER(vt.name) SIMILAR TO '%(two|2w|2-w|bike|scoot|motor)%'
      )`);
    } else if (typeClass === '4W') {
      conds.push(`vm.make_id IN (
        SELECT m.id FROM vehicle_makes m
        JOIN vehicle_types vt ON vt.id = m.vehicle_type_id
        WHERE LOWER(vt.name) NOT SIMILAR TO '%(two|2w|2-w|bike|scoot|motor)%'
      )`);
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT vm.id, vm.make_id, vm.body_type_id, bt.name AS body_type_name,
              vm.segment_id, sg.name AS segment_name,
              vm.name, vm.engine_cc, vm.is_active
       FROM vehicle_models vm
       LEFT JOIN body_types bt ON bt.id = vm.body_type_id
       LEFT JOIN segments   sg ON sg.id = vm.segment_id
       ${where} ORDER BY vm.name ASC`,
      params
    );
    res.json({ items: r.rows });
  });
}
function createModel(req, res, next) {
  handle(req, res, next, async () => {
    const data = modelSchema.parse(req.body);
    const r = await pool.query(
      'INSERT INTO vehicle_models (make_id, name, is_active) VALUES ($1, $2, COALESCE($3, TRUE)) RETURNING id, make_id, name, is_active',
      [data.make_id, data.name, data.is_active]
    );
    res.status(201).json({ item: r.rows[0] });
  });
}
function updateModel(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const data = modelSchema.partial().parse(req.body);
    const r = await pool.query(
      `UPDATE vehicle_models SET
         make_id   = COALESCE($1, make_id),
         name      = COALESCE($2, name),
         is_active = COALESCE($3, is_active)
       WHERE id = $4
       RETURNING id, make_id, name, is_active`,
      [data.make_id ?? null, data.name ?? null, data.is_active ?? null, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Model not found' });
    res.json({ item: r.rows[0] });
  });
}
function deleteModel(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r = await pool.query('DELETE FROM vehicle_models WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Model not found' });
    res.status(204).end();
  });
}

// =====================================================================
// SEGMENTS  (flat list of fuel types)
// =====================================================================
function listSegments(req, res, next) {
  handle(req, res, next, async () => {
    const all = req.query.all === 'true';
    const r = await pool.query(
      all
        ? 'SELECT id, name, is_active FROM segments ORDER BY name ASC'
        : 'SELECT id, name, is_active FROM segments WHERE is_active = TRUE ORDER BY name ASC'
    );
    res.json({ items: r.rows });
  });
}
function createSegment(req, res, next) {
  handle(req, res, next, async () => {
    const data = segmentSchema.parse(req.body);
    const r = await pool.query(
      'INSERT INTO segments (name, is_active) VALUES ($1, COALESCE($2, TRUE)) RETURNING id, name, is_active',
      [data.name, data.is_active]
    );
    res.status(201).json({ item: r.rows[0] });
  });
}
function updateSegment(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const data = segmentSchema.partial().parse(req.body);
    const r = await pool.query(
      `UPDATE segments SET
         name      = COALESCE($1, name),
         is_active = COALESCE($2, is_active)
       WHERE id = $3
       RETURNING id, name, is_active`,
      [data.name ?? null, data.is_active ?? null, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Segment not found' });
    res.json({ item: r.rows[0] });
  });
}
function deleteSegment(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r = await pool.query('DELETE FROM segments WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Segment not found' });
    res.status(204).end();
  });
}

// =====================================================================
// BODY TYPES  (flat list)
// =====================================================================
function listBodyTypes(req, res, next) {
  handle(req, res, next, async () => {
    const all = req.query.all === 'true';
    const r = await pool.query(
      all
        ? 'SELECT id, name, is_active FROM body_types ORDER BY name ASC'
        : 'SELECT id, name, is_active FROM body_types WHERE is_active = TRUE ORDER BY name ASC'
    );
    res.json({ items: r.rows });
  });
}
function createBodyType(req, res, next) {
  handle(req, res, next, async () => {
    const data = bodySchema.parse(req.body);
    const r = await pool.query(
      'INSERT INTO body_types (name, is_active) VALUES ($1, COALESCE($2, TRUE)) RETURNING id, name, is_active',
      [data.name, data.is_active]
    );
    res.status(201).json({ item: r.rows[0] });
  });
}
function updateBodyType(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const data = bodySchema.partial().parse(req.body);
    const r = await pool.query(
      `UPDATE body_types SET
         name      = COALESCE($1, name),
         is_active = COALESCE($2, is_active)
       WHERE id = $3
       RETURNING id, name, is_active`,
      [data.name ?? null, data.is_active ?? null, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Body type not found' });
    res.json({ item: r.rows[0] });
  });
}
function deleteBodyType(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r = await pool.query('DELETE FROM body_types WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Body type not found' });
    res.status(204).end();
  });
}

// =====================================================================
// VEHICLE RECORDS  (flat view: type + make + model + segment + body_type)
// =====================================================================

// Base flat-list query
const VEHICLE_SELECT = `
  SELECT
    vm.id,
    vt.id   AS type_id,    vt.name   AS type,
    vmk.id  AS make_id,    vmk.name  AS make,
    vm.name AS model,
    s.id    AS segment_id,   s.name   AS segment,
    bt.id   AS body_type_id, bt.name  AS body_type,
    vm.engine_cc,
    cc.id   AS cc_category_id, cc.name AS cc_category,
    cc.min_cc, cc.max_cc,
    vm.is_active,
    vm.created_at
  FROM   vehicle_models  vm
  JOIN   vehicle_makes   vmk ON vmk.id = vm.make_id
  JOIN   vehicle_types   vt  ON vt.id  = vmk.vehicle_type_id
  LEFT JOIN segments     s   ON s.id   = vm.segment_id
  LEFT JOIN body_types   bt  ON bt.id  = vm.body_type_id
  LEFT JOIN cc_categories cc ON cc.id  = vm.cc_category_id
`;

// Zod schema for creating / updating a vehicle record
const vehicleRecordSchema = z.object({
  // Accept either an existing id or a name string to auto-create
  type:         z.string().trim().min(1).max(60),
  make:         z.string().trim().min(1).max(80),
  model:        z.string().trim().min(1).max(120),
  segment:      z.string().trim().max(40).optional().nullable(),
  body_type:    z.string().trim().max(60).optional().nullable(),
  engine_cc:    z.coerce.number().int().min(1).optional().nullable(),
  is_active:    z.boolean().optional(),
});

// Returns true if a vehicle type name matches 2W patterns
function is2WTypeName(name = '') {
  const n = name.toLowerCase();
  return n.includes('two') || n.includes('2w') || n.includes('bike') || n.includes('scoot') || n.includes('motor');
}

/** GET /api/vehicles/records
 *  Query params: search, type_id, type_class (2W|4W), make_id, page (1-based), limit (default 50)
 *  type_class=2W  → only two-wheeler types (name contains "two", "2w", "bike", "scoot")
 *  type_class=4W  → all other types
 */
// SQL fragment that identifies two-wheeler types by name
const TW_COND = `(LOWER(vt.name) LIKE '%two%' OR LOWER(vt.name) LIKE '%2w%' `
              + `OR LOWER(vt.name) LIKE '%bike%' OR LOWER(vt.name) LIKE '%scoot%' `
              + `OR LOWER(vt.name) LIKE '%motor%')`;

function listVehicleRecords(req, res, next) {
  handle(req, res, next, async () => {
    const search    = (req.query.search     || '').trim();
    const typeId    = req.query.type_id     ? idParam.parse(req.query.type_id)  : null;
    const typeClass = req.query.type_class  || null; // '2W' | '4W'
    const makeId    = req.query.make_id     ? idParam.parse(req.query.make_id)  : null;
    const limit     = Math.min(Number(req.query.limit)  || 100, 500);
    const page      = Math.max(Number(req.query.page)   || 1,   1);
    const offset    = (page - 1) * limit;

    const conditions = [];
    const params     = [];

    if (typeId)              { params.push(typeId); conditions.push(`vt.id = $${params.length}`); }
    if (typeClass === '2W')  { conditions.push(TW_COND); }
    if (typeClass === '4W')  { conditions.push(`NOT ${TW_COND}`); }
    if (makeId) { params.push(makeId);  conditions.push(`vmk.id = $${params.length}`); }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      const p = params.length;
      conditions.push(
        `(LOWER(vt.name) LIKE $${p} OR LOWER(vmk.name) LIKE $${p} OR LOWER(vm.name) LIKE $${p}
          OR LOWER(COALESCE(s.name,'')) LIKE $${p} OR LOWER(COALESCE(bt.name,'')) LIKE $${p})`
      );
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countQ = await pool.query(
      `SELECT COUNT(*) FROM vehicle_models vm
       JOIN vehicle_makes vmk ON vmk.id = vm.make_id
       JOIN vehicle_types vt  ON vt.id  = vmk.vehicle_type_id
       LEFT JOIN segments     s  ON s.id  = vm.segment_id
       LEFT JOIN body_types   bt ON bt.id = vm.body_type_id
       ${where}`,
      params
    );

    params.push(limit, offset);
    const dataQ = await pool.query(
      `${VEHICLE_SELECT} ${where}
       ORDER BY vt.name, vmk.name, vm.name
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      items: dataQ.rows,
      total: Number(countQ.rows[0].count),
      page,
      limit,
    });
  });
}

/** POST /api/vehicles/records — create a vehicle record */
function createVehicleRecord(req, res, next) {
  handle(req, res, next, async () => {
    const data = vehicleRecordSchema.parse(req.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Resolve / create type
      let r = await client.query(
        'SELECT id FROM vehicle_types WHERE LOWER(name) = LOWER($1)', [data.type]
      );
      let typeId = r.rows[0]?.id;
      if (!typeId) {
        r = await client.query(
          'INSERT INTO vehicle_types (name) VALUES ($1) RETURNING id', [data.type]
        );
        typeId = r.rows[0].id;
      }

      // Resolve / create make
      r = await client.query(
        'SELECT id FROM vehicle_makes WHERE vehicle_type_id = $1 AND LOWER(name) = LOWER($2)',
        [typeId, data.make]
      );
      let makeId = r.rows[0]?.id;
      if (!makeId) {
        r = await client.query(
          'INSERT INTO vehicle_makes (vehicle_type_id, name) VALUES ($1, $2) RETURNING id',
          [typeId, data.make]
        );
        makeId = r.rows[0].id;
      }

      // For 4W vehicles, segment and body_type are required
      const typeIs2W = is2WTypeName(data.type);
      if (!typeIs2W) {
        if (!data.segment?.trim()) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Segment / Fuel is required for 4W vehicles.' });
        }
        if (!data.body_type?.trim()) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Body Type is required for 4W vehicles.' });
        }
      }

      // Resolve segment (required for 4W, optional for 2W)
      let segmentId = null;
      if (data.segment) {
        r = await client.query(
          'SELECT id FROM segments WHERE LOWER(name) = LOWER($1)', [data.segment]
        );
        segmentId = r.rows[0]?.id ?? null;
        if (!segmentId) {
          r = await client.query(
            'INSERT INTO segments (name) VALUES ($1) RETURNING id', [data.segment]
          );
          segmentId = r.rows[0].id;
        }
      }

      // Check model uniqueness: make + model + segment (allows same model with different fuel types)
      r = await client.query(
        'SELECT id FROM vehicle_models WHERE make_id = $1 AND LOWER(name) = LOWER($2) AND segment_id IS NOT DISTINCT FROM $3',
        [makeId, data.model, segmentId]
      );
      if (r.rows[0]) {
        await client.query('ROLLBACK');
        const segLabel = data.segment ? ` (${data.segment})` : '';
        return res.status(409).json({ error: `A vehicle with this make + model${segLabel} already exists.` });
      }

      // Resolve body type (required for 4W, optional for 2W)
      let bodyTypeId = null;
      if (data.body_type) {
        r = await client.query(
          'SELECT id FROM body_types WHERE LOWER(name) = LOWER($1)', [data.body_type]
        );
        bodyTypeId = r.rows[0]?.id ?? null;
        if (!bodyTypeId) {
          r = await client.query(
            'INSERT INTO body_types (name) VALUES ($1) RETURNING id', [data.body_type]
          );
          bodyTypeId = r.rows[0].id;
        }
      }

      // Auto-classify engine_cc → cc_category_id
      let ccCategoryId = null;
      if (data.engine_cc) {
        const ccRow = await client.query(
          `SELECT id FROM cc_categories WHERE is_active = TRUE AND min_cc <= $1 AND max_cc >= $1 LIMIT 1`,
          [data.engine_cc]
        );
        ccCategoryId = ccRow.rows[0]?.id ?? null;
      }

      // Insert model record
      r = await client.query(
        `INSERT INTO vehicle_models (make_id, name, segment_id, body_type_id, engine_cc, cc_category_id, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE))
         RETURNING id`,
        [makeId, data.model, segmentId, bodyTypeId, data.engine_cc ?? null, ccCategoryId, data.is_active]
      );
      const newId = r.rows[0].id;

      await client.query('COMMIT');

      // Return full record
      const full = await pool.query(`${VEHICLE_SELECT} WHERE vm.id = $1`, [newId]);
      res.status(201).json({ item: full.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

/** PATCH /api/vehicles/records/:id — update a vehicle record */
function updateVehicleRecord(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = vehicleRecordSchema.partial().parse(req.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Fetch existing record
      const existing = await client.query(
        `SELECT vm.id, vm.make_id, vm.name AS model, vm.segment_id, vm.body_type_id, vm.is_active,
                vmk.vehicle_type_id, vmk.name AS make_name, vt.name AS type_name
         FROM vehicle_models vm
         JOIN vehicle_makes vmk ON vmk.id = vm.make_id
         JOIN vehicle_types vt  ON vt.id  = vmk.vehicle_type_id
         WHERE vm.id = $1`,
        [id]
      );
      if (!existing.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Vehicle not found' });
      }
      const cur = existing.rows[0];

      // Resolve new type + make if either changed
      let makeId = cur.make_id;
      if (data.type !== undefined || data.make !== undefined) {
        const targetType = data.type ?? cur.type_name;
        const targetMake = data.make ?? cur.make_name;

        let r = await client.query(
          'SELECT id FROM vehicle_types WHERE LOWER(name) = LOWER($1)', [targetType]
        );
        let typeId = r.rows[0]?.id;
        if (!typeId) {
          r = await client.query(
            'INSERT INTO vehicle_types (name) VALUES ($1) RETURNING id', [targetType]
          );
          typeId = r.rows[0].id;
        }
        r = await client.query(
          'SELECT id FROM vehicle_makes WHERE vehicle_type_id = $1 AND LOWER(name) = LOWER($2)',
          [typeId, targetMake]
        );
        makeId = r.rows[0]?.id;
        if (!makeId) {
          r = await client.query(
            'INSERT INTO vehicle_makes (vehicle_type_id, name) VALUES ($1, $2) RETURNING id',
            [typeId, targetMake]
          );
          makeId = r.rows[0].id;
        }
      }

      // Resolve segment
      let segmentId = cur.segment_id;
      if (data.segment !== undefined) {
        if (!data.segment) {
          segmentId = null;
        } else {
          let r = await client.query(
            'SELECT id FROM segments WHERE LOWER(name) = LOWER($1)', [data.segment]
          );
          segmentId = r.rows[0]?.id ?? null;
          if (!segmentId) {
            r = await client.query(
              'INSERT INTO segments (name) VALUES ($1) RETURNING id', [data.segment]
            );
            segmentId = r.rows[0].id;
          }
        }
      }

      // Resolve body type
      let bodyTypeId = cur.body_type_id;
      if (data.body_type !== undefined) {
        if (!data.body_type) {
          bodyTypeId = null;
        } else {
          let r = await client.query(
            'SELECT id FROM body_types WHERE LOWER(name) = LOWER($1)', [data.body_type]
          );
          bodyTypeId = r.rows[0]?.id ?? null;
          if (!bodyTypeId) {
            r = await client.query(
              'INSERT INTO body_types (name) VALUES ($1) RETURNING id', [data.body_type]
            );
            bodyTypeId = r.rows[0].id;
          }
        }
      }

      // Resolve engine_cc + cc_category_id
      let engineCc     = cur.engine_cc ?? null;
      let ccCategoryId = cur.cc_category_id ?? null;
      if (data.engine_cc !== undefined) {
        engineCc = data.engine_cc ?? null;
        if (engineCc) {
          const ccRow = await client.query(
            `SELECT id FROM cc_categories WHERE is_active = TRUE AND min_cc <= $1 AND max_cc >= $1 LIMIT 1`,
            [engineCc]
          );
          ccCategoryId = ccRow.rows[0]?.id ?? null;
        } else {
          ccCategoryId = null;
        }
      }

      const modelName = data.model ?? cur.model;
      const isActive  = data.is_active ?? cur.is_active;

      // Check uniqueness for the updated combination (excluding current record)
      const dupCheck = await client.query(
        'SELECT id FROM vehicle_models WHERE make_id = $1 AND LOWER(name) = LOWER($2) AND segment_id IS NOT DISTINCT FROM $3 AND id != $4',
        [makeId, modelName, segmentId, id]
      );
      if (dupCheck.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'A vehicle with this make + model + segment already exists.' });
      }

      await client.query(
        `UPDATE vehicle_models
         SET make_id = $1, name = $2, segment_id = $3, body_type_id = $4,
             engine_cc = $5, cc_category_id = $6, is_active = $7
         WHERE id = $8`,
        [makeId, modelName, segmentId, bodyTypeId, engineCc, ccCategoryId, isActive, id]
      );

      await client.query('COMMIT');

      const full = await pool.query(`${VEHICLE_SELECT} WHERE vm.id = $1`, [id]);
      res.json({ item: full.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

/** DELETE /api/vehicles/records/:id */
function deleteVehicleRecord(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query('DELETE FROM vehicle_models WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Vehicle not found' });
    res.status(204).end();
  });
}

module.exports = {
  listTypes, createType, updateType, deleteType,
  listMakes, createMake, updateMake, deleteMake,
  listModels, createModel, updateModel, deleteModel,
  listSegments, createSegment, updateSegment, deleteSegment,
  listBodyTypes, createBodyType, updateBodyType, deleteBodyType,
  // Flat vehicle records
  listVehicleRecords, createVehicleRecord, updateVehicleRecord, deleteVehicleRecord,
};
