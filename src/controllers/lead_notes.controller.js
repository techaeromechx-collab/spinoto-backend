'use strict';
const { z } = require('zod');
const { pool } = require('../config/db');
const { sendPush } = require('../utils/sendPush');
const { isNotificationEnabled } = require('../utils/notificationPrefs');

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(next);
}

const noteSchema = z.object({
  note: z.string().trim().min(1).max(2000),
});

// GET /api/lead-notes/:leadId
// List all notes for a lead (newest first)
function listNotes(req, res, next) {
  handle(req, res, next, async () => {
    const leadId = parseInt(req.params.leadId, 10);

    const r = await pool.query(
      `SELECT
         n.id, n.lead_id, n.note, n.created_at,
         n.created_by,
         u.name AS created_by_name
       FROM lead_notes n
       LEFT JOIN users u ON u.id = n.created_by
       WHERE n.lead_id = $1
       ORDER BY n.created_at DESC`,
      [leadId]
    );

    res.json({ items: r.rows });
  });
}

// POST /api/lead-notes/:leadId
// Add a note to a lead and record a 'note_added' activity.
// Sends in-app notifications to:
//   • the lead's assigned user  (if not the note author)
//   • the note author's manager (if not the note author)
//   de-duplicated — no user gets the notification twice
function addNote(req, res, next) {
  handle(req, res, next, async () => {
    const leadId    = parseInt(req.params.leadId, 10);
    const { note }  = noteSchema.parse(req.body);
    const userId    = req.user.id;
    const isSuperAdmin = req.user.is_super_admin === true;
    const isManager    = !isSuperAdmin && req.user.permissions.has('VIEW_TEAM_LEADS');
    const skipNotify   = isSuperAdmin || isManager;

    /* ── The transaction, and nothing else ──────────────────────────────────
       The pool is 10 wide with no acquire timeout (config/db.js). Everything
       past the release — the lead lookup, the notification inserts, the
       read-back — wants a connection of its own. Doing any of it while still
       holding this client is not slow, it is a deadlock: ten simultaneous
       notes take all ten connections and each then waits for an eleventh that
       cannot exist.

       This was the worst of them, because the notification fan-out is a LOOP:
       one request could ask the pool for a connection several times over while
       holding one. */
    let noteId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert the note
      const noteResult = await client.query(
        `INSERT INTO lead_notes (lead_id, note, created_by)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [leadId, note, userId]
      );
      noteId = noteResult.rows[0].id;

      // Record an activity for the timeline
      await client.query(
        `INSERT INTO lead_activities (lead_id, type, new_value, note, created_by)
         VALUES ($1, 'note_added', NULL, $2, $3)`,
        [leadId, note, userId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();          // ← before anything below asks for a client
    }

    // ── Fetch lead info + note author info for notifications ───────────────
    const [leadRow, authorRow] = await Promise.all([
      pool.query(
        `SELECT l.id, l.name, l.mobile, l.assigned_to, l.created_by
         FROM leads l WHERE l.id = $1`, [leadId]
      ),
      pool.query(
        `SELECT u.id, u.name, u.manager_id FROM users u WHERE u.id = $1`, [userId]
      ),
    ]);

    const lead   = leadRow.rows[0];
    const author = authorRow.rows[0];

    if (lead && author) {
      const recipientIds = new Set();

      if (skipNotify) {
        // Manager / super admin → notify everyone connected to the lead
        if (lead.assigned_to && lead.assigned_to !== userId) recipientIds.add(lead.assigned_to);
        if (lead.created_by  && lead.created_by  !== userId) recipientIds.add(lead.created_by);
      } else {
        // Regular user → notify their manager + assigned user + lead creator
        if (lead.assigned_to  && lead.assigned_to  !== userId) recipientIds.add(lead.assigned_to);
        if (lead.created_by   && lead.created_by   !== userId) recipientIds.add(lead.created_by);
        if (author.manager_id && author.manager_id !== userId) recipientIds.add(author.manager_id);
      }

      if (recipientIds.size > 0) {
        const leadLabel   = lead.name || lead.mobile;
        const notePreview = note.length > 80 ? note.slice(0, 80) + '…' : note;
        const title       = `New note on ${leadLabel}`;
        const body        = `${author.name} added: ${notePreview}`;
        for (const uid of recipientIds) {
          if (await isNotificationEnabled(pool, uid, 'note_added')) {
            await pool.query(
              `INSERT INTO notifications (user_id, type, title, body, lead_id)
               VALUES ($1, 'note_added', $2, $3, $4)`,
              [uid, title, body, leadId]
            );
          }
          sendPush(uid, 'note_added', title, body, '/leads');
        }
      }
    }

    // Return the note with creator name
    const r = await pool.query(
      `SELECT n.id, n.lead_id, n.note, n.created_at,
              u.name AS created_by_name
       FROM lead_notes n
       LEFT JOIN users u ON u.id = n.created_by
       WHERE n.id = $1`,
      [noteId]
    );

    res.status(201).json({ item: r.rows[0] });
  });
}

module.exports = { listNotes, addNote };
