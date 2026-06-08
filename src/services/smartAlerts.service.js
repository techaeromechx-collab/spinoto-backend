/**
 * smartAlerts.service.js
 * ─────────────────────────────────────────────────────────────────────────────
 * All 10 Smart Alert rules for Spinoto Lead CRM.
 * Each function is idempotent — it checks for an already-sent unread
 * notification of the same type for the same lead/user today before inserting.
 *
 * Called by scheduler.js on configurable intervals.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { pool }     = require('../config/db');
const { sendPush } = require('../utils/sendPush');

// ── Helper: guard against duplicate notifications ─────────────────────────────
// Returns true if an unread notification of `type` for `leadId`+`userId` was
// already sent today (prevents spamming on every scheduler tick).
async function alreadyNotifiedToday(client, userId, type, leadId = null) {
  const params = [userId, type];
  let leadClause = '';
  if (leadId) {
    params.push(leadId);
    leadClause = `AND lead_id = $${params.length}`;
  }
  const r = await client.query(
    `SELECT 1 FROM notifications
     WHERE user_id = $1
       AND type = $2
       ${leadClause}
       AND is_read = FALSE
       AND created_at >= NOW() - INTERVAL '1 day'
     LIMIT 1`,
    params
  );
  return r.rowCount > 0;
}

// ── Helper: insert notification ───────────────────────────────────────────────
async function notify(client, { userId, type, title, body, leadId = null }) {
  await client.query(
    `INSERT INTO notifications (user_id, type, title, body, lead_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, type, title, body, leadId]
  );
  // Push is handled as a summary after all alerts run — see sendSummaryPushes()
}

// ─────────────────────────────────────────────────────────────────────────────
// ALERT #1  Overdue Lead Alert (Red / High)
// IF: current_date > follow-up due_at AND lead status != closed/won/converted
// ─────────────────────────────────────────────────────────────────────────────
async function fireOverdueLeadAlerts() {
  const client = await pool.connect();
  try {
    // Find overdue pending follow-up events with active leads
    const { rows } = await client.query(`
      SELECT
        le.id         AS event_id,
        le.lead_id,
        le.due_at,
        l.name        AS lead_name,
        l.mobile      AS lead_mobile,
        l.status      AS lead_status,
        l.created_by,
        l.assigned_to,
        EXTRACT(DAY FROM NOW() - le.due_at)::int AS overdue_days
      FROM lead_events le
      JOIN leads l ON l.id = le.lead_id
      WHERE le.is_done = FALSE
        AND le.due_at < NOW()
        AND LOWER(COALESCE(l.status,'')) NOT IN ('closed','won','converted','lost')
    `);

    for (const row of rows) {
      const label = row.lead_name || row.lead_mobile || `Lead #${row.lead_id}`;
      const days  = row.overdue_days || 0;
      const body  = days > 0
        ? `Follow-up missed by ${days} day${days > 1 ? 's' : ''}`
        : 'Follow-up is overdue today';

      const targets = [...new Set([row.created_by, row.assigned_to].filter(Boolean))];
      for (const uid of targets) {
        if (await alreadyNotifiedToday(client, uid, 'overdue_lead', row.lead_id)) continue;
        await notify(client, {
          userId: uid,
          type:   'overdue_lead',
          title:  `Overdue Lead: ${label}`,
          body,
          leadId: row.lead_id,
        });
      }
    }
    console.log(`[SmartAlerts] #1 Overdue Lead: checked ${rows.length} events`);
  } catch (err) {
    console.error('[SmartAlerts] #1 Overdue Lead error:', err.message);
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ALERT #2  High Priority Lead Alert (Orange / Critical)
// IF: priority = high/urgent/vip OR total_price > 50000 OR tags @> '{VIP}'
// Fires once when a lead is created/updated to high priority (called inline).
// This function is exported for use in the leads controller.
// ─────────────────────────────────────────────────────────────────────────────
async function fireHighPriorityAlert(leadId) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, name, mobile, priority, total_price, tags, created_by, assigned_to
       FROM leads WHERE id = $1`,
      [leadId]
    );
    if (!rows.length) return;
    const lead = rows[0];

    const isHighPriority =
      ['high', 'urgent', 'vip'].includes((lead.priority || '').toLowerCase()) ||
      parseFloat(lead.total_price || 0) > 50000 ||
      (lead.tags || []).some(t => t.toLowerCase() === 'vip');

    if (!isHighPriority) return;

    const label   = lead.name || lead.mobile || `Lead #${leadId}`;
    const tag     = ['urgent', 'vip'].includes((lead.priority || '').toLowerCase())
      ? 'VIP client requires immediate response'
      : parseFloat(lead.total_price || 0) > 50000
      ? `High-value lead assigned (₹${Number(lead.total_price).toLocaleString('en-IN')})`
      : 'High priority lead assigned';

    const targets = [...new Set([lead.created_by, lead.assigned_to].filter(Boolean))];
    for (const uid of targets) {
      if (await alreadyNotifiedToday(client, uid, 'high_priority_lead', leadId)) continue;
      await notify(client, {
        userId: uid,
        type:   'high_priority_lead',
        title:  `High Priority: ${label}`,
        body:   tag,
        leadId,
      });
    }
  } catch (err) {
    console.error('[SmartAlerts] #2 High Priority error:', err.message);
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ALERT #3  Missed Follow-up Alert (Red / High)
// IF: follow-up time passed AND event is_done = FALSE
// Similar to #1 but targets only scheduled follow-up events (status_name set).
// ─────────────────────────────────────────────────────────────────────────────
async function fireMissedFollowupAlerts() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT
        le.id        AS event_id,
        le.lead_id,
        le.due_at,
        le.status_name,
        l.name       AS lead_name,
        l.mobile     AS lead_mobile,
        l.created_by,
        l.assigned_to
      FROM lead_events le
      JOIN leads l ON l.id = le.lead_id
      WHERE le.is_done = FALSE
        AND le.due_at < NOW()
        AND le.status_name IS NOT NULL
    `);

    for (const row of rows) {
      const label = row.lead_name || row.lead_mobile || `Lead #${row.lead_id}`;
      const targets = [...new Set([row.created_by, row.assigned_to].filter(Boolean))];
      for (const uid of targets) {
        if (await alreadyNotifiedToday(client, uid, 'missed_followup', row.lead_id)) continue;
        await notify(client, {
          userId: uid,
          type:   'missed_followup',
          title:  `Missed Follow-up: ${label}`,
          body:   `No response updated after scheduled follow-up`,
          leadId: row.lead_id,
        });
      }
    }
    console.log(`[SmartAlerts] #3 Missed Follow-up: checked ${rows.length} events`);
  } catch (err) {
    console.error('[SmartAlerts] #3 Missed Follow-up error:', err.message);
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ALERT #4  Daily Target Alert (Yellow / Medium)
// IF: completed activities < daily_target AND current time > 18:00 local
// Fires once per user per day after 6 PM.
// ─────────────────────────────────────────────────────────────────────────────
async function fireDailyTargetAlerts() {
  const client = await pool.connect();
  try {
    // Only fire after 18:00 (6 PM) server time
    const hour = new Date().getHours();
    if (hour < 18) {
      console.log('[SmartAlerts] #4 Daily Target: skipped (before 6 PM)');
      return;
    }

    // Count today's lead_activities per user
    const { rows } = await client.query(`
      SELECT
        u.id           AS user_id,
        u.name         AS user_name,
        u.daily_target,
        COUNT(la.id)::int AS activity_count
      FROM users u
      LEFT JOIN lead_activities la
        ON la.created_by = u.id
        AND la.created_at >= CURRENT_DATE
      WHERE u.is_active = TRUE
        AND u.daily_target > 0
      GROUP BY u.id, u.name, u.daily_target
      HAVING COUNT(la.id) < u.daily_target
    `);

    for (const row of rows) {
      if (await alreadyNotifiedToday(client, row.user_id, 'daily_target', null)) continue;
      await notify(client, {
        userId: row.user_id,
        type:   'daily_target',
        title:  'Daily Sales Target Pending',
        body:   `Only ${row.activity_count}/${row.daily_target} activities completed today`,
        leadId: null,
      });
    }
    console.log(`[SmartAlerts] #4 Daily Target: notified ${rows.length} users`);
  } catch (err) {
    console.error('[SmartAlerts] #4 Daily Target error:', err.message);
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ALERT #5  Inactive Lead Alert (Gray / Medium)
// IF: no lead_activities on lead for > 7 days
// ─────────────────────────────────────────────────────────────────────────────
async function fireInactiveLeadAlerts() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT
        l.id          AS lead_id,
        l.name        AS lead_name,
        l.mobile      AS lead_mobile,
        l.created_by,
        l.assigned_to,
        MAX(la.created_at) AS last_activity
      FROM leads l
      LEFT JOIN lead_activities la ON la.lead_id = l.id
      WHERE LOWER(COALESCE(l.status,'')) NOT IN ('closed','won','converted','lost')
      GROUP BY l.id, l.name, l.mobile, l.created_by, l.assigned_to
      HAVING MAX(la.created_at) < NOW() - INTERVAL '7 days'
          OR MAX(la.created_at) IS NULL
    `);

    for (const row of rows) {
      const label = row.lead_name || row.lead_mobile || `Lead #${row.lead_id}`;
      const targets = [...new Set([row.created_by, row.assigned_to].filter(Boolean))];
      for (const uid of targets) {
        if (await alreadyNotifiedToday(client, uid, 'inactive_lead', row.lead_id)) continue;
        await notify(client, {
          userId: uid,
          type:   'inactive_lead',
          title:  `Lead Inactive: ${label}`,
          body:   'Lead inactive for 7+ days. Reconnect with this customer.',
          leadId: row.lead_id,
        });
      }
    }
    console.log(`[SmartAlerts] #5 Inactive Lead: found ${rows.length} inactive leads`);
  } catch (err) {
    console.error('[SmartAlerts] #5 Inactive Lead error:', err.message);
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ALERT #6  Lead Escalation Alert (Purple / Critical)
// IF: overdue_days > 3 OR missed follow-ups >= 2
// ─────────────────────────────────────────────────────────────────────────────
async function fireEscalationAlerts() {
  const client = await pool.connect();
  try {
    // Find leads with either: overdue > 3 days, or 2+ missed (overdue) events
    const { rows } = await client.query(`
      SELECT
        l.id          AS lead_id,
        l.name        AS lead_name,
        l.mobile      AS lead_mobile,
        l.created_by,
        l.assigned_to,
        COUNT(le.id)::int                            AS missed_count,
        MAX(EXTRACT(DAY FROM NOW() - le.due_at))::int AS max_overdue_days
      FROM leads l
      JOIN lead_events le ON le.lead_id = l.id
      WHERE le.is_done = FALSE
        AND le.due_at < NOW()
        AND LOWER(COALESCE(l.status,'')) NOT IN ('closed','won','converted','lost')
      GROUP BY l.id, l.name, l.mobile, l.created_by, l.assigned_to
      HAVING
        COUNT(le.id) >= 2
        OR MAX(EXTRACT(DAY FROM NOW() - le.due_at)) > 3
    `);

    for (const row of rows) {
      const label = row.lead_name || row.lead_mobile || `Lead #${row.lead_id}`;
      const reason = row.missed_count >= 2
        ? `Repeated missed follow-ups detected (${row.missed_count}x)`
        : `Lead overdue by ${row.max_overdue_days} days`;

      // Notify assigned user + managers
      const targets = [...new Set([row.created_by, row.assigned_to].filter(Boolean))];

      // Also notify managers of the assigned user
      if (row.assigned_to) {
        const mgr = await client.query(
          `SELECT manager_id FROM users WHERE id = $1 AND manager_id IS NOT NULL`,
          [row.assigned_to]
        );
        if (mgr.rows[0]?.manager_id) targets.push(mgr.rows[0].manager_id);
      }

      for (const uid of [...new Set(targets)]) {
        if (await alreadyNotifiedToday(client, uid, 'lead_escalation', row.lead_id)) continue;
        await notify(client, {
          userId: uid,
          type:   'lead_escalation',
          title:  `Lead Escalated: ${label}`,
          body:   reason,
          leadId: row.lead_id,
        });
      }
    }
    console.log(`[SmartAlerts] #6 Escalation: found ${rows.length} escalated leads`);
  } catch (err) {
    console.error('[SmartAlerts] #6 Escalation error:', err.message);
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ALERT #7  Duplicate Lead Alert (Blue / Medium)
// Called inline from leads.controller on create.
// ─────────────────────────────────────────────────────────────────────────────
async function fireDuplicateLeadAlert(newLeadId, mobile, createdByUserId) {
  const client = await pool.connect();
  try {
    // Find any OTHER lead with the same mobile
    const { rows } = await client.query(
      `SELECT id FROM leads WHERE mobile = $1 AND id != $2 LIMIT 1`,
      [mobile, newLeadId]
    );
    if (!rows.length) return; // no duplicate

    await notify(client, {
      userId: createdByUserId,
      type:   'duplicate_lead',
      title:  'Duplicate Lead Detected',
      body:   `A lead with mobile ${mobile} already exists in the system`,
      leadId: newLeadId,
    });
  } catch (err) {
    console.error('[SmartAlerts] #7 Duplicate Lead error:', err.message);
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ALERT #9  Lead Conversion Alert (Green / Success)
// Called inline from leads.controller when status → won/converted.
// ─────────────────────────────────────────────────────────────────────────────
async function fireLeadConversionAlert(leadId, convertedByUserId) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT name, mobile, created_by, assigned_to FROM leads WHERE id = $1`,
      [leadId]
    );
    if (!rows.length) return;
    const lead  = rows[0];
    const label = lead.name || lead.mobile || `Lead #${leadId}`;

    const targets = [...new Set([lead.created_by, lead.assigned_to, convertedByUserId].filter(Boolean))];
    for (const uid of targets) {
      await notify(client, {
        userId: uid,
        type:   'lead_converted',
        title:  `🎉 Lead Converted: ${label}`,
        body:   'Congratulations! Deal closed successfully.',
        leadId,
      });
    }
  } catch (err) {
    console.error('[SmartAlerts] #9 Conversion error:', err.message);
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ALERT #10  No Activity Alert (Orange / Medium)
// IF: user has no lead_activities in the last 2 hours during working hours (9–18)
// ─────────────────────────────────────────────────────────────────────────────
async function fireNoActivityAlerts() {
  const client = await pool.connect();
  try {
    const hour = new Date().getHours();
    // Only fire during working hours: 9 AM – 6 PM
    if (hour < 9 || hour >= 18) {
      console.log('[SmartAlerts] #10 No Activity: outside working hours');
      return;
    }

    const { rows } = await client.query(`
      SELECT
        u.id   AS user_id,
        u.name AS user_name,
        MAX(la.created_at) AS last_activity
      FROM users u
      LEFT JOIN lead_activities la
        ON la.created_by = u.id
        AND la.created_at >= CURRENT_DATE
      WHERE u.is_active = TRUE
      GROUP BY u.id, u.name
      HAVING
        MAX(la.created_at) < NOW() - INTERVAL '2 hours'
        OR MAX(la.created_at) IS NULL
    `);

    for (const row of rows) {
      // Only notify once per 2-hour window
      const already = await client.query(
        `SELECT 1 FROM notifications
         WHERE user_id = $1 AND type = 'no_activity'
           AND created_at >= NOW() - INTERVAL '2 hours'
         LIMIT 1`,
        [row.user_id]
      );
      if (already.rowCount > 0) continue;

      await notify(client, {
        userId: row.user_id,
        type:   'no_activity',
        title:  'No Lead Activity',
        body:   'No lead activity logged in 2+ hours. Please update your leads.',
        leadId: null,
      });
    }
    console.log(`[SmartAlerts] #10 No Activity: checked ${rows.length} users`);
  } catch (err) {
    console.error('[SmartAlerts] #10 No Activity error:', err.message);
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary push — one push per user for all NEW notifications this tick
// "New" = created in the last 12 minutes (slightly > scheduler interval of 10m)
// Groups them: "5 new alerts — 3 Overdue Leads, 1 Missed Follow-up, 1 Escalation"
// ─────────────────────────────────────────────────────────────────────────────
const TYPE_LABELS = {
  overdue_lead:       'Overdue Lead',
  missed_followup:    'Missed Follow-up',
  high_priority_lead: 'High Priority Lead',
  daily_target:       'Daily Target',
  inactive_lead:      'Inactive Lead',
  lead_escalation:    'Escalation',
  duplicate_lead:     'Duplicate Lead',
  lead_assigned:      'Lead Assigned',
  lead_converted:     'Lead Converted',
  no_activity:        'No Activity',
};

async function sendSummaryPushes() {
  try {
    // Find all notifications created in the last 12 minutes, grouped by user + type
    const { rows } = await pool.query(`
      SELECT
        user_id,
        type,
        COUNT(*)::int AS cnt
      FROM notifications
      WHERE created_at >= NOW() - INTERVAL '12 minutes'
      GROUP BY user_id, type
      ORDER BY user_id, cnt DESC
    `);

    if (!rows.length) return;

    // Group by user
    const byUser = {};
    for (const row of rows) {
      if (!byUser[row.user_id]) byUser[row.user_id] = [];
      byUser[row.user_id].push(row);
    }

    for (const [userId, items] of Object.entries(byUser)) {
      const total = items.reduce((s, r) => s + r.cnt, 0);

      // Build summary line: "3 Overdue Leads, 1 Missed Follow-up"
      const parts = items.map(r => {
        const label = TYPE_LABELS[r.type] || r.type;
        return `${r.cnt} ${label}${r.cnt > 1 ? 's' : ''}`;
      });

      const title = `🔔 ${total} new alert${total > 1 ? 's' : ''}`;
      const body  = parts.join(', ');

      // Use the type of the first (most frequent) alert for the settings check
      const primaryType = items[0].type;
      sendPush(parseInt(userId, 10), primaryType, title, body, '/leads');
    }

    console.log(`[SmartAlerts] Summary push sent to ${Object.keys(byUser).length} user(s)`);
  } catch (err) {
    console.error('[SmartAlerts] Summary push error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run all scheduled alerts (called by scheduler on each tick)
// ─────────────────────────────────────────────────────────────────────────────
async function runScheduledAlerts() {
  console.log('[SmartAlerts] Running scheduled alert checks…');
  await Promise.allSettled([
    fireOverdueLeadAlerts(),
    fireMissedFollowupAlerts(),
    fireInactiveLeadAlerts(),
    fireDailyTargetAlerts(),
    fireEscalationAlerts(),
    fireNoActivityAlerts(),
  ]);
  // After all alerts are written to DB, send one summary push per user
  await sendSummaryPushes();
}

module.exports = {
  runScheduledAlerts,
  // Inline (called from leads controller)
  fireHighPriorityAlert,
  fireDuplicateLeadAlert,
  fireLeadConversionAlert,
};
