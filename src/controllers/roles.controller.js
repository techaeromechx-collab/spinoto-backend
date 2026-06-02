/**
 * Roles controller
 *
 * A Role is a named, reusable bundle of permission codes.
 * Super admins can create / edit / delete roles.
 * Any user with MANAGE_USERS can apply a role to set a user's permissions.
 *
 * Routes (all require is_super_admin):
 *   GET    /api/roles          — list all roles
 *   POST   /api/roles          — create role
 *   PUT    /api/roles/:id      — update role
 *   DELETE /api/roles/:id      — delete role
 *   POST   /api/roles/:id/apply/:userId — apply role permissions to a user
 */

const { z }    = require('zod');
const { pool } = require('../config/db');
const { PERMISSION_CODES, assertValidCodes } = require('../utils/permissions');

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(next);
}

const idParam = z.coerce.number().int().positive();

const roleSchema = z.object({
  name:        z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional().nullable(),
  permissions: z.array(z.enum(PERMISSION_CODES)).default([]),
  is_active:   z.boolean().optional().default(true),
});

// ─── List all roles ──────────────────────────────────────────────────────────
function listRoles(req, res, next) {
  handle(req, res, next, async () => {
    const r = await pool.query(`
      SELECT id, name, description, permissions, is_active, created_at, updated_at
        FROM roles
       ORDER BY name ASC
    `);
    res.json({ items: r.rows });
  });
}

// ─── Get single role ─────────────────────────────────────────────────────────
function getRole(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query(
      `SELECT id, name, description, permissions, is_active, created_at, updated_at
         FROM roles WHERE id = $1`,
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Role not found' });
    res.json({ item: r.rows[0] });
  });
}

// ─── Create role ─────────────────────────────────────────────────────────────
function createRole(req, res, next) {
  handle(req, res, next, async () => {
    const data = roleSchema.parse(req.body);
    assertValidCodes(data.permissions);

    // Duplicate name check
    const dup = await pool.query(
      `SELECT id FROM roles WHERE LOWER(name) = LOWER($1)`,
      [data.name]
    );
    if (dup.rows.length) {
      return res.status(409).json({ error: `A role named "${data.name}" already exists.` });
    }

    const r = await pool.query(`
      INSERT INTO roles (name, description, permissions, is_active)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, description, permissions, is_active, created_at, updated_at
    `, [data.name, data.description || null, data.permissions, data.is_active]);

    res.status(201).json({ item: r.rows[0] });
  });
}

// ─── Update role ─────────────────────────────────────────────────────────────
function updateRole(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const data = roleSchema.partial().parse(req.body);

    if (data.permissions) assertValidCodes(data.permissions);

    // Check exists
    const existing = await pool.query(`SELECT id FROM roles WHERE id = $1`, [id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Role not found' });

    // Duplicate name check (excluding self)
    if (data.name) {
      const dup = await pool.query(
        `SELECT id FROM roles WHERE LOWER(name) = LOWER($1) AND id <> $2`,
        [data.name, id]
      );
      if (dup.rows.length) {
        return res.status(409).json({ error: `A role named "${data.name}" already exists.` });
      }
    }

    const fields = [];
    const params = [];

    if (data.name        !== undefined) { params.push(data.name);        fields.push(`name        = $${params.length}`); }
    if (data.description !== undefined) { params.push(data.description); fields.push(`description = $${params.length}`); }
    if (data.permissions !== undefined) { params.push(data.permissions); fields.push(`permissions = $${params.length}`); }
    if (data.is_active   !== undefined) { params.push(data.is_active);   fields.push(`is_active   = $${params.length}`); }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(id);
    const r = await pool.query(`
      UPDATE roles SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length}
      RETURNING id, name, description, permissions, is_active, created_at, updated_at
    `, params);

    res.json({ item: r.rows[0] });
  });
}

// ─── Delete role ─────────────────────────────────────────────────────────────
function deleteRole(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r  = await pool.query(`DELETE FROM roles WHERE id = $1`, [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Role not found' });
    res.status(204).end();
  });
}

// ─── Apply role to a user ────────────────────────────────────────────────────
// Replaces the user's current permissions with the role's permission set
function applyRoleToUser(req, res, next) {
  handle(req, res, next, async () => {
    const roleId = idParam.parse(req.params.id);
    const userId = idParam.parse(req.params.userId);

    const roleRes = await pool.query(`SELECT permissions FROM roles WHERE id = $1`, [roleId]);
    if (!roleRes.rows.length) return res.status(404).json({ error: 'Role not found' });

    const userRes = await pool.query(`SELECT id FROM users WHERE id = $1`, [userId]);
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });

    const perms = roleRes.rows[0].permissions;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM user_permissions WHERE user_id = $1`, [userId]);
      if (perms.length) {
        const values = perms.map((_, i) => `($1, $${i + 2})`).join(', ');
        await client.query(
          `INSERT INTO user_permissions (user_id, permission_code) VALUES ${values}`,
          [userId, ...perms]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ message: 'Role applied successfully', permissions: perms });
  });
}

module.exports = { listRoles, getRole, createRole, updateRole, deleteRole, applyRoleToUser };
