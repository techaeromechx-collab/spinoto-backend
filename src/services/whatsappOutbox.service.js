'use strict';

/**
 * WhatsApp outbox worker.
 *
 * Drains wa_messages: takes `queued` rows whose retry time has come, sends them
 * through the Interakt adapter, and records what happened.
 *
 * Mirrors the poller in appointmentReminders.service.js — same shape, same
 * 30-minute-friendly reasoning about waking a suspended database, but a tighter
 * interval because a customer waiting on "your car is ready" is not the same as
 * a staff reminder.
 *
 * ── Claim, then send. Never send inside a transaction. ───────────────────────
 *
 * A send is a network round trip to Meta via a BSP and can take seconds. Holding
 * a row lock — and a pool connection — open across it would mean a batch of five
 * ties up one connection for the better part of a minute.
 *
 * So the work happens in two phases:
 *
 *   1. CLAIM (in a transaction, milliseconds): pick rows with
 *      FOR UPDATE SKIP LOCKED, push their next_retry_at into the future and
 *      increment attempts. Commit. The rows are now invisible to any other tick.
 *   2. SEND (no transaction): call the adapter, then write the outcome.
 *
 * The claim is what makes a crash safe. If the process dies between phases the
 * rows simply become visible again once the claim window lapses, and the
 * attempts counter has already been spent — so a crash loop cannot retry
 * forever.
 *
 * SKIP LOCKED means a second process (or an overlapping tick, if a batch runs
 * long) takes different rows rather than blocking or duplicating.
 */

const { pool } = require('../config/db');
const { sendTemplate, isConfigured } = require('../utils/interakt');
// The same function the dispatcher stamps rows with, so the two descriptions of
// a template cannot drift into disagreeing about what "unchanged" means.
const { templateFingerprint } = require('./whatsapp.dispatcher');

const BATCH = 10;
const INTERVAL_MS = 60 * 1000;

/** Give up after this many attempts. */
const MAX_ATTEMPTS = 4;

/**
 * How long a claimed row stays invisible while we try to send it, in minutes.
 *
 * Must comfortably exceed the worst-case batch duration: BATCH sends, each
 * bounded by the adapter's 20-second abort timer, run sequentially. Ten × 20s is
 * 200s, so 5 minutes leaves margin — but if BATCH grows, this must grow with it,
 * or a second process could re-claim rows that are still in flight and send them
 * twice.
 *
 * Passed as a parameter rather than interpolated into the SQL string. It is a
 * module constant today and therefore safe, but a template literal in a query
 * is an injection point waiting for someone to make it configurable.
 */
const CLAIM_WINDOW_MIN = 5;

/**
 * Backoff between retries. Only retryable failures reach this — a bad template
 * name or a number not on WhatsApp fails permanently on the first attempt.
 *
 * 1 → 2min, 2 → 8min, 3 → 30min. Deliberately not seconds: everything that gets
 * here is a transport problem, and a provider that is down is unlikely to be
 * back within a minute.
 */
function backoffMinutes(attempts) {
  return [2, 8, 30][Math.min(attempts, 3) - 1] || 30;
}

/**
 * Phase 1 — claim a batch.
 *
 * The join to wa_templates is not decoration. is_enabled is re-checked HERE,
 * at send time, not only when the message was queued: a kill switch that leaves
 * an already-full queue draining into customers' phones is not a kill switch.
 * Disabled rows are left in place rather than failed, so flipping the toggle
 * back on releases them.
 */
async function claimBatch() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT m.id, m.template_key, m.to_number, m.variables, m.attempts,
              m.template_fingerprint,
              t.provider_template_name, t.language_code, t.variables AS var_order,
              t.header_variables
         FROM wa_messages m
         JOIN wa_templates t ON t.id = m.template_id
        WHERE m.direction = 'out'
          AND m.status = 'queued'
          AND t.is_enabled
          AND t.is_active
          -- The attempts bound MUST be here, not only in recordFailure().
          --
          -- A row that is claimed but never recorded — process killed, a
          -- throw in the send loop — becomes visible again when its claim
          -- lapses. Without this predicate it would be re-claimed every five
          -- minutes forever, attempts climbing past the limit, with nothing
          -- ever moving it to 'failed'. And if the crash happened AFTER
          -- Interakt accepted the message, the customer receives it again on
          -- every cycle.
          AND m.attempts < $2
          AND (m.next_retry_at IS NULL OR m.next_retry_at <= NOW())
        ORDER BY m.id
        FOR UPDATE OF m SKIP LOCKED
        LIMIT $1`,
      [BATCH, MAX_ATTEMPTS]
    );

    if (rows.length) {
      await client.query(
        `UPDATE wa_messages
            SET attempts = attempts + 1,
                next_retry_at = NOW() + ($2 || ' minutes')::interval
          WHERE id = ANY($1::int[])`,
        [rows.map(r => r.id), CLAIM_WINDOW_MIN]
      );
    }

    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Phase 2 — record an outcome.
 *
 * The status guard `WHERE status = 'queued'` matters: a delivery webhook can
 * arrive before this write lands (the provider is fast and our own round trip
 * is not), and that webhook may already have moved the row to 'delivered'.
 * Writing 'sent' unconditionally would walk the status ladder backwards, which
 * §7 of the plan forbids for exactly this reason.
 */
async function recordSuccess(id, providerMessageId) {
  await pool.query(
    `UPDATE wa_messages
        SET status = 'sent', sent_at = NOW(),
            provider_message_id = $2,
            error_code = NULL, error_message = NULL, next_retry_at = NULL
      WHERE id = $1 AND status = 'queued'`,
    [id, providerMessageId]
  );
}

async function recordFailure(id, attempts, result) {
  const giveUp = !result.retryable || attempts >= MAX_ATTEMPTS;

  if (giveUp) {
    await pool.query(
      `UPDATE wa_messages
          SET status = 'failed', failed_at = NOW(),
              error_code = $2, error_message = $3, next_retry_at = NULL
        WHERE id = $1 AND status = 'queued'`,
      [id, result.errorCode || null, result.errorMessage || null]
    );
    return;
  }

  // Still queued, just later. The error is recorded anyway so a message that
  // eventually succeeds still shows what it struggled with.
  await pool.query(
    `UPDATE wa_messages
        SET error_code = $2, error_message = $3,
            next_retry_at = NOW() + ($4 || ' minutes')::interval
      WHERE id = $1 AND status = 'queued'`,
    [id, result.errorCode || null, result.errorMessage || null, backoffMinutes(attempts)]
  );
}

/**
 * Fail rows that exhausted their attempts without ever being recorded.
 *
 * The attempts predicate in claimBatch() stops those rows being retried, but on
 * its own it makes them INVISIBLE rather than resolved — permanently 'queued',
 * never sent, absent from any failure list, so nobody finds out. This is the
 * other half: the queue must end with an answer for every row.
 *
 * The next_retry_at guard means a row currently mid-flight is not swept out
 * from under the send that is still running.
 */
async function sweepExhausted() {
  const r = await pool.query(
    `UPDATE wa_messages
        SET status = 'failed', failed_at = NOW(),
            error_code = COALESCE(error_code, 'ABANDONED'),
            error_message = COALESCE(error_message,
              'Gave up after the maximum number of attempts without a recorded result — the process may have restarted mid-send.'),
            next_retry_at = NULL
      WHERE direction = 'out'
        AND status = 'queued'
        AND attempts >= $1
        AND (next_retry_at IS NULL OR next_retry_at <= NOW())
      RETURNING id`,
    [MAX_ATTEMPTS]
  );
  if (r.rowCount) {
    console.warn(`[whatsappOutbox] swept ${r.rowCount} abandoned message(s) to failed`);
  }
  return r.rowCount;
}

/**
 * Resolve rows whose TEMPLATE is no longer claimable.
 *
 * claimBatch requires `t.is_enabled AND t.is_active`. A row queued against a
 * template that is then switched off or retired therefore stops being visible
 * to the sender — and because sweepExhausted only looks at attempts >= MAX, a
 * row with attempts = 0 is invisible to that too. Permanently 'queued', never
 * sent, never failed, absent from every failure list. Exactly the silent
 * outcome the sweep above exists to prevent, arriving by a different door.
 *
 * This was already reachable by disabling a template in Settings. Adding a
 * retire button to that screen turns it into a one-click foot-gun, which is why
 * this lands with it rather than after it.
 *
 * A DISTINCT error code, not ABANDONED: "we gave up after four attempts" and
 * "the template was retired underneath it" are different answers, and the
 * second one names something a person did and can undo.
 *
 * The attempts guard is deliberate. A row that has already been TRIED against a
 * live template and is merely waiting to be retried keeps its retries — the
 * template being switched off mid-backoff should not throw away a message that
 * was moments from succeeding. Only rows that never left the queue are swept.
 */
async function sweepUnsendable() {
  const r = await pool.query(
    `UPDATE wa_messages m
        SET status = 'failed', failed_at = NOW(),
            error_code = COALESCE(error_code, 'TEMPLATE_UNAVAILABLE'),
            error_message = COALESCE(error_message,
              'The template was switched off or retired before this message was sent.'),
            next_retry_at = NULL
      WHERE m.direction = 'out'
        AND m.status = 'queued'
        AND m.attempts = 0
        AND NOT EXISTS (
          SELECT 1 FROM wa_templates t
           WHERE t.id = m.template_id
             AND t.is_enabled
             AND t.is_active
        )
      RETURNING m.id`
  );
  if (r.rowCount) {
    console.warn(`[whatsappOutbox] swept ${r.rowCount} message(s) whose template is no longer sendable`);
  }
  return r.rowCount;
}

/**
 * recordSuccess, retried.
 *
 * Called only after the provider has accepted the message, which is why it
 * retries at all: at that point the customer has received it and the only
 * remaining question is whether our own record says so. A row left saying
 * 'queued' is a row that will be sent a second time.
 *
 * Short waits — 150ms, 600ms. This is a live request path and the failure it
 * covers is a transient one; a longer ladder would hold the send loop open
 * while the claim window ticks down, which is its own way of causing the
 * duplicate this is here to prevent.
 */
async function recordSuccessDurably(id, providerMessageId) {
  const waits = [150, 600];
  for (let attempt = 0; ; attempt++) {
    try {
      await recordSuccess(id, providerMessageId);
      if (attempt > 0) {
        console.warn(`[whatsappOutbox] row ${id} recorded on retry ${attempt}`);
      }
      return;
    } catch (err) {
      if (attempt >= waits.length) {
        // Deliberately loud, and deliberately NOT rethrown: throwing would
        // land in the caller's catch, which treats a throw as "try again
        // later" — the exact re-send this function exists to avoid.
        console.error(
          `[whatsappOutbox] SENT BUT NOT RECORDED — row ${id}, provider id ` +
          `${providerMessageId || 'unknown'}. The customer HAS received this ` +
          `message. Set it to 'sent' by hand before the claim lapses, or it ` +
          `will be sent again. Cause: ${err.message}`
        );
        return;
      }
      await new Promise(r => setTimeout(r, waits[attempt]));
    }
  }
}

/**
 * One drain at a time, process-wide.
 *
 * `running` used to be a closure local inside startWhatsappOutbox, so it only
 * guarded the interval tick. drainOnce is exported and fire-and-forgotten from
 * both send endpoints — which is exactly the path that produces the doubled
 * load the guard was written to prevent: an advisor's tab wedges, re-posts
 * twenty times, and twenty drains overlap. SKIP LOCKED keeps that CORRECT (each
 * claims different rows) but the point of the guard was never correctness, it
 * was not piling requests onto a provider that is already the reason a batch is
 * slow.
 *
 * Module-level, so the poller and every nudge share it.
 *
 * A nudge that arrives while a drain is running returns immediately rather than
 * queueing. That is the right behaviour: the drain already in flight will claim
 * whatever was just inserted, because the row was committed before the nudge
 * was fired.
 */
let draining = false;

async function drainOnce() {
  // Nothing to do without a key, and claiming rows would burn their attempts
  // against a provider we cannot reach. Leave them queued.
  if (!isConfigured()) return { claimed: 0, sent: 0, failed: 0 };

  if (draining) return { claimed: 0, sent: 0, failed: 0, skipped: true };
  draining = true;
  try {
    return await drainInner();
  } finally {
    draining = false;
  }
}

async function drainInner() {

  await sweepExhausted().catch(err =>
    console.error('[whatsappOutbox] sweep failed:', err.message));
  // Same place, same never-throw treatment: a sweep failing must not stop the
  // drain that follows it.
  await sweepUnsendable().catch(err =>
    console.error('[whatsappOutbox] unsendable sweep failed:', err.message));

  let rows;
  try {
    rows = await claimBatch();
  } catch (err) {
    console.error('[whatsappOutbox] claim failed:', err.message);
    return { claimed: 0, sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    // Per-row try/catch. recordSuccess/recordFailure use the pool and can
    // throw; without this a single database blip would abandon the rest of an
    // already-claimed batch, with their attempts spent and no send made.
    try {
      // Resolved values were frozen at queue time; the ORDER comes from the
      // template as it stands now. So RE-ORDERING a mis-mapped template fixes
      // the messages still waiting in the queue.
      //
      // ADDING a variable does not — that value was never resolved, so it
      // arrives undefined and the adapter fails the row permanently on
      // MISSING_VARIABLE. Those have to be re-queued, not retried.
      const order = Array.isArray(row.var_order) ? row.var_order : [];
      const headerOrder = Array.isArray(row.header_variables) ? row.header_variables : [];
      const bodyValues = order.map(k => row.variables?.[k]);
      const headerValues = headerOrder.map(k => row.variables?.[k]);

      // ── Is this still the template the message was queued against? ──
      //
      // The SELECT above re-reads the provider name, language and variable
      // order from the template row, while the VALUES were frozen at queue
      // time. Correcting a bad mapping therefore fixes messages already in the
      // queue, which is deliberate and good.
      //
      // The bad case is the same mechanism: an admin changing
      // provider_template_name from 'invoice_' to 'invoice_v2_' between queue
      // and send makes this row fire against a different Meta template, whose
      // placeholder count may differ, carrying values resolved for the old one.
      // Nothing warned, and body_rendered still showed the old rendering.
      //
      // Failing is the right outcome. A failed message an advisor can resend is
      // recoverable; a wrong message on a customer's phone is not. Rows queued
      // before migration 149 have no fingerprint and skip the check, so this
      // cannot fail a backlog it knows nothing about.
      const currentFingerprint = templateFingerprint({
        provider_template_name: row.provider_template_name,
        language_code: row.language_code,
        variables: row.var_order,
        header_variables: row.header_variables,
      });
      if (row.template_fingerprint && row.template_fingerprint !== currentFingerprint) {
        await recordFailure(row.id, MAX_ATTEMPTS, {
          retryable: false,
          errorCode: 'TEMPLATE_CHANGED',
          errorMessage:
            `The template was edited after this message was queued, so it was not sent. ` +
            `Queued against: ${row.template_fingerprint}. Now: ${currentFingerprint}. ` +
            `Resend it if the new version is correct.`,
        });
        failed++;
        continue;
      }

      const result = await sendTemplate({
        to: row.to_number,
        templateName: row.provider_template_name,
        languageCode: row.language_code,
        bodyValues,
        headerValues,
        // The row id, so a status webhook can be matched even if it arrives
        // before recordSuccess() has written provider_message_id.
        callbackData: String(row.id),
      });

      if (result.ok) {
        // ── The message HAS been sent. The write must not be the weak link ──
        //
        // Interakt has accepted it and the customer's phone is already
        // buzzing. If recordSuccess throws here — a connection reset, a cold
        // database waking up — the catch below logs and moves on, the row
        // keeps status 'queued' with attempts unchanged, and five minutes
        // later the claim lapses and the SAME message is sent again. Up to
        // four copies of "your car is ready" for one event.
        //
        // Nothing downstream collapses them: callbackData is correlation, not
        // an idempotency key, and the provider has no record that this is a
        // repeat.
        //
        // So this one write gets its own retries. Not the send — the send is
        // done and must never be repeated — only the recording of it. If the
        // database is unreachable for all three attempts then nothing in the
        // application is working, and the log line below carries the provider
        // message id so the row can be reconciled by hand.
        await recordSuccessDurably(row.id, result.providerMessageId);
        sent++;
      } else {
        await recordFailure(row.id, row.attempts + 1, result);
        failed++;
      }
    } catch (err) {
      // The row keeps its spent attempt and becomes visible again when the
      // claim lapses. Bounded by the attempts predicate in claimBatch().
      console.error(`[whatsappOutbox] row ${row.id} threw:`, err.message);
      failed++;
    }
  }

  if (rows.length) {
    console.log(`[whatsappOutbox] ${rows.length} claimed — ${sent} sent, ${failed} failed`);
  }
  return { claimed: rows.length, sent, failed };
}

/**
 * Start the poller. Called once from server.js.
 *
 * The `running` flag stops overlapping ticks: a batch that takes longer than
 * the interval (ten sends against a slow provider easily could) must not have a
 * second tick start beside it. SKIP LOCKED would keep that correct, but it
 * would also quietly double the concurrent load on a provider that is already
 * struggling.
 */
function startWhatsappOutbox() {
  // No local flag any more — drainOnce owns the guard, so the interval and the
  // manual-send nudges genuinely share it rather than each having their own.
  const tick = async () => {
    try {
      await drainOnce();
    } catch (err) {
      console.error('[whatsappOutbox] tick failed:', err.message);
    }
  };

  // Run once at boot as well as on the interval, matching
  // appointmentReminders.service.js:139 — otherwise a restart leaves anything
  // queued sitting for a full minute before the first drain.
  tick();

  const handle = setInterval(tick, INTERVAL_MS);
  // Do not hold the event loop open on shutdown; a pending timer would keep
  // the process alive after the HTTP server closes.
  if (typeof handle.unref === 'function') handle.unref();

  if (!isConfigured()) {
    console.warn('[whatsappOutbox] INTERAKT_API_KEY not set — messages will queue but nothing will send.');
  }
  console.log('[whatsappOutbox] Poller started — draining every 60 seconds');
}

module.exports = { startWhatsappOutbox, drainOnce, sweepExhausted, sweepUnsendable };
