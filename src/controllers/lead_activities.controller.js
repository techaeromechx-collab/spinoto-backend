'use strict';
const { pool } = require('../config/db');

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(next);
}

// GET /api/lead-activities/:leadId
// List all activity timeline entries for a lead (oldest first for timeline display)
function listActivities(req, res, next) {
  handle(req, res, next, async () => {
    const leadId = parseInt(req.params.leadId, 10);

    const r = await pool.query(
      `SELECT
         a.id, a.lead_id, a.type, a.old_value, a.new_value, a.note, a.created_at,
         u.name AS created_by_name
       FROM lead_activities a
       LEFT JOIN users u ON u.id = a.created_by
       WHERE a.lead_id = $1
       ORDER BY a.created_at ASC`,
      [leadId]
    );

    res.json({ items: r.rows });
  });
}

module.exports = { listActivities };
