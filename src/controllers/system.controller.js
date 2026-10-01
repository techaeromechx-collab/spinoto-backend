'use strict';

/**
 * Settings → System Health.
 *
 * ══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
 *
 * The database runs on AWS and the people who own this CRM have no console
 * access to it. So the two questions that matter most when something looks
 * wrong — "did the last deploy actually run its migrations?" and "did every
 * WhatsApp message today turn into something?" — could only be answered by
 * somebody with a database client and the production credentials.
 *
 * Both answers were already in the database. They just had no screen.
 *
 *   schema_migrations  written by db/migrate.js on every run. Comparing it to
 *                      the .sql files on disk gives the pending list exactly,
 *                      rather than by inference from whether a feature works.
 *   wa_events          the append-only webhook log. Every inbound message
 *                      Interakt has ever sent, including the ones that failed.
 *                      It has existed since migration 112 and nothing has ever
 *                      read it — 112's own comment calls it "the diagnostics
 *                      view" that was never built.
 *
 * ══ READ ONLY ═══════════════════════════════════════════════════════════════
 *
 * Nothing here writes. It does not run migrations and must never be given the
 * ability to: a migration is a deliberate act with a deploy around it, and a
 * button that runs one from a settings screen is a button somebody presses at
 * 6pm on a Friday to see what happens.
 */

const fs   = require('fs');
const path = require('path');
const { pool } = require('../config/db');

/* The same directory db/migrate.js reads, reached the same way. If the two ever
   disagree this page reports a pending list that does not exist. */
const MIGRATIONS_DIR = path.join(__dirname, '../../db/migrations');

/**
 * Does this table exist?
 *
 * to_regclass returns NULL rather than throwing, which is the point: a brand
 * new database has no schema_migrations, and a deployment that predates
 * migration 112 has no wa_events. Either one must read as "nothing to report
 * yet", never as a 500 on the page somebody opened BECAUSE something was wrong.
 */
async function tableExists(name) {
  const r = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [name]);
  return r.rows[0].ok;
}

/**
 * Which migrations are on disk, and which of those has the database seen?
 *
 * The comparison is on FILENAME, exactly as migrate.js does it — that is the
 * primary key of schema_migrations. Sorted lexicographically for the same
 * reason the runner sorts that way, which is also why every filename in this
 * project is zero-padded to three digits.
 */
async function migrationStatus() {
  let files = [];
  let filesError = null;
  try {
    files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  } catch (err) {
    // A deploy that ships only src/ would land here. Worth saying out loud:
    // "0 pending" from a directory that could not be read is a lie that looks
    // like good news.
    filesError = err.code === 'ENOENT'
      ? 'The migrations folder is not present on this server.'
      : `Could not read the migrations folder: ${err.code || err.message}`;
  }

  if (!await tableExists('schema_migrations')) {
    return {
      table_missing: true,
      files_error: filesError,
      total: files.length,
      applied: 0,
      pending: files,
      last_applied: null,
    };
  }

  const r = await pool.query(
    `SELECT filename, applied_at FROM schema_migrations ORDER BY applied_at DESC, filename DESC`);
  const applied = new Set(r.rows.map(x => x.filename));

  return {
    table_missing: false,
    files_error: filesError,
    total: files.length,
    applied: applied.size,
    /* On disk and not in the table. Deliberately NOT the reverse as well: a row
       in schema_migrations whose file has since been renamed is not something
       this page can do anything about, and reporting it as a problem would make
       the page cry wolf on every tidy-up. */
    pending: files.filter(f => !applied.has(f)),
    last_applied: r.rows[0]
      ? { filename: r.rows[0].filename, applied_at: r.rows[0].applied_at }
      : null,
  };
}

/**
 * Today's inbound WhatsApp, reconciled.
 *
 * The numbers answer one question in order: 35 messages arrived, so why are
 * there 27 new leads? Each line below is one of the reasons, and they are meant
 * to add up.
 *
 *   received            customer messages only. NOT the bot's own greetings and
 *                       not delivery receipts — neither can create a lead, and
 *                       counting them is what makes Interakt's dashboard number
 *                       disagree with this one.
 *   distinct_numbers    how many PEOPLE. One customer sending "Hi", then "need
 *                       service", then "Swift 2019" is three messages and one
 *                       lead, which is correct and is usually the whole gap.
 *   new_leads           leads the webhook created today.
 *   landed_on_existing  people who already had an open lead, so no new one was
 *                       made. Also correct, and invisible until now.
 *   dropped             NOT AN INDIAN MOBILE. utils/phone.js accepts
 *                       ^[6-9]\\d{9}$ only, so a customer messaging from +971 or
 *                       +44 produces no lead, no message and no trace on any
 *                       other screen. This is the one line on this page that is
 *                       a real lost customer.
 *   failed              everything else that errored, or was stored and never
 *                       processed at all.
 *
 * `landed_on_existing` is computed by joining wa_conversations rather than by
 * reading leads.last_enquiry_at, so that it works BEFORE migration 205 has been
 * applied — which, on a page whose entire job is to tell you that 205 has not
 * been applied, is not an optional property.
 */
const SENDER = `payload->'data'->'customer'->>'channel_phone_number'`;
const NAT10  = (expr) => `RIGHT(regexp_replace(COALESCE(${expr}, ''), '\\D', '', 'g'), 10)`;

async function whatsappToday() {
  if (!await tableExists('wa_events')) {
    return { available: false, reason: 'The WhatsApp webhook log does not exist on this database yet.' };
  }

  const [counts, existing, problems] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE event_type = 'message_received')::int          AS received,
         COUNT(DISTINCT ${SENDER}) FILTER (WHERE event_type = 'message_received')::int
                                                                              AS distinct_numbers,
         COUNT(*) FILTER (WHERE process_error = 'unparseable_sender_number')::int AS dropped,
         COUNT(*) FILTER (WHERE process_error IS NOT NULL
                            AND process_error <> 'unparseable_sender_number')::int AS failed,
         COUNT(*)::int                                                        AS all_events
       FROM wa_events
       WHERE received_at::date = CURRENT_DATE`),

    pool.query(
      `SELECT COUNT(DISTINCT c.lead_id)::int AS n
         FROM wa_events e
         JOIN wa_conversations c
           ON ${NAT10('c.mobile')} = ${NAT10(`e.${SENDER}`)}
         JOIN leads l ON l.id = c.lead_id
        WHERE e.received_at::date = CURRENT_DATE
          AND e.event_type = 'message_received'
          AND l.created_at::date < CURRENT_DATE`),

    /* The numbers themselves, because a count of 2 that you cannot act on is
       not much better than a count of 0. These are customers who messaged and
       got nothing — somebody should ring them. Capped so one bad afternoon
       cannot return ten thousand rows into a settings page. */
    pool.query(
      `SELECT received_at,
              ${SENDER} AS number,
              process_error AS reason
         FROM wa_events
        WHERE received_at::date = CURRENT_DATE
          AND process_error IS NOT NULL
        ORDER BY received_at DESC
        LIMIT 50`),
  ]);

  const newLeads = await pool.query(
    `SELECT COUNT(*)::int AS n FROM leads
      WHERE lead_source = 'WhatsApp' AND created_at::date = CURRENT_DATE`);

  const c = counts.rows[0];
  return {
    available: true,
    received:           c.received,
    distinct_numbers:   c.distinct_numbers,
    new_leads:          newLeads.rows[0].n,
    landed_on_existing: existing.rows[0].n,
    dropped:            c.dropped,
    failed:             c.failed,
    all_events:         c.all_events,
    problems: problems.rows.map(r => ({
      at: r.received_at, number: r.number, reason: r.reason,
    })),
  };
}

/** GET /api/system/health — super admin only. */
async function getHealth(req, res, next) {
  try {
    const db = await pool.query(`SELECT NOW() AS now, version() AS version`);

    const [migrations, whatsapp] = await Promise.all([
      migrationStatus(),
      // Never allowed to take the page down with it. The migration list is the
      // reason somebody opened this screen; the WhatsApp block is a bonus, and a
      // bonus that 500s the page it is attached to is worse than no bonus.
      whatsappToday().catch(err => ({
        available: false,
        reason: `Could not read the WhatsApp log: ${err.message}`,
      })),
    ]);

    res.json({
      checked_at: new Date().toISOString(),
      migrations,
      database: {
        ok: true,
        time: db.rows[0].now,
        // "PostgreSQL 16.4 on aarch64…" trimmed to the part anybody reads.
        version: String(db.rows[0].version).split(' ').slice(0, 2).join(' '),
      },
      server: {
        uptime_seconds: Math.round(process.uptime()),
        env: process.env.NODE_ENV || 'development',
        node: process.version,
      },
      whatsapp,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getHealth };
