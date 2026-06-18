'use strict';

const { z }    = require('zod');
const { pool } = require('../config/db');

const callLogSchema = z.object({
  outcome: z.string().trim().min(1).max(100),
  notes:   z.string().trim().max(1000).optional().nullable(),
});

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(err => {
    if (err.name === 'ZodError')
      return res.status(400).json({ error: err.errors.map(e => e.message).join('; ') });
    next(err);
  });
}

// POST /api/leads/:id/calls
function createCallLog(req, res, next) {
  handle(req, res, next, async () => {
    const leadId = parseInt(req.params.id, 10);
    if (isNaN(leadId)) return res.status(400).json({ error: 'Invalid lead id' });

    const lead = await pool.query('SELECT id FROM leads WHERE id = $1', [leadId]);
    if (!lead.rows[0]) return res.status(404).json({ error: 'Lead not found' });

    const data = callLogSchema.parse(req.body);

    // Validate outcome against active master
    const validOutcome = await pool.query(
      'SELECT id FROM call_outcomes WHERE LOWER(name) = LOWER($1) AND is_active = TRUE',
      [data.outcome]
    );
    if (!validOutcome.rows[0]) {
      return res.status(400).json({ error: `Invalid outcome: "${data.outcome}"` });
    }

    const calledBy = req.user.id;
    const r = await pool.query(
      `INSERT INTO call_logs (lead_id, called_by, outcome, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING id, lead_id, called_by, called_at, outcome, notes`,
      [leadId, calledBy, data.outcome, data.notes || null]
    );

    res.status(201).json({ item: r.rows[0] });
  });
}

// GET /api/leads/calls/summary
// Today's call counts per agent (9AM–6PM), grouped by outcome dynamically
function getCallSummary(req, res, next) {
  handle(req, res, next, async () => {
    const dateStr = req.query.date || new Date().toISOString().split('T')[0];

    // Get all active outcomes for dynamic columns in response (graceful if table not yet migrated)
    let outcomeNames = [];
    try {
      const outcomesRes = await pool.query(
        'SELECT name FROM call_outcomes WHERE is_active = TRUE ORDER BY sort_order ASC, id ASC'
      );
      outcomeNames = outcomesRes.rows.map(r => r.name);
    } catch {
      // call_outcomes table not yet migrated — fall back to empty list
    }

    // Get summary: one row per agent with outcome breakdown
    // Two-level aggregation to avoid nesting aggregates inside json_object_agg
    const r = await pool.query(
      `SELECT
         user_id,
         agent_name,
         SUM(outcome_count)::int            AS total_calls,
         json_object_agg(outcome, outcome_count) AS outcomes_breakdown
       FROM (
         SELECT
           u.id          AS user_id,
           u.name        AS agent_name,
           cl.outcome,
           COUNT(cl.id)::int AS outcome_count
         FROM call_logs cl
         JOIN users u ON u.id = cl.called_by
         WHERE cl.called_at::date = $1
           AND cl.called_at::time BETWEEN '09:00' AND '18:00'
         GROUP BY u.id, u.name, cl.outcome
       ) sub
       GROUP BY user_id, agent_name
       ORDER BY total_calls DESC`,
      [dateStr]
    );

    const myId  = req.user.id;
    const myRow = r.rows.find(row => row.user_id === myId);

    res.json({
      date:          dateStr,
      my_count:      myRow ? myRow.total_calls : 0,
      outcome_names: outcomeNames,
      agents:        r.rows,
    });
  });
}

// GET /api/leads/:id/calls
function getLeadCallLogs(req, res, next) {
  handle(req, res, next, async () => {
    const leadId = parseInt(req.params.id, 10);
    if (isNaN(leadId)) return res.status(400).json({ error: 'Invalid lead id' });

    const r = await pool.query(
      `SELECT cl.id, cl.outcome, cl.notes, cl.called_at, u.name AS agent_name
       FROM call_logs cl
       JOIN users u ON u.id = cl.called_by
       WHERE cl.lead_id = $1
       ORDER BY cl.called_at DESC`,
      [leadId]
    );

    res.json({ items: r.rows });
  });
}

module.exports = { createCallLog, getCallSummary, getLeadCallLogs };
