'use strict';

/**
 * chatRefs.service.js — turning a pointer into something a reader may see.
 *
 * ══ THE RULE THIS FILE EXISTS FOR ══════════════════════════════════════════
 *
 *   Receiving a CRM record through chat is not permission to open it.
 *
 * chat_messages stores (ref_type, ref_id) and NOTHING ELSE — no label, no
 * customer name, no amount, no plate, no phone number. So if the viewer turns
 * out not to have access there is nothing in the message row to leak, because
 * there is nothing in it. This file is the only place a pointer becomes words,
 * and it decides per viewer, every time.
 *
 * ══ HOW EACH RULE WAS ESTABLISHED ══════════════════════════════════════════
 *
 * By reading that record's own route file, not by deciding what seemed
 * reasonable. Each entry below names the file its `codes` came from so the next
 * person can check it in one step, and so a change to that route shows up as a
 * disagreement with a comment rather than as nothing at all.
 *
 * Two of the eight types migration 197 listed are NOT here, and migration 198
 * removes them from the CHECK constraint:
 *
 *   customer — addressed by MOBILE, not id (routes/customers.routes.js has
 *              GET /:mobile and no GET /:id), and a 10-digit Indian mobile is
 *              larger than INTEGER can hold.
 *   vehicle  — has no per-record route at all; vehicles.routes.js serves master
 *              data (/types, /makes, /models, /segments, /body-types).
 *
 * A type without a resolver stays out of the constraint. Adding one without its
 * resolver is a data leak with a chip around it.
 *
 * ══ WHAT A STAFF USER'S GATE ACTUALLY IS ═══════════════════════════════════
 *
 * Most of these routes use requirePermissionOrHub. For a STAFF session that
 * middleware reduces exactly to requirePermission — the hub branch is entered
 * only when req.user.hub_id is set (auth.middleware.js), and chat is staff-only
 * (RequireAdmin in App.jsx, plus hub_id IS NULL in the directory query). So the
 * code list IS the whole gate here, and the hub-tenancy half of those routes
 * (assertHubOwns, which is a no-op for staff) has no counterpart to reproduce.
 *
 * ⚠️ IF CHAT EVER REACHES HUB USERS, THIS FILE IS WRONG AND MUST BE REVISITED
 *    BEFORE THEY GET IT. Every resolver below would then need the hub_id check
 *    its record's getter applies, and `codes` would need the hub's
 *    zero-permissions-means-open behaviour. It is not a small edit and it is not
 *    optional. See chat.directory.controller.js for why hub users are excluded
 *    today.
 *
 * ══ WHAT IS DELIBERATELY NOT IN A LABEL ════════════════════════════════════
 *
 * No phone number, ever, in any resolver here — not even though every reader is
 * staff today. utils/maskMobile.js masks the KEYS `mobile` and `whatsapp` for
 * hub sessions and cannot mask a number inside a label string, so a chip that
 * carried one would be the thing that has to be found and fixed later. Keeping
 * numbers out now costs nothing and means phase 5 does not have to come back
 * here.
 *
 * ══ THE LINK IS A TOKEN, NOT AN ID ═════════════════════════════════════════
 *
 * Every one of these records is routed by its PUBLIC TOKEN, not its id:
 * App.jsx mounts /estimates/:token, and EstimatesPage calls
 * `/api/estimates/by-token/<token>`. utils/publicToken.js resolveTokenToId looks
 * up public_token with NO numeric fallback, so `/estimates/412` resolves to null
 * and 404s. The first version of this file built `/estimates/${id}` for all six
 * and every chip was a dead link — the chips rendered, the labels were right, and
 * clicking went nowhere.
 *
 * job_card is the exception twice over: it has no token, and it is mounted at
 * /job-cards/:appointmentId — the card's APPOINTMENT, not the card. A link built
 * from the card id looks correct and opens the wrong card or none.
 *
 * So each load() selects the key its own route needs, and href() takes the loaded
 * ROW rather than an id. A row with no token yields no href; see the comment at
 * the call site.
 *
 * ── Is returning a public token a leak? ──
 * No, and it is worth being explicit because the same token also opens a
 * CUSTOMER-FACING page (/estimate/:token, singular, unauthenticated). The token
 * is only ever returned with allowed:true — i.e. to somebody who may already open
 * the record through the authenticated screen — so it grants nothing they did not
 * already have. It is never in a refused response, which is why the refused shape
 * has no href key at all.
 *
 * Labels are also spelled the way the screens and the paper spell them —
 * EST-000412, CI-000066 — so a chip and the document it points at read as the
 * same thing. Both are computed from the id in the UI (EstimatesPage.jsx,
 * CustomerInvoicesPage.jsx); neither table has a number column.
 */

const { pool } = require('../config/db');
/* The lead-visibility rule, from the one place it lives. NOT from
   leads.controller.js: importing that would pull the whole lead subsystem —
   whatsappAutomations, activityLog, sendPush, publicToken — into a chat request
   for the sake of two small functions. utils/leadScope.js says more about why it
   is not a copy. */
const { scopeConditions, teamIdsIfNeeded } = require('../utils/leadScope');

/** EST-000412 / CI-000066, matching the screens and the PDF filename. */
const pad6 = (id) => String(id).padStart(6, '0');

/**
 * Does this user hold any of the codes that record's own GET route requires?
 *
 * Super admin passes everything, exactly as requirePermission does — this is
 * that middleware's rule, applied by hand because the check is happening inside
 * a request rather than in front of one.
 */
function holds(user, codes) {
  if (user.is_super_admin) return true;
  return codes.some((c) => user.permissions.has(c));
}

/* ═══════════════════════════════════════════════════════════════════════════
   The registry. One entry per type.

   codes  — read off that record's canView in its own routes file, named below.
   href   — the existing frontend route. The chip only navigates; RequirePermission
            on that route is what actually lets them in, so this is a
            convenience, never a grant.
   load   — batched: ONE query per type per request, `= ANY($1)`. Fifty bubbles
            with eight refs is at most six queries, not eight, and never one per
            chip.
   ═══════════════════════════════════════════════════════════════════════════ */

const RESOLVERS = {
  /* routes/leads.routes.js:
       router.get('/:id', requireAuth,
         requirePermission('VIEW_LEAD','VIEW_TEAM_LEADS','VIEW_OWN_LEADS'), c.getLead)

     THE ONLY TYPE WITH ROW SCOPING FOR STAFF. Holding VIEW_OWN_LEADS is not
     permission to see every lead — getLead applies scopeConditions, so a lead
     somebody else created and was never given to you is a 404 there and must be
     `allowed: false` here. Anything less and chat becomes a way around the
     Leads page. */
  lead: {
    codes: ['VIEW_LEAD', 'VIEW_TEAM_LEADS', 'VIEW_OWN_LEADS'],
    href: (row) => (row.token ? `/leads/${row.token}` : null),
    noun: 'lead',
    async load(ids, req) {
      /* The imported rule, not a restatement of it — see utils/leadScope.js.
         params starts with the id array because scopeConditions pushes onto the
         end of whatever it is given, and it expects the table aliased `l`. */
      const params = [ids];
      const scope = scopeConditions(req.user, await teamIdsIfNeeded(req.user), params);
      const { rows } = await pool.query(
        /* l.status is a PLAIN TEXT COLUMN on leads — there is no status_id and
           no join to lead_statuses. I had written the join, and here it was
           worse than a crash: this resolver catches its own errors and reports
           allowed:false, so every shared lead would silently have read "you
           don't have access to this record" to somebody who had every lead
           permission. Read off LEAD_SELECT in leads.controller.js. */
        `SELECT l.id,
                l.public_token AS token,
                NULLIF(BTRIM(COALESCE(l.name, '')), '') AS name,
                l.status AS status_name,
                /* ── WHO OWNS IT, shown on the chip ───────────────────────
                   A lead shared into a group is a lead somebody is being asked
                   to do something about, and the first question is whose it is.
                   Without this the chip says "Quoted" and nothing else, so an
                   UNASSIGNED lead — which in this workshop means "in a manager's
                   in-tray", not "up for grabs" — is indistinguishable from one
                   already being worked.
                   A LEFT JOIN: assigned_to is nullable and NULL is the state
                   worth showing most. */
                au.name AS assigned_to_name
           FROM leads l
           LEFT JOIN users au ON au.id = l.assigned_to
          WHERE l.id = ANY($1::int[])
            ${scope.length ? `AND ${scope.join(' AND ')}` : ''}`,
        params
      );
      /* A lead the scope excluded simply is not in `rows`, so it falls through
         to allowed:false below — which is the same answer getLead gives, by the
         same rule, without this file knowing what the rule is. */
      return new Map(rows.map((r) => [r.id, {
        token: r.token,
        label: r.name || `Lead #${r.id}`,
        sub: r.status_name || null,
        /* A PILL, separate from `sub`, because it is a different kind of fact:
           `sub` describes the record, this says who is answerable for it. The
           tone is the renderer's business — it gets 'warn' or nothing, never a
           colour, so a theme change does not have to come back through here. */
        pill: r.assigned_to_name
          ? { text: r.assigned_to_name }
          : { text: 'Unassigned', tone: 'warn' },
      }]));
    },
  },

  /* routes/appointments.routes.js:
       canView = [requireAuth,
         requirePermissionOrHub('VIEW_APPOINTMENT','CREATE_APPOINTMENT','EDIT_APPOINTMENT'),
         maskCustomerContact]
     The mask is the third item and it masks the keys `mobile`/`whatsapp`. This
     resolver selects neither, so there is nothing for it to have masked. */
  appointment: {
    codes: ['VIEW_APPOINTMENT', 'CREATE_APPOINTMENT', 'EDIT_APPOINTMENT'],
    href: (row) => (row.token ? `/appointments/${row.token}` : null),
    noun: 'appointment',
    async load(ids) {
      const { rows } = await pool.query(
        `SELECT a.id,
                a.public_token AS token,
                NULLIF(BTRIM(COALESCE(a.appointment_code, '')), '') AS code,
                a.vehicle_number,
                a.scheduled_date::text AS on_date
           FROM appointments a
          WHERE a.id = ANY($1::int[])`,
        [ids]
      );
      return new Map(rows.map((r) => [r.id, {
        token: r.token,
        label: r.code || `Appointment #${r.id}`,
        sub: [r.vehicle_number, r.on_date].filter(Boolean).join(' · ') || null,
      }]));
    },
  },

  /* routes/job_cards.routes.js:
       canView = [requireAuth,
         requirePermissionOrHub('VIEW_APPOINTMENT','EDIT_APPOINTMENT','CREATE_APPOINTMENT')]
       router.get('/:id', canView, c.getJobCard)
     Appointment permissions, not a job-card-specific set — a job card is a visit
     and the routes treat it as one. Copied from that file rather than assumed;
     had I guessed I would have invented VIEW_JOB_CARD, which does not exist. */
  job_card: {
    /* The ONLY type not routed by a token — and not by its own id either.
       App.jsx mounts it at /job-cards/:appointmentId, so the link needs the
       card's APPOINTMENT. `/job-cards/<card id>` looks right and opens the wrong
       card, or none. */
    codes: ['VIEW_APPOINTMENT', 'EDIT_APPOINTMENT', 'CREATE_APPOINTMENT'],
    href: (row) => (row.appointment_id ? `/job-cards/${row.appointment_id}` : null),
    noun: 'job card',
    async load(ids) {
      const { rows } = await pool.query(
        `SELECT jc.id,
                jc.appointment_id,
                NULLIF(BTRIM(COALESCE(jc.job_card_no, '')), '') AS no,
                jc.status,
                a.vehicle_number
           FROM job_cards jc
           LEFT JOIN appointments a ON a.id = jc.appointment_id
          WHERE jc.id = ANY($1::int[])`,
        [ids]
      );
      return new Map(rows.map((r) => [r.id, {
        appointment_id: r.appointment_id,
        label: r.no || `Job card #${r.id}`,
        sub: [r.vehicle_number, r.status ? String(r.status).replace(/_/g, ' ') : null]
               .filter(Boolean).join(' · ') || null,
      }]));
    },
  },

  /* routes/estimates.routes.js:
       canView = requirePermissionOrHub('VIEW_ESTIMATE','CREATE_ESTIMATE',
                   'EDIT_ESTIMATE','SUBMIT_ESTIMATE','EXECUTE_ESTIMATE')
     Five codes, and all five are on that one line. SUBMIT_ESTIMATE and
     EXECUTE_ESTIMATE are easy to leave out because they read like write
     permissions; on this route they grant viewing too, and omitting them would
     have shown "no access" to somebody the Estimates page lets straight in. */
  estimate: {
    codes: ['VIEW_ESTIMATE', 'CREATE_ESTIMATE', 'EDIT_ESTIMATE', 'SUBMIT_ESTIMATE', 'EXECUTE_ESTIMATE'],
    href: (row) => (row.token ? `/estimates/${row.token}` : null),
    noun: 'estimate',
    async load(ids) {
      const { rows } = await pool.query(
        `SELECT e.id, e.public_token AS token, e.status, a.vehicle_number
           FROM estimates e
           LEFT JOIN appointments a ON a.id = e.appointment_id
          WHERE e.id = ANY($1::int[])`,
        [ids]
      );
      return new Map(rows.map((r) => [r.id, {
        token: r.token,
        label: `EST-${pad6(r.id)}`,
        sub: [r.vehicle_number, r.status].filter(Boolean).join(' · ') || null,
      }]));
    },
  },

  /* routes/customer_invoices.routes.js:
       canView = requirePermissionOrHub('VIEW_INVOICE','CREATE_INVOICE',
                   'EDIT_INVOICE','ADD_INVOICE_PAYMENT')
     ADD_INVOICE_PAYMENT is in there because somebody taking a payment has to be
     able to open the invoice. */
  customer_invoice: {
    codes: ['VIEW_INVOICE', 'CREATE_INVOICE', 'EDIT_INVOICE', 'ADD_INVOICE_PAYMENT'],
    href: (row) => (row.token ? `/customer-invoices/${row.token}` : null),
    noun: 'customer invoice',
    async load(ids) {
      const { rows } = await pool.query(
        `SELECT ci.id, ci.public_token AS token, ci.status, a.vehicle_number
           FROM customer_invoices ci
           LEFT JOIN appointments a ON a.id = ci.appointment_id
          WHERE ci.id = ANY($1::int[])`,
        [ids]
      );
      return new Map(rows.map((r) => [r.id, {
        token: r.token,
        label: `CI-${pad6(r.id)}`,
        sub: [r.vehicle_number, r.status].filter(Boolean).join(' · ') || null,
      }]));
    },
  },

  /* routes/purchase_invoices.routes.js:
       canView = requirePermissionOrHub('VIEW_HUB','MANAGE_HUBS','VIEW_INVOICE',
                   'VIEW_PURCHASE_INVOICE')
     A different list from the customer invoice, and deliberately so on that
     route: a purchase invoice is what the workshop bills US, so it carries the
     hub relationship and VIEW_HUB/MANAGE_HUBS grant it. Reusing the customer
     invoice's list here would have shown a PI to somebody holding only
     ADD_INVOICE_PAYMENT, which that route does not allow. */
  purchase_invoice: {
    codes: ['VIEW_HUB', 'MANAGE_HUBS', 'VIEW_INVOICE', 'VIEW_PURCHASE_INVOICE'],
    href: (row) => (row.token ? `/purchase-invoices/${row.token}` : null),
    noun: 'purchase invoice',
    async load(ids) {
      const { rows } = await pool.query(
        `SELECT pi.id,
                pi.public_token AS token,
                NULLIF(BTRIM(COALESCE(pi.invoice_number, '')), '') AS no,
                pi.status,
                h.hub_name
           FROM purchase_invoices pi
           LEFT JOIN hubs h ON h.id = pi.hub_id
          WHERE pi.id = ANY($1::int[])`,
        [ids]
      );
      return new Map(rows.map((r) => [r.id, {
        token: r.token,
        label: r.no || `PI-${pad6(r.id)}`,
        sub: [r.hub_name, r.status].filter(Boolean).join(' · ') || null,
      }]));
    },
  },
};

const REF_TYPES = Object.freeze(Object.keys(RESOLVERS));

/**
 * Resolve a batch of pointers for one viewer.
 *
 * Every returned entry is one of exactly three shapes, and the difference
 * matters to the person reading the thread:
 *
 *   { allowed: false }                      you may not see this one
 *   { allowed: true, exists: false }        it is gone
 *   { allowed: true, exists: true, label, sub, href, noun }
 *
 * ── allowed:false carries NO label, and not a shortened one ──
 * The key is absent, not empty. A truncated label is still a label, and
 * "Swift…" tells somebody which car. test18 asserts the key is not present in
 * the response at all rather than asserting it is falsy.
 *
 * ── The order: permission FIRST, then the database ──
 * A type the user cannot see is refused without its load() ever running, so a
 * request for fifty leads from somebody holding no lead permission costs zero
 * queries. It also means there is no path where a label is fetched and then
 * discarded — the safest way to not leak a string is to never have it.
 *
 * @param {object} user   req.user
 * @param {object} req    needed by the lead resolver for scopeConditions
 * @param {Array<{ref_type: string, ref_id: number}>} refs  already filtered to
 *        refs genuinely shared with this user — see chat.refs.controller.js
 */
async function resolveRefs(user, req, refs) {
  const out = new Map();                       // "type:id" -> entry
  const key = (t, i) => `${t}:${i}`;

  // Group by type, so each type's load() runs once.
  const byType = new Map();
  for (const r of refs) {
    const t = r.ref_type;
    const id = Number(r.ref_id);
    if (!RESOLVERS[t] || !Number.isInteger(id) || id < 1) continue;   // unknown type: silently absent
    if (!byType.has(t)) byType.set(t, new Set());
    byType.get(t).add(id);
  }

  for (const [type, idSet] of byType) {
    const R = RESOLVERS[type];
    const ids = [...idSet];

    // Permission first. No query runs for a type this user cannot see.
    if (!holds(user, R.codes)) {
      for (const id of ids) out.set(key(type, id), { ref_type: type, ref_id: id, allowed: false });
      continue;
    }

    let found;
    try {
      found = await R.load(ids, req);
    } catch (err) {
      /* A resolver that throws must not be read as "you may see this, it is
         just missing" — that is the one wrong answer available here. Report it
         as not allowed and log it, so a broken resolver is quiet on screen and
         loud in the log. */
      console.error(`[chatRefs] ${type} resolver failed:`, err.message);
      for (const id of ids) out.set(key(type, id), { ref_type: type, ref_id: id, allowed: false });
      continue;
    }

    for (const id of ids) {
      const hit = found.get(id);
      if (!hit) {
        /* Either deleted, or excluded by a row-scope rule inside load() — the
           lead resolver is the one that does that. The two are reported the
           same way ON PURPOSE for that type: a lead outside your scope and a
           lead that never existed are the same fact from where you are
           standing, which is what getLead's own 404 already says. */
        out.set(key(type, id), {
          ref_type: type, ref_id: id, allowed: true, exists: false, noun: R.noun,
        });
        continue;
      }
      /* href can be null, and that is a real state rather than an error: a
         record whose public_token has not been generated yet has no URL to send
         anybody to. The chip then names it without being clickable, which is
         better than a link that 404s — and far better than hiding a record the
         reader is entitled to see because we could not build a URL for it. */
      const href = R.href(hit) || null;
      out.set(key(type, id), {
        ref_type: type, ref_id: id,
        allowed: true, exists: true,
        label: hit.label,
        sub: hit.sub || null,
        /* Only the types that set one. Absent rather than null, so a chip can
           test for its presence without a special case for "null means no". */
        ...(hit.pill ? { pill: hit.pill } : {}),
        ...(href ? { href } : {}),
        noun: R.noun,
      });
    }
  }

  /* Anything the caller asked about that produced no entry — an unknown type, a
     non-integer id — comes back not allowed rather than missing from the
     response, so the client never has to guess what an absent key meant. */
  for (const r of refs) {
    const k = key(r.ref_type, Number(r.ref_id));
    if (!out.has(k)) {
      out.set(k, { ref_type: r.ref_type, ref_id: r.ref_id, allowed: false });
    }
  }

  return [...out.values()];
}

module.exports = { resolveRefs, REF_TYPES, RESOLVERS, holds };
