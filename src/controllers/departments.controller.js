/**
 * Departments controller
 *
 * Master-data management for the departments dropdown.
 * All write routes require MANAGE_MASTER_DATA (enforced at the route level).
 * GET /api/departments is public to any authenticated user so the create-user
 * form can populate the dropdown.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { getIO } = require('../socket');

const idParam = z.coerce.number().int().positive();

const writeSchema = z.object({
  name:      z.string().trim().min(1).max(120),
  is_active: z.boolean().optional(),
});

function handle(req, res, next, fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
      }
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Department name already exists' });
      }
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    });
}

/** GET /api/departments — all active departments (any authenticated user) */
function listDepartments(req, res, next) {
  handle(req, res, next, async () => {
    const r = await pool.query(
      `SELECT id, name, is_active, created_at
       FROM departments
       ORDER BY name ASC`
    );
    res.json({ items: r.rows });
  });
}

/** POST /api/departments — create (MANAGE_MASTER_DATA required) */
function createDepartment(req, res, next) {
  handle(req, res, next, async () => {
    const data = writeSchema.parse(req.body);
    const r = await pool.query(
      `INSERT INTO departments (name, is_active)
       VALUES ($1, COALESCE($2, TRUE))
       RETURNING id, name, is_active, created_at`,
      [data.name, data.is_active]
    );
    getIO().emit('invalidate', { topic: 'departments' });
    res.status(201).json({ item: r.rows[0] });
  });
}

/** PATCH /api/departments/:id — update name / is_active (MANAGE_MASTER_DATA required) */
function updateDepartment(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const data = writeSchema.partial().parse(req.body);
    const r = await pool.query(
      `UPDATE departments SET
         name      = COALESCE($1, name),
         is_active = COALESCE($2, is_active),
         updated_at = NOW()
       WHERE id = $3
       RETURNING id, name, is_active, created_at`,
      [data.name ?? null, data.is_active ?? null, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Department not found' });
    getIO().emit('invalidate', { topic: 'departments' });
    res.json({ item: r.rows[0] });
  });
}

/** DELETE /api/departments/:id — hard delete (MANAGE_MASTER_DATA required) */
function deleteDepartment(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const r = await pool.query('DELETE FROM departments WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Department not found' });
    getIO().emit('invalidate', { topic: 'departments' });
    res.status(204).end();
  });
}

module.exports = {
  listDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
};
