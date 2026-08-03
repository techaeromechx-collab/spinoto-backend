'use strict';

/**
 * v1 master-data API — read-only, key-authenticated.
 *
 * WHY THIS IS NOT JUST THE EXISTING ROUTES
 * /api/services and friends exist to serve our own frontend. Their shapes
 * change whenever the UI needs them to, and that is fine while the only
 * consumer ships in the same deploy. The moment an outside system depends on
 * one, every frontend refactor becomes someone else's outage. /v1/ is a
 * contract we version deliberately.
 *
 * EVERY COLUMN IS LISTED BY HAND. No SELECT *, ever.
 * The schema carries hub_rate, commission and commission_percent — what the
 * business PAYS, not what a customer is charged. Publishing any of them hands
 * a partner the margin on every job. A whitelist fails closed when a column is
 * added later; a SELECT * silently publishes it. See utils/apiScopes
 * FORBIDDEN_RESPONSE_FIELDS and the test that enforces it.
 */

const { pool } = require('../config/db');
const { lookupPrice } = require('./pricing.controller');

// ── Pagination ─────────────────────────────────────────────────────────────
// A hard ceiling, not just a default: an unbounded list is how a well-meaning
// integration pulls the whole catalogue every minute. 500 max, 100 default.
const MAX_PER_PAGE = 500;
const DEF_PER_PAGE = 100;

function paging(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, parseInt(req.query.per_page, 10) || DEF_PER_PAGE));
  return { page, perPage, offset: (page - 1) * perPage };
}

/**
 * `?updated_since=2026-07-01` → only rows changed since.
 *
 * The point is that a partner syncs deltas instead of re-downloading the
 * catalogue on a timer. Returns null for anything unparseable rather than
 * throwing, so a malformed value degrades to "everything" instead of a 500.
 *
 * Supported only where the table actually has an updated_at: `parts` and
 * `discount_master`. `services`, `service_categories`, the vehicle master and
 * `hubs` do not have one, and the parameter is silently ignored there rather
 * than faked — a client filtering on a column that doesn't exist would either
 * get a 500 or, worse, quietly receive everything while believing it had a
 * delta.
 */
function updatedSince(req) {
  const raw = req.query.updated_since;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d) ? null : d.toISOString();
}

/** One shape for every list response, so a client writes its pager once. */
function sendList(res, rows, total, { page, perPage }) {
  res.json({
    data: rows,
    page,
    per_page: perPage,
    total,
    has_more: page * perPage < total,
  });
}

function handle(res, next, fn) {
  Promise.resolve(fn()).catch(err => {
    if (err && err.code === '42P01') {
      return res.status(503).json({ error: 'Database is behind the code — run npm run db:migrate.', code: 'MIGRATION_PENDING' });
    }
    next(err);
  });
}

/**
 * Build "WHERE is_active AND updated_at >= $n" consistently.
 * `activeOnly` defaults ON: a partner quoting from a service you retired is
 * worse than one missing a service you just added.
 */
function filters(req, { updatedCol }) {
  const where = [];
  const params = [];
  if (req.query.include_inactive !== 'true') where.push('is_active = TRUE');
  const since = updatedSince(req);
  if (since && updatedCol) {
    params.push(since);
    where.push(`${updatedCol} >= $${params.length}`);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

// ── Services ───────────────────────────────────────────────────────────────

function listServices(req, res, next) {
  handle(res, next, async () => {
    const { page, perPage, offset } = paging(req);
    // updatedCol is null on purpose: `services` has no updated_at column
    // (verified against the migrations, not assumed). Passing one here would
    // make ?updated_since= raise 42703 instead of being ignored. Only `parts`
    // and `discount_master` carry the column, so only they support deltas.
    const { clause, params } = filters(req, { updatedCol: null });
    const where = clause.replace(/is_active/g, 's.is_active');

    const [items, count] = await Promise.all([
      pool.query(
        `SELECT s.id, s.name, s.description,
                s.category_id, sc.name AS category_name,
                s.vehicle_class, s.sac_code, s.gst_percent,
                s.customer_rate AS rate, s.is_active
           FROM services s
           LEFT JOIN service_categories sc ON sc.id = s.category_id
           ${where}
          ORDER BY s.id
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, perPage, offset]
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM services s ${where}`, params),
    ]);
    sendList(res, items.rows, count.rows[0].n, { page, perPage });
  });
}

function listCategories(req, res, next) {
  handle(res, next, async () => {
    const { page, perPage, offset } = paging(req);
    const { clause, params } = filters(req, { updatedCol: null });
    const [items, count] = await Promise.all([
      pool.query(
        // pricing_config is included on purpose: it tells a client which
        // vehicle dimensions a category prices on, so it knows what to send
        // to /price. It is a UI hint here too, never a lookup rule.
        `SELECT id, name, vehicle_class, pricing_config, is_active
           FROM service_categories ${clause}
          ORDER BY id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, perPage, offset]
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM service_categories ${clause}`, params),
    ]);
    sendList(res, items.rows, count.rows[0].n, { page, perPage });
  });
}

// ── Parts ──────────────────────────────────────────────────────────────────

function listParts(req, res, next) {
  handle(res, next, async () => {
    const { page, perPage, offset } = paging(req);
    const { clause, params } = filters(req, { updatedCol: 'updated_at' });
    const [items, count] = await Promise.all([
      pool.query(
        `SELECT id, name, category, vehicle_type, is_active, updated_at
           FROM parts ${clause}
          ORDER BY id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, perPage, offset]
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM parts ${clause}`, params),
    ]);
    sendList(res, items.rows, count.rows[0].n, { page, perPage });
  });
}

// ── Vehicle master ─────────────────────────────────────────────────────────
// One handler, five tables. They are all id/name lookups and diverging them
// would just be five copies of the same twelve lines.

// Table and column names verified against the live controllers, not guessed —
// the vehicle master uses `segments` (not vehicle_segments) and cc_categories
// stores min_cc/max_cc (not cc_from/cc_to).
const VEHICLE_SETS = {
  types:           { table: 'vehicle_types',  cols: 'id, name, is_active' },
  makes:           { table: 'vehicle_makes',  cols: 'id, name, vehicle_type_id, is_active' },
  models:          { table: 'vehicle_models', cols: 'id, name, make_id, body_type_id, is_active' },
  'body-types':    { table: 'body_types',     cols: 'id, name, is_active' },
  segments:        { table: 'segments',       cols: 'id, name, is_active' },
  'cc-categories': { table: 'cc_categories',  cols: 'id, name, min_cc, max_cc, description' },
};

function listVehicleSet(req, res, next) {
  const set = VEHICLE_SETS[req.params.set];
  if (!set) {
    return res.status(404).json({
      error: `Unknown vehicle set '${req.params.set}'`,
      available: Object.keys(VEHICLE_SETS),
    });
  }
  handle(res, next, async () => {
    const { page, perPage, offset } = paging(req);
    const { clause, params } = filters(req, { updatedCol: null });
    const [items, count] = await Promise.all([
      pool.query(
        `SELECT ${set.cols} FROM ${set.table} ${clause}
          ORDER BY id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, perPage, offset]
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM ${set.table} ${clause}`, params),
    ]);
    sendList(res, items.rows, count.rows[0].n, { page, perPage });
  });
}

// ── Discounts ──────────────────────────────────────────────────────────────

function listDiscounts(req, res, next) {
  handle(res, next, async () => {
    const { page, perPage, offset } = paging(req);
    const { clause, params } = filters(req, { updatedCol: null });
    const [items, count] = await Promise.all([
      pool.query(
        // ::text on the dates for the same reason migration 099 uses it:
        // pg-types parses DATE into a JS Date at LOCAL midnight, and
        // toISOString() then reports the previous day on an IST server.
        `SELECT id, name, discount_type, discount_value, applies_to, ref_id,
                valid_from::text AS valid_from, valid_until::text AS valid_until,
                is_active
           FROM discount_master ${clause}
          ORDER BY id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, perPage, offset]
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM discount_master ${clause}`, params),
    ]);
    sendList(res, items.rows, count.rows[0].n, { page, perPage });
  });
}

// ── Hubs ───────────────────────────────────────────────────────────────────

function listHubs(req, res, next) {
  handle(res, next, async () => {
    const { page, perPage, offset } = paging(req);
    const { clause, params } = filters(req, { updatedCol: null });
    const where = clause.replace(/is_active/g, 'h.is_active');
    const [items, count] = await Promise.all([
      pool.query(
        // Name and location only. NOT person_name, contact_number, rm_user_id
        // or notes: those are internal operational contacts, and a partner
        // listing service locations has no business with them.
        `SELECT h.id, h.hub_name AS name, s.name AS state, c.name AS city, a.name AS area, h.is_active
           FROM hubs h
           LEFT JOIN states s ON s.id = h.state_id
           LEFT JOIN cities c ON c.id = h.city_id
           LEFT JOIN areas  a ON a.id = h.area_id
           ${where}
          ORDER BY h.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, perPage, offset]
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM hubs h ${where}`, params),
    ]);
    sendList(res, items.rows, count.rows[0].n, { page, perPage });
  });
}

// ── Price ──────────────────────────────────────────────────────────────────

/**
 * Resolved price for one service on one vehicle.
 *
 * Delegates straight to the existing pricing controller rather than exposing
 * the `pricing` table. That table is a rule set, not a price list: the answer
 * comes from scoring every matching rule for specificity (model 64, make 32,
 * segment 9, body_type 8, cc 8, vehicle_type 4, universal 0) and taking the
 * highest, with a category-level fallback when no service rule matches.
 *
 * Hand a partner the raw rules and they must reimplement that scoring. When
 * they get it subtly wrong their quote disagrees with our invoice, and the
 * customer is standing at the counter arguing about it. One resolver, one
 * answer — and when we change a rule their prices follow automatically.
 */
function getPrice(req, res, next) {
  if (!req.query.service_id && !req.query.category_id) {
    return res.status(400).json({
      error: 'service_id or category_id is required',
      hint: 'Pass the vehicle you are quoting for too — make_id, model_id, body_type_id, segment_id, cc_category_id, vehicle_type_id — or you will get the universal rule rather than the price this customer would actually be charged.',
    });
  }
  return lookupPrice(req, res, next);
}

module.exports = {
  listServices, listCategories, listParts, listVehicleSet,
  listDiscounts, listHubs, getPrice,
  MAX_PER_PAGE, DEF_PER_PAGE, VEHICLE_SETS,
};
