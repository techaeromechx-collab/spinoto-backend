/**
 * Users controller
 *
 * Backed by the users + user_permissions tables. Only callers with the
 * MANAGE_USERS permission (or is_super_admin) may hit these routes — the
 * gate is set at the route level.
 *
 * Conventions:
 *   - GET endpoints return { items: [...] } or { item: ... }
 *   - PATCH endpoints accept partial bodies and return the updated row
 *   - Permission codes are validated against the catalog before any write
 */

const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { pool } = require('../config/db');
const {
  PERMISSION_CATALOG,
  PERMISSION_CODES,
  assertValidCodes,
} = require('../utils/permissions');

const idParam = z.coerce.number().int().positive();

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(180),
  password: z.string().min(6).max(200),
  is_super_admin: z.boolean().optional(),
  is_active: z.boolean().optional(),
  manager_id: z.coerce.number().int().positive().optional().nullable(),
  permissions: z.array(z.string()).transform(codes => codes.filter(c => PERMISSION_CODES.includes(c))).optional(),
  // Profile fields
  mobile:       z.string().trim().max(20).optional().nullable(),
  department:   z.string().trim().max(80).optional().nullable(),
  joining_date: z.string().optional().nullable(),   // ISO date string
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email().max(180).optional(),
  password: z.string().min(6).max(200).optional(),
  is_super_admin: z.boolean().optional(),
  is_active: z.boolean().optional(),
  manager_id: z.coerce.number().int().positive().optional().nullable(),
  // Profile fields
  mobile:       z.string().trim().max(20).optional().nullable(),
  department:   z.string().trim().max(80).optional().nullable(),
  joining_date: z.string().optional().nullable(),
});

const permissionsSchema = z.object({
  // Accept any strings, then filter to only valid codes (ignores stale/removed permissions)
  permissions: z.array(z.string()).transform(codes => codes.filter(c => PERMISSION_CODES.includes(c))),
});

function handle(req, res, next, fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: err.errors.map((e) => e.message).join('; ') });
      }
      if (err.code === '23505') return res.status(409).json({ error: 'Email already in use' });
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    });
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** Returns one user row plus its permissions array, in the JSON shape used everywhere. */
async function loadUser(id) {
  const r = await pool.query(
    `SELECT u.id, u.name, u.email, u.is_active, u.is_super_admin, u.created_at, u.updated_at,
            u.mobile, u.department, u.joining_date, u.profile_photo, u.last_login,
            u.manager_id, m.name AS manager_name,
            COALESCE(ARRAY_AGG(up.permission_code) FILTER (WHERE up.permission_code IS NOT NULL), '{}') AS permissions
     FROM users u
     LEFT JOIN users m ON m.id = u.manager_id
     LEFT JOIN user_permissions up ON up.user_id = u.id
     WHERE u.id = $1
     GROUP BY u.id, m.name`,
    [id]
  );
  if (!r.rows[0]) return null;
  // Filter out any stale/removed permission codes that no longer exist in the catalog
  r.rows[0].permissions = (r.rows[0].permissions || []).filter(c => PERMISSION_CODES.includes(c));
  return r.rows[0];
}

/** Replace the full permission set for a user. Run inside a transaction. */
async function replacePermissions(client, userId, codes) {
  assertValidCodes(codes);
  await client.query('DELETE FROM user_permissions WHERE user_id = $1', [userId]);
  if (codes.length === 0) return;
  const values = codes.map((_, i) => `($1, $${i + 2})`).join(', ');
  await client.query(
    `INSERT INTO user_permissions (user_id, permission_code) VALUES ${values}
     ON CONFLICT DO NOTHING`,
    [userId, ...codes]
  );
}

// =====================================================================
// Catalog
// =====================================================================
function listCatalog(req, res) {
  res.json({ items: PERMISSION_CATALOG });
}

// =====================================================================
// Users CRUD
// =====================================================================
function listUsers(req, res, next) {
  handle(req, res, next, async () => {
    const canManageAll = req.user.is_super_admin || req.user.permissions.has('MANAGE_USERS');

    let r;
    if (canManageAll) {
      // Full access — return every user in the system.
      r = await pool.query(
        `SELECT u.id, u.name, u.email, u.is_active, u.is_super_admin, u.created_at,
                u.manager_id, m.name AS manager_name,
                COALESCE(ARRAY_AGG(up.permission_code) FILTER (WHERE up.permission_code IS NOT NULL), '{}') AS permissions
         FROM users u
         LEFT JOIN users m ON m.id = u.manager_id
         LEFT JOIN user_permissions up ON up.user_id = u.id
         WHERE u.hub_id IS NULL
         GROUP BY u.id, m.name
         ORDER BY u.created_at ASC`
      );
    } else {
      // VIEW_TEAM_LEADS — return only this manager's direct reports.
      r = await pool.query(
        `SELECT u.id, u.name, u.email, u.is_active, u.is_super_admin, u.created_at,
                u.manager_id, m.name AS manager_name,
                COALESCE(ARRAY_AGG(up.permission_code) FILTER (WHERE up.permission_code IS NOT NULL), '{}') AS permissions
         FROM users u
         LEFT JOIN users m ON m.id = u.manager_id
         LEFT JOIN user_permissions up ON up.user_id = u.id
         WHERE u.manager_id = $1 AND u.hub_id IS NULL
         GROUP BY u.id, m.name
         ORDER BY u.created_at ASC`,
        [req.user.id]
      );
    }

    // Filter out any stale/removed permission codes
    r.rows.forEach(u => {
      u.permissions = (u.permissions || []).filter(c => PERMISSION_CODES.includes(c));
    });
    res.json({ items: r.rows });
  });
}

function getUser(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const canManageAll = req.user.is_super_admin || req.user.permissions.has('MANAGE_USERS');

    const user = await loadUser(id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Managers (VIEW_TEAM_LEADS only) can only view their own direct reports.
    if (!canManageAll && user.manager_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({ item: user });
  });
}

function createUser(req, res, next) {
  handle(req, res, next, async () => {
    const data = createSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(data.password, 10);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO users (name, email, password_hash, is_super_admin, is_active, manager_id, mobile, department, joining_date)
         VALUES ($1, $2, $3, COALESCE($4, FALSE), COALESCE($5, TRUE), $6, $7, $8, $9)
         RETURNING id`,
        [
          data.name, data.email.toLowerCase(), passwordHash,
          data.is_super_admin, data.is_active, data.manager_id ?? null,
          data.mobile ?? null, data.department ?? null, data.joining_date ?? null,
        ]
      );
      const newId = r.rows[0].id;
      if (data.permissions && data.permissions.length) {
        await replacePermissions(client, newId, data.permissions);
      }
      await client.query('COMMIT');
      const user = await loadUser(newId);
      res.status(201).json({ item: user });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

function updateUser(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const data = updateSchema.parse(req.body);

    // Don't let a Super Admin demote themselves accidentally.
    if (data.is_super_admin === false && req.user.id === id) {
      return res.status(400).json({ error: "You can't remove your own Super Admin flag" });
    }
    if (data.is_active === false && req.user.id === id) {
      return res.status(400).json({ error: "You can't deactivate your own account" });
    }

    const passwordHash = data.password ? await bcrypt.hash(data.password, 10) : null;

    const r = await pool.query(
      `UPDATE users SET
         name           = COALESCE($1, name),
         email          = COALESCE(LOWER($2), email),
         password_hash  = COALESCE($3, password_hash),
         is_super_admin = COALESCE($4, is_super_admin),
         is_active      = COALESCE($5, is_active),
         manager_id     = CASE WHEN $6::boolean THEN $7::int ELSE manager_id END,
         mobile         = COALESCE($9, mobile),
         department     = COALESCE($10, department),
         joining_date   = COALESCE($11::date, joining_date)
       WHERE id = $8
       RETURNING id`,
      [
        data.name           ?? null,
        data.email          ?? null,
        passwordHash,
        data.is_super_admin ?? null,
        data.is_active      ?? null,
        'manager_id' in data,
        data.manager_id     ?? null,
        id,
        data.mobile         ?? null,
        data.department     ?? null,
        data.joining_date   ?? null,
      ]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    const user = await loadUser(id);
    res.json({ item: user });
  });
}

function deleteUser(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    if (req.user.id === id) {
      return res.status(400).json({ error: "You can't delete your own account" });
    }
    const r = await pool.query('DELETE FROM users WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    res.status(204).end();
  });
}

// =====================================================================
// Permissions for a user
// =====================================================================
function setUserPermissions(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const { permissions } = permissionsSchema.parse(req.body);

    const canManageAll = req.user.is_super_admin || req.user.permissions.has('MANAGE_USERS');

    const exists = await pool.query('SELECT id, manager_id FROM users WHERE id = $1', [id]);
    if (exists.rowCount === 0) return res.status(404).json({ error: 'User not found' });

    // MANAGE_TEAM_PERMISSIONS: can only update direct reports, cannot grant admin-level permissions
    if (!canManageAll) {
      if (exists.rows[0].manager_id !== req.user.id) {
        return res.status(403).json({ error: 'You can only manage permissions for your own team members' });
      }
      const blocked = ['MANAGE_USERS', 'MANAGE_TEAM_PERMISSIONS', 'MANAGE_PRICING', 'MANAGE_MASTER_DATA'];
      const hasBlocked = permissions.some(p => blocked.includes(p));
      if (hasBlocked) {
        return res.status(403).json({ error: 'You cannot grant admin-level permissions to team members' });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await replacePermissions(client, id, permissions);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const user = await loadUser(id);
    res.json({ item: user });
  });
}

// =====================================================================
// Assignable users — lightweight list for "Assign To" dropdowns.
// Accessible to any authenticated user who can interact with leads.
// Returns only {id, name} — no permissions or sensitive data.
// =====================================================================
function listAssignableUsers(req, res, next) {
  handle(req, res, next, async () => {
    const r = await pool.query(
      `SELECT id, name
       FROM users
       WHERE is_active = TRUE
         AND hub_id IS NULL
         AND is_super_admin = FALSE
         AND id != $1
       ORDER BY name ASC`,
      [req.user.id]
    );
    res.json({ items: r.rows });
  });
}

module.exports = {
  listCatalog,
  listUsers,
  listAssignableUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  setUserPermissions,
};
