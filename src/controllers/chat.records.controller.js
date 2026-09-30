'use strict';

/**
 * chat.records.controller.js — the record picker behind the composer's "+".
 *
 * ══ THE ONE THING THAT MATTERS HERE ════════════════════════════════════════
 *
 * This is a NEW WAY TO LOOK AT RECORDS, and it would be a very convenient one:
 * type "GJ01" and see every estimate in the business. So it applies exactly the
 * same permission list per type that services/chatRefs.service.js applies when
 * it decides whether a shared record may be NAMED to somebody — imported from
 * there rather than restated, so the two cannot drift.
 *
 * A type the caller cannot see returns an EMPTY LIST, not a filtered one, and
 * runs no query at all. A type with no resolver is not searchable, because a
 * type with no resolver has no access rule anybody has checked.
 *
 * Leads additionally carry row scoping (VIEW_OWN_LEADS sees only their own),
 * through the same utils/leadScope.js the resolver and the Leads page use.
 *
 * ══ WHAT IT RETURNS ════════════════════════════════════════════════════════
 *
 * The same shape the chip renders — label, sub, the kind — so the picker and the
 * message that results look like the same thing. And no phone numbers, for the
 * reason chatRefs.service.js gives at length.
 */

const { pool } = require('../config/db');
const { RESOLVERS, holds } = require('../services/chatRefs.service');
const { scopeConditions, teamIdsIfNeeded } = require('../utils/leadScope');
const { MIN_SEARCH_LENGTH } = require('../utils/listSearch');
const { toNational } = require('../utils/phone');

/* ── A BLANK BOX IS A BROWSE, NOT A FAILED SEARCH ───────────────────────────
 *
 * Opening the picker used to print "Nothing matches that." on every tab: the box
 * starts empty, an empty term matched nothing, and the six tabs therefore all
 * looked broken. But the record you want to attach is very often the one you
 * were just looking at, so an empty term now lists the MOST RECENT records of
 * that kind — the same rows, in the same `id DESC` order, that the record's own
 * page puts at the top, behind the same permission check and (for leads) the
 * same row scoping. A term filters that list; it does not switch on some other
 * feature with a different rule. */

/* ── Searching BY a number, without ever showing one ────────────────────────
 *
 * A customer rings, you have their number on the screen in front of you, and the
 * fastest way to their record is to type it. So the number is a LOOKUP KEY here.
 *
 * It is still never a RESULT. Typing a number you already have discloses
 * nothing; a list that prints numbers back discloses one per row, and
 * utils/maskMobile.js cannot mask a number inside a label string — the reason
 * chatRefs.service.js keeps them out of every chip. Both halves hold: you may
 * search by it, you will not be shown it.
 *
 * ── Why six digits ──
 * `toNational` only accepts a whole valid Indian mobile, which is the common
 * case (a pasted +91…, a 10-digit number). A PARTIAL number is still useful —
 * the last few digits are what people remember — but a two-digit one would sweep
 * every lead beginning 99 and hand back their names, which is a disclosure by
 * prefix. Six is long enough to be a lookup and not a sweep.
 *
 * Matching is on the DIGITS of the stored value, so 9876543210,
 * +91 98765 43210 and 098765-43210 all find each other whatever shape the row
 * happens to be in. */
const MIN_DIGITS = 6;

function numberKey(q) {
  const digits = String(q).replace(/\D/g, '');
  if (!digits) return null;
  /* A whole valid number normalises to its national form; anything shorter is
     used as a suffix. Either way the comparison below is on digits only. */
  const national = toNational(q);
  if (national) return national;
  return digits.length >= MIN_DIGITS ? digits : null;
}

/* The stored value with every non-digit removed, so a search does not depend on
   how somebody typed it in three years ago. */
const DIGITS = (col) => `REGEXP_REPLACE(COALESCE(${col},''), '[^0-9]', '', 'g')`;

/**
 * Does this column hold that number?
 *
 * A SUFFIX match on digits, one direction only, and that is enough because the
 * KEY is normalised before it gets here: numberKey() reduces a whole Indian
 * mobile to its 10-digit national form whatever shape it arrived in, so
 * 9712301573, +919712301573, 00919712301573 and 09712301573 are all the same
 * key, and a row stored in any of those shapes ends with it.
 *
 * ── A DEAD END, RECORDED SO IT IS NOT RE-TRIED ──
 * I added the reverse direction too (`key LIKE '%' || DIGITS(col)`), reasoning
 * that a bare stored number could not be found by a pasted +91 one. That is not
 * true — normalisation has already happened — and test20 §3e is the proof: five
 * stored shapes against six typed ones, every one green with the suffix match
 * alone. It was not free either. Matching in reverse makes a row carrying a junk
 * short number ('1573') match every search ending in those digits, which is the
 * disclosure-by-suffix that MIN_DIGITS exists to prevent. So: one direction.
 *
 * A row with no number at all reduces to '' and `'' LIKE '%<key>'` is false, so
 * numberless records simply do not match — no guard needed for that.
 */
const NUM_MATCH = (col, key) => `(${DIGITS(col)} LIKE '%' || ${key})`;

/**
 * "EST-000412" → 412, for the id match on a document whose number IS its id.
 *
 * Two things this must NOT do.
 *
 * It must not overflow: the moment number search arrived, typing a 10-digit
 * mobile into the Estimates tab sent 9876543210 at an `$n::int` and the query
 * died with "out of range for type integer". A phone number is not a document
 * id, and anything that large is certainly not one — so it is capped at INTEGER
 * range rather than merely parsed.
 *
 * And it must not read a number out of a number plate: stripping non-digits from
 * "GJ01AB1234" gives 011234, which would silently offer estimate #11234 to
 * somebody searching for a car. So the shape is required, not salvaged — bare
 * digits, or a short letter prefix with a separator after it (EST-000412,
 * "CI 66"). "GJ01" matches neither and yields nothing.
 */
const INT_MAX = 2147483647;
const DOC_NUMBER = /^(?:[A-Za-z]{2,4}[-\s])?0*(\d{1,10})$/;
function docId(q) {
  const m = DOC_NUMBER.exec(String(q).trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 && n <= INT_MAX ? n : null;
}

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(next);
}

/* One search per type. Each names the columns a person would actually type:
   the document's code, the plate, the customer's name. A phone number is a key
   (above), never a result.

   Every one of them assembles its WHERE rather than hard-coding it, because an
   empty `q` has to mean "no filter" — see the browse note at the top. The LIMIT
   is always the last parameter pushed, so `$${params.length}` is right whether
   or not the term clauses are there. */
const SEARCHES = {
  lead: async (q, limit, req) => {
    const params = [];
    /* Scope first, so its placeholders are $1.. and the term's follow. */
    const scope = scopeConditions(req.user, await teamIdsIfNeeded(req.user), params);
    const conds = [];
    if (q) {
      /* The raw term is passed as its own parameter rather than stripped back
         out of the LIKE pattern — an earlier version did that with
         `BTRIM(BOTH '%' FROM $n)`, which is TRIM's syntax and not BTRIM's, and
         the whole lead search 500'd. Two parameters is clearer than one clever
         one. */
      params.push(`%${q}%`);
      const like = `$${params.length}`;
      params.push(q);
      const exact = `$${params.length}`;
      params.push(numberKey(q));
      const nk = `$${params.length}`;
      conds.push(`(l.name ILIKE ${like}
                   OR CAST(l.id AS TEXT) = ${exact}
                   OR (${nk}::text IS NOT NULL AND (
                         ${NUM_MATCH('l.mobile', nk)} OR ${NUM_MATCH('l.whatsapp', nk)})))`);
    }
    const all = [...conds, ...scope];
    params.push(limit);
    const { rows } = await pool.query(
      /* l.status, not a join: leads carry their status as plain text. */
      `SELECT l.id, l.public_token AS token,
              NULLIF(BTRIM(COALESCE(l.name,'')),'') AS name,
              l.status AS status_name
         FROM leads l
        ${all.length ? `WHERE ${all.join(' AND ')}` : ''}
        ORDER BY l.id DESC LIMIT $${params.length}`,
      params
    );
    return rows.map((r) => ({
      ref_id: r.id, label: r.name || `Lead #${r.id}`, sub: r.status_name || null,
    }));
  },

  appointment: async (q, limit) => {
    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q}%`, numberKey(q));
      /* customer_name is searched here and on the three types below. It was
         missing, and it is the most natural thing to type — somebody asks about
         "the Mehta job", not about APT-0007. */
      where = `WHERE a.appointment_code ILIKE $1
                  OR a.vehicle_number ILIKE $1
                  OR a.customer_name ILIKE $1
                  OR ($2::text IS NOT NULL AND (
                        ${NUM_MATCH('a.mobile', '$2')} OR ${NUM_MATCH('a.whatsapp', '$2')}))`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT a.id, a.appointment_code AS code, a.vehicle_number,
              a.customer_name, a.scheduled_date::text AS on_date
         FROM appointments a
        ${where}
        ORDER BY a.id DESC LIMIT $${params.length}`,
      params
    );
    return rows.map((r) => ({
      ref_id: r.id,
      label: r.code || `Appointment #${r.id}`,
      sub: [r.customer_name, r.vehicle_number, r.on_date].filter(Boolean).join(' · ') || null,
    }));
  },

  job_card: async (q, limit) => {
    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q}%`, numberKey(q));
      where = `WHERE jc.job_card_no ILIKE $1
                  OR a.vehicle_number ILIKE $1
                  OR a.customer_name ILIKE $1
                  OR ($2::text IS NOT NULL AND ${NUM_MATCH('a.mobile', '$2')})`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      /* customer_name is SELECTed, not only searched: the sub-line below reads
         it, and a column that is filtered on but never returned silently
         produces `undefined` and an empty sub. */
      `SELECT jc.id, jc.job_card_no AS no, jc.status,
              a.vehicle_number, a.customer_name
         FROM job_cards jc
         LEFT JOIN appointments a ON a.id = jc.appointment_id
        ${where}
        ORDER BY jc.id DESC LIMIT $${params.length}`,
      params
    );
    return rows.map((r) => ({
      ref_id: r.id,
      label: r.no || `Job card #${r.id}`,
      sub: [r.customer_name, r.vehicle_number,
            r.status ? String(r.status).replace(/_/g, ' ') : null]
             .filter(Boolean).join(' · ') || null,
    }));
  },

  /* EST-000412 is computed from the id, not stored, so the number a person types
     has to be matched against the id with its padding stripped — otherwise the
     one string they can read off the screen finds nothing. */
  estimate: async (q, limit) => {
    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q}%`, docId(q), numberKey(q));
      where = `WHERE ($2::int IS NOT NULL AND e.id = $2)
                  OR a.vehicle_number ILIKE $1
                  OR a.customer_name ILIKE $1
                  OR ($3::text IS NOT NULL AND ${NUM_MATCH('a.mobile', '$3')})`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT e.id, e.public_token AS token, e.status,
              a.vehicle_number, a.customer_name
         FROM estimates e
         LEFT JOIN appointments a ON a.id = e.appointment_id
        ${where}
        ORDER BY e.id DESC LIMIT $${params.length}`,
      params
    );
    return rows.map((r) => ({
      ref_id: r.id,
      label: `EST-${String(r.id).padStart(6, '0')}`,
      sub: [r.customer_name, r.vehicle_number, r.status].filter(Boolean).join(' · ') || null,
    }));
  },

  customer_invoice: async (q, limit) => {
    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q}%`, docId(q), numberKey(q));
      where = `WHERE ($2::int IS NOT NULL AND ci.id = $2)
                  OR a.vehicle_number ILIKE $1
                  OR a.customer_name ILIKE $1
                  OR ($3::text IS NOT NULL AND ${NUM_MATCH('a.mobile', '$3')})`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT ci.id, ci.status, a.vehicle_number, a.customer_name
         FROM customer_invoices ci
         LEFT JOIN appointments a ON a.id = ci.appointment_id
        ${where}
        ORDER BY ci.id DESC LIMIT $${params.length}`,
      params
    );
    return rows.map((r) => ({
      ref_id: r.id,
      label: `CI-${String(r.id).padStart(6, '0')}`,
      sub: [r.customer_name, r.vehicle_number, r.status].filter(Boolean).join(' · ') || null,
    }));
  },

  /* No customer_name and no number here, and that is not an omission: a purchase
     invoice is raised BY a hub, and carries no customer at all. */
  purchase_invoice: async (q, limit) => {
    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q}%`);
      where = 'WHERE pi.invoice_number ILIKE $1 OR h.hub_name ILIKE $1';
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT pi.id, pi.invoice_number AS no, pi.status, h.hub_name
         FROM purchase_invoices pi
         LEFT JOIN hubs h ON h.id = pi.hub_id
        ${where}
        ORDER BY pi.id DESC LIMIT $${params.length}`,
      params
    );
    return rows.map((r) => ({
      ref_id: r.id,
      label: r.no || `PI-${String(r.id).padStart(6, '0')}`,
      sub: [r.hub_name, r.status].filter(Boolean).join(' · ') || null,
    }));
  },
};

/**
 * GET /api/chat/records/kinds — which kinds THIS user may pick from.
 *
 * So the picker shows four tabs to somebody with four permissions rather than
 * six with two that always come back empty.
 */
function listKinds(req, res) {
  const items = Object.keys(SEARCHES)
    .filter((t) => RESOLVERS[t] && holds(req.user, RESOLVERS[t].codes))
    .map((t) => ({ ref_type: t, noun: RESOLVERS[t].noun }));
  res.json({ items });
}

/** GET /api/chat/records/search?type=estimate&q=GJ01 (q optional — see browse note) */
function search(req, res, next) {
  handle(req, res, next, async () => {
    const type = String(req.query.type || '');
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 15, 1), 30);

    const R = RESOLVERS[type];
    if (!R || !SEARCHES[type]) {
      return res.status(400).json({ error: 'That kind of record cannot be shared' });
    }

    /* Permission FIRST, and no query runs without it. An empty list, not a
       filtered one — there is no shape of this response that says "there are
       results here you may not see", because that is a fact worth having too. */
    if (!holds(req.user, R.codes)) return res.json({ items: [], allowed: false });

    /* The minimum is about a PARTIAL text search — one character matches most of
       the table and is the most expensive query for the least useful result. No
       characters at all is a different thing entirely: it is the browse, and it
       is cheap (`id DESC LIMIT 15` off the primary key). A number that
       normalises to a usable key is already specific enough, whatever its
       length as a string. */
    if (q.length > 0 && q.length < MIN_SEARCH_LENGTH && !numberKey(q)) {
      return res.json({ items: [], allowed: true, too_short: true, min: MIN_SEARCH_LENGTH });
    }

    const items = await SEARCHES[type](q, limit, req);
    res.json({
      items: items.map((i) => ({ ...i, ref_type: type, noun: R.noun })),
      allowed: true,
      /* So the empty state can say "nothing here yet" rather than "nothing
         matches that" when nothing was asked for. */
      browse: q.length === 0,
    });
  });
}

module.exports = { listKinds, search, SEARCHES };
