'use strict';

/**
 * Compliance gates and the gate pass.
 *
 * ══ COMPUTED FRESH, EVERY TIME ═════════════════════════════════════════════
 *
 * `computeGates` reads the card's own data and answers each gate from scratch.
 * Nothing is cached and nothing is stored, because the facts behind a gate
 * change after it is first evaluated — a finding gets edited, a photo gets
 * deleted, an inspection gets reopened — and a stored answer would keep saying
 * green after the reason for it was removed.
 *
 * ══ A GATE SAYS WHY ════════════════════════════════════════════════════════
 *
 * Every gate returns `detail`: the sentence a person reads. "3 of 4 complaints
 * have no finding recorded" is actionable; "Job Card Verification: FAILED" is
 * a thing to be angry at. The screen renders `detail` and nothing else.
 *
 * ══ WHAT THIS DELIBERATELY DOES NOT CHECK ══════════════════════════════════
 *
 * The plan defines Job Card Verification as "every complaint has a finding AND
 * a linked line item". Nothing in this schema links a complaint to an estimate
 * line — that link is phase 6's job. So only the finding half is checked, and
 * the gate SAYS SO in its detail. A gate that shows green for a check it is
 * not performing is worse than no gate.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { logActivity } = require('../services/activityLog.service');
const { loadCard, logJc, handle, idParam } = require('./job_cards.controller');

/* ── The gates, in the order a floor meets them ──────────────────────────────
   `blocks` is which transition the gate stands in front of. The split is not
   cosmetic: the plan asked for no invoice before `ready` AND for an invoice to
   exist before `ready`, which is a deadlock. Billing therefore gates the
   HANDOVER, which is the transition it actually belongs to — the customer pays
   and then the car leaves. */
const GATES = Object.freeze([
  { key: 'quality_check',         label: 'Quality check',         blocks: 'ready',     manual: false },
  { key: 'job_card_verification', label: 'Job card verification', blocks: 'ready',     manual: false },
  { key: 'parts_inspection',      label: 'Parts inspection',      blocks: 'ready',     manual: true  },
  /* Added with migration 194. OFF for every hub until one switches
     parts_must_be_billed on — see the case below for why that is not
     cowardice. */
  { key: 'parts_reconciled',      label: 'Parts billed',          blocks: 'ready',     manual: false },
  { key: 'media_upload',          label: 'Photos',                blocks: 'ready',     manual: false },
  { key: 'billing',               label: 'Billing',               blocks: 'delivered', manual: false },
]);
const GATE_KEYS = GATES.map(g => g.key);

/**
 * Every gate for one card, answered from the card's own data.
 *
 * @returns {Promise<Array<{key,label,blocks,manual,state,detail}>>}
 *   state: 'pass' | 'fail' | 'pending' | 'overridden' | 'not_required'
 */
async function computeGates(card, sections = {}) {
  const id = card.id;

  /* Lazily required: job_card_parts.controller pulls loadCard out of
     job_cards.controller, which pulls computeGates out of this file. */
  const { partsReconciliation } = require('./job_card_parts.controller');

  const [insp, complaints, media, stored, estInv, parts] = await Promise.all([
    pool.query(
      `SELECT i.id, i.status, i.completed_at, i.template_name,
              COUNT(r.id) FILTER (WHERE r.outcome = 'critical')::int AS critical_count
         FROM job_card_inspections i
         LEFT JOIN job_card_inspection_results r ON r.inspection_id = i.id
        WHERE i.job_card_id = $1 AND i.kind = 'pre_delivery'
        GROUP BY i.id
        ORDER BY i.id DESC LIMIT 1`, [id]),

    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE COALESCE(TRIM(finding), '') = '')::int AS blank
         FROM job_card_complaints WHERE job_card_id = $1`, [id]),

    pool.query(
      `SELECT COUNT(*) FILTER (WHERE stage = 'intake')::int   AS intake,
              COUNT(*) FILTER (WHERE stage = 'delivery')::int AS delivery,
              COUNT(*)::int                                    AS total
         FROM job_card_media WHERE job_card_id = $1`, [id]),

    pool.query(
      `SELECT gate, state, reason FROM job_card_gate_checks WHERE job_card_id = $1`, [id]),

    /* Every estimate for this visit, not just the newest. Once supplementary
       estimates exist (migration 193) a visit can carry several, and "is this
       billed" has to mean all of them — otherwise a supplementary raised after
       the first invoice would let the car out unbilled. */
    pool.query(
      `SELECT
         (SELECT e.status FROM estimates e
           WHERE e.appointment_id = $1 AND e.parent_estimate_id IS NULL
           ORDER BY e.id DESC LIMIT 1)                            AS estimate_status,
         (SELECT COUNT(*)::int FROM estimates e
           WHERE e.appointment_id = $1 AND e.status <> 'cancelled') AS estimate_count,
         (SELECT COUNT(*)::int FROM estimates e
           WHERE e.appointment_id = $1 AND e.status <> 'cancelled'
             AND NOT EXISTS (SELECT 1 FROM customer_invoices ci
                              WHERE ci.estimate_id = e.id
                                AND ci.status <> 'cancelled'))     AS uninvoiced_count,
         (SELECT COUNT(*)::int FROM customer_invoices ci
            JOIN estimates e ON e.id = ci.estimate_id
           WHERE e.appointment_id = $1
             AND ci.status <> 'cancelled')                        AS invoice_count`,
      [card.appointment_id]),

    partsReconciliation(id),
  ]);

  const byGate = new Map(stored.rows.map(r => [r.gate, r]));
  const out = [];

  for (const g of GATES) {
    const override = byGate.get(g.key);

    /* An override wins over everything, and carries its reason forward so the
       screen can show WHY this is green rather than just that it is. */
    if (override?.state === 'overridden') {
      out.push({ ...g, state: 'overridden', quiet: true,
                 detail: override.reason || 'Overridden by a super admin.' });
      continue;
    }

    let state = 'fail', detail = '';
    /* Set by a gate that is NOT blocking but still has something a person
       should read. See the `quiet` note where this is pushed. */
    let noisy = false;

    switch (g.key) {
      case 'quality_check': {
        const r = insp.rows[0];
        if (!r)                        { state = 'fail';    detail = 'No pre-delivery check has been run.'; }
        else if (r.status !== 'completed') { state = 'pending'; detail = `"${r.template_name}" is started but not completed.`; }
        else {
          state  = 'pass';
          /* Criticals do NOT block. "Not OK, customer told, customer declined"
             is a real and common outcome, and a gate that refused it would be
             a gate people learn to override. Reported, not enforced. */
          detail = r.critical_count > 0
            ? `Completed, with ${r.critical_count} point${r.critical_count === 1 ? '' : 's'} still not OK — make sure the customer has been told.`
            : 'Completed with nothing outstanding.';
        }
        break;
      }

      case 'job_card_verification': {
        const { total, blank } = complaints.rows[0];
        if (total === 0) {
          /* No complaint recorded is not a failure — a routine service has
             none. It is worth saying out loud, though, because on a car that
             came in FOR something it means somebody skipped the intake. */
          state = 'pass';
          detail = 'No customer complaints were recorded for this visit.';
        } else if (blank > 0) {
          state = 'fail';
          detail = `${blank} of ${total} complaint${total === 1 ? '' : 's'} ha${blank === 1 ? 's' : 've'} no finding recorded.`;
        } else {
          state = 'pass';
          detail = `All ${total} complaint${total === 1 ? '' : 's'} answered. `
                 + 'Not checked: whether each one has a matching line on the estimate — that link arrives with supplementary estimates.';
        }
        break;
      }

      case 'parts_inspection': {
        /* The only gate a machine cannot answer. Somebody has to look at the
           old part beside the new one. */
        if (override?.state === 'passed') {
          state = 'pass';
          detail = override.reason
            ? `Confirmed — ${override.reason}`
            : 'Confirmed by a member of staff.';
        } else {
          state = 'pending';
          detail = 'Nobody has confirmed the replaced parts were shown yet.';
        }
        break;
      }

      case 'parts_reconciled': {
        /* The store's ledger against the customer's. A part issued with no
           estimate line behind it is work the hub has paid for and will not be
           paid for — the quietest way a workshop loses money, and invisible
           until issuing is recorded separately from billing (migration 194).

           Off by default, and that is a deliberate choice rather than a timid
           one: every hub issues parts before the supplementary estimate is
           raised, because the car is on the ramp. Switched on for everybody on
           deploy day this would stop every card mid-job. A hub turns it on
           once its store habits can survive it — until then the gate still
           REPORTS the number, which is most of the value. */
        const { total, unbilled, unbilled_names } = parts;
        if (sections.parts_must_be_billed !== true) {
          state  = 'not_required';
          noisy  = total > 0 && unbilled > 0;
          detail = total === 0
            ? 'No parts issued from the store for this job.'
            : unbilled > 0
              ? `${unbilled} of ${total} issued part${total === 1 ? '' : 's'} ${unbilled === 1 ? 'is' : 'are'} on no estimate line — ${unbilled_names}. Not blocking: switch it on in job card settings.`
              : `All ${total} issued part${total === 1 ? '' : 's'} linked to an estimate line.`;
        } else if (unbilled > 0) {
          state  = 'fail';
          detail = `${unbilled} issued part${unbilled === 1 ? '' : 's'} with no estimate line: ${unbilled_names}. Add ${unbilled === 1 ? 'it' : 'them'} to an estimate, or book ${unbilled === 1 ? 'it' : 'them'} back into the store.`;
        } else {
          state  = 'pass';
          detail = total === 0
            ? 'No parts were issued for this job.'
            : `All ${total} issued part${total === 1 ? '' : 's'} accounted for.`;
        }
        break;
      }

      case 'media_upload': {
        const m = media.rows[0];
        /* Off by default. When a hub has not asked for photos, this reports
           what there is and blocks nothing — turning it into a hard stop for
           everybody would make the first deploy of phase 5 the day no car
           could leave. */
        if (sections.photos_required_for_delivery !== true) {
          state  = 'not_required';
          detail = m.total > 0
            ? `${m.total} photo${m.total === 1 ? '' : 's'} on this card. Not required — switch it on in job card settings.`
            : 'No photos. Not required — switch it on in job card settings.';
        } else if (m.intake > 0 && m.delivery > 0) {
          state  = 'pass';
          detail = `${m.intake} on arrival, ${m.delivery} at handover.`;
        } else {
          state  = 'fail';
          detail = !m.intake && !m.delivery ? 'No photos on this card.'
                 : !m.intake                ? 'No photo of the vehicle on arrival.'
                                            : 'No photo of the vehicle at handover.';
        }
        break;
      }

      case 'billing': {
        const { estimate_status, estimate_count, uninvoiced_count, invoice_count } = estInv.rows[0];
        const extra = estimate_count - 1;                    // supplementaries
        if (!estimate_status) {
          state = 'fail'; detail = 'No estimate has been created for this visit.';
        } else if (uninvoiced_count > 0) {
          state = 'fail';
          /* Named precisely, because "no invoice raised yet" on a visit that
             already HAS an invoice is the most confusing thing this gate could
             say. The supplementary is the one that is missing one. */
          detail = invoice_count > 0
            ? `${uninvoiced_count} of ${estimate_count} estimates on this visit ${uninvoiced_count === 1 ? 'has' : 'have'} no invoice yet — extra work was found after the first one was billed.`
            : `Estimate is ${estimate_status}. No invoice raised yet.`;
        } else {
          state = 'pass';
          detail = extra > 0
            ? `Estimate ${estimate_status}, plus ${extra} supplementary — all invoiced.`
            : `Estimate ${estimate_status}, invoice raised.`;
        }
        break;
      }
    }

    /* ── `quiet` — presentation only; nothing but the screen reads it ────────
       A settled gate has nothing anybody needs to act on, and the card folds
       those away so what is left is what somebody has to go and do.

       Computed HERE rather than guessed from the state, because `not_required`
       means two different things: "there is nothing to reconcile", and "there
       IS an unbilled part, we are simply not blocking on it". The second is a
       warning wearing a green state, and a screen that folded it away on the
       state alone would hide the quietest way a workshop loses money — which is
       the exact thing that gate was written to surface.

       checkTransition and isGreen do not look at this. It decides what is on
       screen before somebody asks for it, and nothing else. */
    const quiet = state === 'pass' || state === 'overridden'
               || (state === 'not_required' && !noisy);

    out.push({ ...g, state, detail, quiet });
  }

  return out;
}

/* Green enough to pass. `not_required` counts — a gate a hub has switched off
   is not a gate, and treating it as a failure would block every card. */
const isGreen = g => g.state === 'pass' || g.state === 'overridden' || g.state === 'not_required';

/**
 * What stands in the way of a transition. Exported because job_cards'
 * setStatus is the thing that enforces it, and there must be exactly one
 * definition of "may this card move".
 *
 * @returns {Promise<{ok: boolean, blockers: Array, gates: Array}>}
 */
async function checkTransition(card, target, sections) {
  const gates = await computeGates(card, sections);

  /* Only `ready` and `delivered` are gated. Every other status stays exactly
     as free as it was in phase 3 — the floor still needs to move a card to
     On Hold at four in the afternoon without arguing with a checklist. */
  if (target !== 'ready' && target !== 'delivered') return { ok: true, blockers: [], gates };

  const blockers = gates.filter(g => g.blocks === target && !isGreen(g));

  /* Delivery also needs the pass itself. The gate pass is the moment the
     readings and the customer's signature are frozen together; without it
     `delivered` is just a word somebody picked from a dropdown. */
  if (target === 'delivered') {
    const p = await pool.query(
      `SELECT 1 FROM job_card_gate_passes WHERE job_card_id = $1`, [card.id]);
    if (!p.rowCount) {
      blockers.push({
        key: 'gate_pass', label: 'Gate pass', blocks: 'delivered',
        state: 'fail', detail: 'No gate pass has been issued for this vehicle.',
      });
    }
  }

  return { ok: blockers.length === 0, blockers, gates };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/job-cards/:id/gates
// ─────────────────────────────────────────────────────────────────────────────
function getGates(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const card = await loadCard(req, id);
    const sections = await readSections(card.hub_id);
    const gates = await computeGates(card, sections);
    const pass = await pool.query(
      `SELECT gp.*, u.name AS issued_by_name FROM job_card_gate_passes gp
         LEFT JOIN users u ON u.id = gp.issued_by
        WHERE gp.job_card_id = $1`, [id]);

    return res.json({
      items: gates,
      gate_pass: pass.rows[0] || null,
      /* Precomputed so the screen does not have to reimplement isGreen and
         get a different answer from the server. */
      ready_blockers:     gates.filter(g => g.blocks === 'ready'     && !isGreen(g)).map(g => g.key),
      delivered_blockers: gates.filter(g => g.blocks === 'delivered' && !isGreen(g)).map(g => g.key),
    });
  });
}

/* The same merge readSettings does in job_cards.controller. Duplicated as a
   two-line query rather than exported, because exporting it would pull the
   whole settings surface across a module boundary for one boolean. */
async function readSections(hubId) {
  const r = await pool.query(
    `SELECT hub_id, sections FROM job_card_settings
      WHERE hub_id IS NULL OR hub_id = $1`, [hubId ?? null]);
  const global = r.rows.find(x => x.hub_id === null)?.sections || {};
  const own    = hubId ? (r.rows.find(x => Number(x.hub_id) === Number(hubId))?.sections || {}) : {};
  return { ...global, ...own };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/job-cards/:id/gates/:gate — confirm the manual gate
// ─────────────────────────────────────────────────────────────────────────────
const confirmSchema = z.object({
  reason:    z.string().trim().max(500).nullable().optional(),   // what was shown
  photo_url: z.string().trim().max(1000).nullable().optional(),
});

function confirmGate(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const gate = z.enum(GATE_KEYS).parse(req.params.gate);
    const d    = confirmSchema.parse(req.body);
    const card = await loadCard(req, id);

    const def = GATES.find(g => g.key === gate);
    /* Confirming a computed gate by hand is exactly the checkbox-anyone-can-
       tick this design exists to avoid. If a computed gate is wrong, the fix
       is the data behind it, or an override with a reason. */
    if (!def.manual) {
      return res.status(400).json({
        error: `"${def.label}" is worked out from the job card, not ticked. Fix what it is reporting, or ask a super admin to override it.`,
        code: 'GATE_NOT_MANUAL',
      });
    }
    if (d.photo_url && !/^https?:\/\//i.test(d.photo_url)) {
      return res.status(400).json({ error: 'A photo must be an https link.' });
    }

    const r = await pool.query(
      `INSERT INTO job_card_gate_checks (job_card_id, gate, state, reason, photo_url, checked_by)
       VALUES ($1, $2, 'passed', NULLIF($3,''), NULLIF($4,''), $5)
       ON CONFLICT (job_card_id, gate) DO UPDATE
         SET state = 'passed', reason = EXCLUDED.reason, photo_url = EXCLUDED.photo_url,
             checked_by = EXCLUDED.checked_by, checked_at = NOW(), updated_at = NOW()
       RETURNING *`,
      [id, gate, d.reason ?? '', d.photo_url ?? '', req.user?.id ?? null]);

    await logJc(pool, id, req.user?.id, 'gate:pass', {
      newValue: def.label, note: d.reason || null,
    });
    return res.json({ item: r.rows[0] });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/job-cards/:id/gates/:gate/override
// ─────────────────────────────────────────────────────────────────────────────
function overrideGate(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const gate = z.enum(GATE_KEYS).parse(req.params.gate);
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body);
    const card = await loadCard(req, id);

    /* Super admin only, and this is the whole safety valve. A hub should not
       be left unpaid because one checklist row is stuck — but the person who
       decides that has to be somebody who can be asked about it afterwards. */
    if (!req.user?.is_super_admin) {
      return res.status(403).json({
        error: 'Only a super admin can override a compliance gate.',
        code: 'OVERRIDE_REQUIRES_SUPER_ADMIN',
      });
    }

    const def = GATES.find(g => g.key === gate);
    const r = await pool.query(
      `INSERT INTO job_card_gate_checks (job_card_id, gate, state, reason, checked_by)
       VALUES ($1, $2, 'overridden', $3, $4)
       ON CONFLICT (job_card_id, gate) DO UPDATE
         SET state = 'overridden', reason = EXCLUDED.reason,
             checked_by = EXCLUDED.checked_by, checked_at = NOW(), updated_at = NOW()
       RETURNING *`,
      [id, gate, reason, req.user?.id ?? null]);

    await logJc(pool, id, req.user?.id, 'gate:override', { newValue: def.label, note: reason });
    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'UPDATE', entity: 'job_card', entityId: id,
      description: `Gate "${def.label}" overridden on ${card.job_card_no}: ${reason}`,
    });
    return res.json({ item: r.rows[0] });
  });
}

// DELETE /api/job-cards/:id/gates/:gate — undo a confirmation or an override
function clearGate(req, res, next) {
  handle(req, res, next, async () => {
    const id   = idParam.parse(req.params.id);
    const gate = z.enum(GATE_KEYS).parse(req.params.gate);
    await loadCard(req, id);
    const r = await pool.query(
      `DELETE FROM job_card_gate_checks WHERE job_card_id = $1 AND gate = $2
       RETURNING state`, [id, gate]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Nothing recorded for that gate.' });
    /* Withdrawing an override is itself worth a line — it changes whether the
       car may leave. */
    await logJc(pool, id, req.user?.id, 'gate:clear', {
      oldValue: GATES.find(g => g.key === gate).label, note: r.rows[0].state,
    });
    return res.json({ ok: true });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/job-cards/:id/gate-pass — issue it
// ─────────────────────────────────────────────────────────────────────────────
const passSchema = z.object({
  odometer_out: z.coerce.number().int().min(0).max(9999999).nullable().optional(),
  fuel_out:     z.coerce.number().int().min(0).max(4).nullable().optional(),
  notes:        z.string().trim().max(1000).nullable().optional(),
});

function issueGatePass(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const d  = passSchema.parse(req.body);
    const card = await loadCard(req, id);

    const existing = await pool.query(
      `SELECT pass_no FROM job_card_gate_passes WHERE job_card_id = $1`, [id]);
    if (existing.rowCount) {
      return res.status(409).json({
        error: `Gate pass ${existing.rows[0].pass_no} has already been issued for this vehicle.`,
      });
    }

    /* The three things a gate pass is FOR, checked here rather than left to
       the screen — this is the last moment anything can be checked. */
    const odo = d.odometer_out ?? card.odometer_out;
    if (odo === null || odo === undefined) {
      return res.status(400).json({
        error: 'Record the odometer out before issuing a gate pass.', code: 'ODOMETER_OUT_REQUIRED',
      });
    }
    if (card.odometer_in !== null && Number(odo) < Number(card.odometer_in)) {
      return res.status(400).json({
        error: `Odometer out (${odo}) is lower than odometer in (${card.odometer_in}). Check the reading.`,
        code: 'ODOMETER_WENT_BACKWARDS',
      });
    }

    const items = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE state IN ('present', 'na'))::int AS returned,
              COUNT(*) FILTER (WHERE state = 'absent')::int           AS absent
         FROM job_card_items WHERE job_card_id = $1`, [id]);
    const { total, returned, absent } = items.rows[0];

    /* An item marked absent at intake is a dispute in waiting. It does not
       block — the customer may have taken the stepney home — but it has to be
       an explicit note on the pass rather than a silence. */
    if (absent > 0 && !(d.notes || '').trim()) {
      return res.status(400).json({
        error: `${absent} item${absent === 1 ? ' is' : 's are'} still marked absent. Add a note explaining it before issuing the pass.`,
        code: 'ABSENT_ITEMS_NEED_NOTE',
      });
    }

    const sig = await pool.query(
      `SELECT id, signer_name FROM job_card_signatures
        WHERE job_card_id = $1 AND role = 'customer' AND stage = 'delivery'
        ORDER BY id DESC LIMIT 1`, [id]);
    if (!sig.rowCount) {
      return res.status(400).json({
        error: 'The customer has to sign for the vehicle before a gate pass can be issued.',
        code: 'CUSTOMER_SIGNATURE_REQUIRED',
      });
    }

    const passNo = `${card.job_card_no}/GP`;
    const r = await pool.query(
      `INSERT INTO job_card_gate_passes
         (job_card_id, pass_no, odometer_out, fuel_out, items_total, items_returned,
          signature_id, notes, issued_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''),$9) RETURNING *`,
      [id, passNo, odo, d.fuel_out ?? card.fuel_out, total, returned,
       sig.rows[0].id, d.notes ?? '', req.user?.id ?? null]);

    /* Written back to the card too, so the card and the pass agree at the
       moment of issue. They can diverge later — the pass is the frozen one. */
    if (d.odometer_out !== undefined || d.fuel_out !== undefined) {
      await pool.query(
        `UPDATE job_cards SET odometer_out = $1, fuel_out = COALESCE($2, fuel_out), updated_at = NOW()
          WHERE id = $3`, [odo, d.fuel_out ?? null, id]);
    }

    /* The handover reading joins the trail (migration 196). Its timestamp is
       the pass's own, so the row and the pass cannot disagree about when the
       car left — and the trail ends where the job does rather than at the last
       status change before it. Same row shape the migration backfills for
       passes issued before this existed. */
    await pool.query(
      `INSERT INTO job_card_readings
         (job_card_id, status_from, status_to, odometer, fuel, note,
          source, recorded_by, recorded_at)
       SELECT $1, NULL, NULL, $2, $3, $4, 'gate_pass', $5, gp.issued_at
         FROM job_card_gate_passes gp WHERE gp.id = $6`,
      [id, odo ?? null, (d.fuel_out ?? card.fuel_out) ?? null,
       `Gate pass ${passNo}`, req.user?.id ?? null, r.rows[0].id]);

    await logJc(pool, id, req.user?.id, 'gate_pass', {
      newValue: passNo, note: `Signed by ${sig.rows[0].signer_name}, odometer ${odo}`,
    });
    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'CREATE', entity: 'job_card_gate_pass', entityId: r.rows[0].id,
      description: `Gate pass ${passNo} issued`,
    });

    return res.status(201).json({ item: r.rows[0] });
  });
}

// DELETE /api/job-cards/:id/gate-pass
function revokeGatePass(req, res, next) {
  handle(req, res, next, async () => {
    const id = idParam.parse(req.params.id);
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body || {});
    const card = await loadCard(req, id);
    /* Super admin only, with a reason. A gate pass is the document that says a
       vehicle legitimately left; anyone who can quietly delete one can erase
       the record of a car that should not have. */
    if (!req.user?.is_super_admin) {
      return res.status(403).json({ error: 'Only a super admin can revoke a gate pass.' });
    }
    const r = await pool.query(
      `DELETE FROM job_card_gate_passes WHERE job_card_id = $1 RETURNING pass_no`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'No gate pass to revoke.' });

    await logJc(pool, id, req.user?.id, 'gate_pass:revoke', { oldValue: r.rows[0].pass_no, note: reason });
    logActivity({
      userId: req.user?.id, userName: req.user?.name,
      action: 'DELETE', entity: 'job_card_gate_pass', entityId: id,
      description: `Gate pass ${r.rows[0].pass_no} revoked on ${card.job_card_no}: ${reason}`,
    });
    return res.json({ ok: true });
  });
}

module.exports = {
  GATES, GATE_KEYS, computeGates, checkTransition, readSections,
  getGates, confirmGate, overrideGate, clearGate, issueGatePass, revokeGatePass,
};
