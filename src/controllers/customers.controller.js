'use strict';

/**
 * Customers controller
 *
 * A "customer" is someone who has at least one Appointment.
 * We group by mobile number from the appointments table.
 * Leads are shown as supplementary context inside the detail view.
 *
 * Endpoints:
 *   GET /api/customers           — paginated list with stats
 *   GET /api/customers/:mobile   — detail: appointments + related leads
 */

const { pool } = require('../config/db');
const { ensureCustomerIdentity } = require('../utils/publicToken');

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch(next);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/customers — Unique customers (grouped by mobile from appointments OR invoices)
// Fix #8: include invoice-only customers; Fix #11: use FIRST name seen not MAX
// ─────────────────────────────────────────────────────────────────────────────
function listCustomers(req, res, next) {
  handle(req, res, next, async () => {
    const search = (req.query.search || '').trim();
    const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const conditions = [];
    const params     = [];

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(
        `(LOWER(COALESCE(src.customer_name,'')) LIKE $${params.length}
          OR src.mobile LIKE $${params.length})`
      );
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Union appointments + invoices + standalone estimates + customer
    // profiles/vehicles so invoice-only customers (#8), customers who only
    // have a standalone estimate, and customers created via the "New
    // Customer" wizard but abandoned before an estimate was ever saved, all
    // still appear.
    // Use FIRST_VALUE (ordered by created_at ASC) for customer_name to avoid arbitrary MAX (#11).
    const sql = `
      WITH src AS (
        SELECT mobile,
               whatsapp,
               customer_name,
               total_price   AS amount,
               NULL          AS inv_total,
               scheduled_date AS activity_date,
               updated_at,
               'appointment' AS src_type
        FROM appointments
        UNION ALL
        SELECT mobile,
               NULL          AS whatsapp,
               customer_name,
               NULL          AS amount,
               total         AS inv_total,
               created_at    AS activity_date,
               updated_at,
               'invoice'     AS src_type
        FROM invoices
        UNION ALL
        SELECT mobile,
               whatsapp,
               customer_name,
               NULL          AS amount,
               NULL          AS inv_total,
               created_at    AS activity_date,
               updated_at,
               'estimate'    AS src_type
        FROM estimates
        WHERE appointment_id IS NULL AND mobile IS NOT NULL
        UNION ALL
        -- A customer_profiles row is created the moment step 1 of the "New
        -- Customer" wizard is saved — this is what makes the customer show
        -- up immediately, even if the estimate is never saved.
        SELECT mobile,
               whatsapp,
               display_name  AS customer_name,
               NULL          AS amount,
               NULL          AS inv_total,
               created_at    AS activity_date,
               updated_at,
               'profile'     AS src_type
        FROM customer_profiles
        WHERE NOT COALESCE(is_deleted, FALSE)
        UNION ALL
        -- Same idea for a vehicle saved in step 2 with no profile/appointment
        -- row yet (defensive — normally the profile row above already covers it).
        SELECT mobile,
               NULL          AS whatsapp,
               NULL          AS customer_name,
               NULL          AS amount,
               NULL          AS inv_total,
               created_at    AS activity_date,
               created_at    AS updated_at,
               'vehicle'     AS src_type
        FROM customer_vehicles
      ),
      agg AS (
        SELECT
          src.mobile,
          -- Earliest non-null whatsapp for this mobile (#11 fix: deterministic pick)
          (SELECT whatsapp FROM (
              SELECT whatsapp, created_at FROM appointments WHERE mobile = src.mobile AND whatsapp IS NOT NULL
              UNION ALL
              SELECT whatsapp, created_at FROM estimates WHERE mobile = src.mobile AND appointment_id IS NULL AND whatsapp IS NOT NULL
            ) wa ORDER BY created_at ASC LIMIT 1)        AS whatsapp,
          -- Earliest non-null name — deterministic, not lexicographic MAX (#11)
          (SELECT customer_name FROM (
              SELECT customer_name, created_at FROM appointments WHERE mobile = src.mobile AND customer_name IS NOT NULL
              UNION ALL
              SELECT customer_name, created_at FROM invoices     WHERE mobile = src.mobile AND customer_name IS NOT NULL
              UNION ALL
              SELECT customer_name, created_at FROM estimates    WHERE mobile = src.mobile AND appointment_id IS NULL AND customer_name IS NOT NULL
            ) named ORDER BY created_at ASC LIMIT 1)    AS customer_name,
          COUNT(DISTINCT CASE WHEN src.src_type='appointment' THEN src.activity_date END)::int
                                                         AS total_appointments,
          COALESCE(SUM(CASE WHEN src.src_type='appointment' THEN src.amount END), 0)
                                                         AS total_spend,
          MAX(CASE WHEN src.src_type='appointment' THEN src.activity_date END)
                                                         AS last_appointment,
          MAX(src.updated_at)                            AS last_activity
        FROM src
        ${where}
        GROUP BY src.mobile
      )
      SELECT
        agg.mobile,
        ci.public_token,
        COALESCE(cp.display_name, agg.customer_name)   AS customer_name,
        COALESCE(cp.whatsapp,     agg.whatsapp)         AS whatsapp,
        cp.email,
        cp.notes                                        AS profile_notes,
        agg.total_appointments,
        agg.total_spend,
        agg.last_appointment,
        agg.last_activity
      FROM agg
      LEFT JOIN customer_profiles cp ON cp.mobile = agg.mobile
      LEFT JOIN customer_identities ci ON ci.mobile = agg.mobile
      WHERE NOT COALESCE(cp.is_deleted, FALSE)
      ORDER BY agg.last_activity DESC NULLS LAST
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    // Simpler count query without the heavy CTE for performance
    const countSqlSimple = `
      SELECT COUNT(DISTINCT src.mobile)::int AS total
      FROM (
        SELECT mobile, customer_name FROM appointments
        UNION ALL
        SELECT mobile, customer_name FROM invoices
        UNION ALL
        SELECT mobile, customer_name FROM estimates WHERE appointment_id IS NULL AND mobile IS NOT NULL
        UNION ALL
        SELECT mobile, display_name AS customer_name FROM customer_profiles WHERE NOT COALESCE(is_deleted, FALSE)
        UNION ALL
        SELECT mobile, NULL AS customer_name FROM customer_vehicles
      ) src
      LEFT JOIN customer_profiles cp ON cp.mobile = src.mobile
      WHERE NOT COALESCE(cp.is_deleted, FALSE)
      ${conditions.length ? 'AND ' + conditions.join(' AND ') : ''}
    `;

    const [dataRes, countRes] = await Promise.all([
      pool.query(sql, [...params, limit, offset]),
      pool.query(countSqlSimple, params),
    ]);

    return res.json({
      items: dataRes.rows,
      total: countRes.rows[0]?.total || 0,
      page,
      limit,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/customers/:mobile — Detail for one customer
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/customers/by-token/:token — resolves a public_token (used in
// shareable /customers/:token URLs) to the customer's mobile number via
// customer_identities, then delegates to the exact same logic as
// GET /api/customers/:mobile. Kept as a thin wrapper — the response still
// includes `mobile`, which is fine since it's authenticated JSON, not a URL.
// ─────────────────────────────────────────────────────────────────────────────
function getCustomerByToken(req, res, next) {
  handle(req, res, next, async () => {
    const r = await pool.query(
      `SELECT mobile FROM customer_identities WHERE public_token = $1`,
      [req.params.token]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Customer not found' });
    req.params.mobile = r.rows[0].mobile;
    return getCustomer(req, res, next);
  });
}

function getCustomer(req, res, next) {
  handle(req, res, next, async () => {
    const mobile = req.params.mobile;

    const [apptsRes, invoicesRes, standaloneEstRes] = await Promise.all([
      pool.query(`
        SELECT
          a.id, a.public_token, a.lead_id, a.customer_name, a.mobile, a.whatsapp,
          a.vehicle_number, a.scheduled_date, a.scheduled_time,
          a.total_price, a.notes, a.cancellation_reason, a.created_at, a.updated_at,
          a.vehicle_type_id, a.make_id, a.model_id,
          ast.name     AS status_name,
          ast.color    AS status_color,
          ast.bg_color AS status_bg,
          h.hub_name,
          vt.name   AS vehicle_type_name,
          mk.name   AS make_name,
          md.name   AS model_name,
          seg.name  AS segment_name,
          bt.name   AS body_type_name,
          COALESCE(
            (SELECT json_agg(json_build_object('name', s.name, 'price', aps.price) ORDER BY aps.id)
               FROM appointment_services aps
               JOIN services s ON s.id = aps.service_id
              WHERE aps.appointment_id = a.id),
            '[]'
          ) AS services
        FROM appointments a
        LEFT JOIN appointment_statuses ast ON ast.id = a.status_id
        LEFT JOIN hubs           h   ON h.id  = a.hub_id
        LEFT JOIN vehicle_types  vt  ON vt.id = a.vehicle_type_id
        LEFT JOIN vehicle_makes  mk  ON mk.id = a.make_id
        LEFT JOIN vehicle_models md  ON md.id = a.model_id
        LEFT JOIN segments       seg ON seg.id = md.segment_id
        LEFT JOIN body_types     bt  ON bt.id  = md.body_type_id
        WHERE a.mobile = $1
        ORDER BY a.scheduled_date DESC, a.id DESC
        LIMIT 50
      `, [mobile]),

      pool.query(`
        SELECT
          ci.id,
          ci.public_token,
          COALESCE(ci.customer_name, a.customer_name) AS customer_name,
          ci.grand_total                              AS total,
          ci.amount_paid,
          (ci.grand_total - ci.amount_paid)           AS outstanding,
          ci.subtotal_ex_gst                          AS subtotal,
          ci.total_gst,
          ci.vehicle_number,
          ci.notes,
          ci.created_at,
          ci.invoice_date::text AS invoice_date,
          ci.status,
          ci.estimate_id,
          est.public_token AS estimate_token,
          ci.is_b2b,
          ci.b2b_company_name,
          ci.b2b_gst_number,
          h.hub_name,
          COALESCE(
            (SELECT json_agg(json_build_object(
                'name',  cii.description,
                'total', cii.total_inc_gst) ORDER BY cii.id)
               FROM customer_invoice_items cii
              WHERE cii.customer_invoice_id = ci.id),
            '[]'
          ) AS services
        FROM customer_invoices ci
        LEFT JOIN hubs         h ON h.id  = ci.hub_id
        LEFT JOIN appointments a ON a.id  = ci.appointment_id
        LEFT JOIN estimates    est ON est.id = ci.estimate_id
        WHERE COALESCE(ci.mobile, a.mobile) = $1
        -- Customer-facing history follows the invoice date, not the keying-in date.
        ORDER BY ci.invoice_date DESC, ci.id DESC
        LIMIT 30
      `, [mobile]),

      // Standalone estimates — no appointment exists yet (or ever will), so
      // this is the only place these customers' vehicle/estimate context
      // lives until a Customer Invoice is eventually generated.
      pool.query(`
        SELECT
          e.id, e.public_token, e.status, e.grand_total, e.notes, e.created_at, e.updated_at,
          e.estimate_date::text AS estimate_date,
          e.original_estimate_date::text AS original_estimate_date,
          e.customer_name, e.mobile, e.whatsapp, e.vehicle_number,
          e.vehicle_type_id, e.make_id, e.model_id,
          h.hub_name,
          vt.name AS vehicle_type_name,
          mk.name AS make_name,
          md.name AS model_name,
          bt.name AS body_type_name,
          cc.name AS cc_category_name
        FROM estimates e
        LEFT JOIN hubs           h  ON h.id  = e.hub_id
        LEFT JOIN vehicle_types  vt ON vt.id = e.vehicle_type_id
        LEFT JOIN vehicle_makes  mk ON mk.id = e.make_id
        LEFT JOIN vehicle_models md ON md.id = e.model_id
        LEFT JOIN body_types     bt ON bt.id = e.body_type_id
        LEFT JOIN cc_categories  cc ON cc.id = e.cc_category_id
        WHERE e.mobile = $1 AND e.appointment_id IS NULL
        ORDER BY e.estimate_date DESC, e.id DESC
        LIMIT 30
      `, [mobile]),

    ]);

    // customer_profiles is optional (table may not exist yet if migration hasn't run)
    let profileRes = { rows: [] };
    try {
      profileRes = await pool.query(
        `SELECT cp.display_name, cp.whatsapp, cp.email, cp.notes,
                cp.state_id, s.name AS state_name,
                cp.city_id,  c.name AS city_name,
                cp.area_id,  a.name AS area_name,
                cp.default_is_b2b, cp.default_b2b_company_name,
                cp.default_b2b_gst_number, cp.default_b2b_address
           FROM customer_profiles cp
           LEFT JOIN states s ON s.id = cp.state_id
           LEFT JOIN cities c ON c.id = cp.city_id
           LEFT JOIN areas  a ON a.id = cp.area_id
          WHERE cp.mobile = $1 AND NOT COALESCE(cp.is_deleted, FALSE)`,
        [mobile]
      );
    } catch (_) { /* table not yet created */ }
    const profile = profileRes.rows[0] || null;

    // customer_identities holds the shareable-URL routing token for this
    // mobile — optional/defensive the same way profile/vehicles are, in
    // case migration 086 hasn't run yet in this environment.
    let publicToken = null;
    try {
      const identRes = await pool.query(
        `SELECT public_token FROM customer_identities WHERE mobile = $1`,
        [mobile]
      );
      publicToken = identRes.rows[0]?.public_token || null;
    } catch (_) { /* table not yet created */ }

    // customer_vehicles is optional (table may not exist yet if migration hasn't run)
    let custVehRes = { rows: [] };
    try {
      custVehRes = await pool.query(`
        SELECT cv.id, cv.mobile, cv.vehicle_number, cv.color, cv.year, cv.notes, cv.created_at,
               vt.id   AS vehicle_type_id,  vt.name AS vehicle_type_name,
               mk.id   AS make_id,          mk.name AS make_name,
               md.id   AS model_id,         md.name AS model_name,
               COALESCE(cv.segment_id, md.segment_id) AS segment_id,
               seg.name AS segment_name,
               bt.id    AS body_type_id,    bt.name  AS body_type_name
          FROM customer_vehicles cv
          LEFT JOIN vehicle_types  vt  ON vt.id  = cv.vehicle_type_id
          LEFT JOIN vehicle_makes  mk  ON mk.id  = cv.make_id
          LEFT JOIN vehicle_models md  ON md.id  = cv.model_id
          LEFT JOIN segments       seg ON seg.id = COALESCE(cv.segment_id, md.segment_id)
          LEFT JOIN body_types     bt  ON bt.id  = md.body_type_id
         WHERE cv.mobile = $1
         ORDER BY cv.created_at DESC
      `, [mobile]);
    } catch (_) { /* table not yet created — gracefully return empty */ }

    // Fix #7: return 404 only when there is truly no trace of this mobile —
    // customer_vehicles alone is enough to keep the profile alive. A
    // standalone estimate (no appointment), or just a saved customer_profiles
    // row (e.g. step 1 of "New Customer" was saved but nothing further),
    // also count as a trace now.
    if (
      apptsRes.rows.length === 0 && invoicesRes.rows.length === 0 &&
      custVehRes.rows.length === 0 && standaloneEstRes.rows.length === 0 &&
      !profile
    ) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const appts     = apptsRes.rows;
    const invoices  = invoicesRes.rows;
    const custVehs  = custVehRes.rows;
    const estimates = standaloneEstRes.rows;

    // Fix #11: use earliest-created name, not arbitrary MAX; profile.display_name takes precedence
    const derivedName = (() => {
      const candidates = [
        ...appts.map(a => ({ name: a.customer_name, ts: a.created_at })),
        ...invoices.map(i => ({ name: i.customer_name, ts: i.created_at })),
        ...estimates.map(e => ({ name: e.customer_name, ts: e.created_at })),
      ].filter(c => c.name).sort((a, b) => new Date(a.ts) - new Date(b.ts));
      return candidates[0]?.name || null;
    })();
    const name     = profile?.display_name || derivedName;
    const whatsapp = profile?.whatsapp || appts.find(a => a.whatsapp)?.whatsapp
      || estimates.find(e => e.whatsapp)?.whatsapp || null;

    // Fix #18: totalSpend uses actual invoiced totals, not appointment estimates
    const totalSpend       = invoices.reduce((s, i) => s + Number(i.total       || 0), 0);
    const totalInvoiced    = totalSpend;
    const totalOutstanding = invoices.reduce((s, i) => s + Number(i.outstanding || 0), 0);
    // avgSpend per appointment visit is still meaningful from appointment prices
    const apptSpend        = appts.reduce((s, a) => s + Number(a.total_price || 0), 0);
    const avgSpend         = appts.length ? Math.round(apptSpend / appts.length) : 0;
    const lastVisit        = appts[0]?.scheduled_date || null;

    // Distinct vehicles keyed by normalised plate
    const vehicleMap = new Map();

    // 1. Seed from manually registered customer_vehicles (source = 'manual')
    for (const cv of custVehs) {
      if (!cv.vehicle_number) continue;
      const key = cv.vehicle_number.toUpperCase().replace(/\s/g, '');
      vehicleMap.set(key, {
        cv_id:             cv.id,
        vehicle_number:    cv.vehicle_number.toUpperCase(),
        vehicle_type_id:   cv.vehicle_type_id,
        vehicle_type_name: cv.vehicle_type_name,
        make_id:           cv.make_id,
        make_name:         cv.make_name,
        model_id:          cv.model_id,
        model_name:        cv.model_name,
        segment_name:      cv.segment_name,
        body_type_name:    cv.body_type_name,
        color:             cv.color,
        year:              cv.year,
        notes:             cv.notes,
        visit_count:       0,
        last_seen:         cv.created_at ? new Date(cv.created_at).toISOString().slice(0, 10) : null,
        source:            'manual',
      });
    }

    // 2. Merge appointment-derived vehicles (enriches details, bumps visit count)
    for (const a of appts) {
      if (!a.vehicle_number) continue;
      const key = a.vehicle_number.toUpperCase().replace(/\s/g, '');
      if (!vehicleMap.has(key)) {
        vehicleMap.set(key, {
          cv_id:             null,
          vehicle_number:    a.vehicle_number,
          vehicle_type_id:   a.vehicle_type_id || null,
          vehicle_type_name: a.vehicle_type_name,
          make_id:           a.make_id || null,
          make_name:         a.make_name,
          model_id:          a.model_id || null,
          model_name:        a.model_name,
          segment_name:      a.segment_name   || null,
          body_type_name:    a.body_type_name || null,
          color:             null,
          year:              null,
          notes:             null,
          visit_count:       1,
          last_seen:         a.scheduled_date,
          source:            'appointment',
        });
      } else {
        const entry = vehicleMap.get(key);
        entry.visit_count++;
        // Fill missing details from appointment
        if (!entry.vehicle_type_id)   entry.vehicle_type_id   = a.vehicle_type_id || null;
        if (!entry.vehicle_type_name) entry.vehicle_type_name = a.vehicle_type_name;
        if (!entry.make_id)           entry.make_id           = a.make_id || null;
        if (!entry.make_name)         entry.make_name         = a.make_name;
        if (!entry.model_id)          entry.model_id          = a.model_id || null;
        if (!entry.model_name)        entry.model_name        = a.model_name;
        if (!entry.segment_name)      entry.segment_name      = a.segment_name   || null;
        if (!entry.body_type_name)    entry.body_type_name    = a.body_type_name || null;
      }
    }

    // 3. Merge invoice-derived vehicles (if not seen yet)
    for (const i of invoices) {
      if (!i.vehicle_number) continue;
      const key = i.vehicle_number.toUpperCase().replace(/\s/g, '');
      if (!vehicleMap.has(key)) {
        vehicleMap.set(key, {
          cv_id:             null,
          vehicle_number:    i.vehicle_number,
          vehicle_type_name: null, make_name: null, model_name: null,
          color:             null, year:       null, notes:      null,
          visit_count:       1,
          last_seen:         i.created_at ? new Date(i.created_at).toISOString().slice(0, 10) : null,
          source:            'invoice',
        });
      }
    }

    // 4. Merge standalone-estimate-derived vehicles (if not seen yet) —
    // these carry the same *_name fields as an appointment would.
    for (const e of estimates) {
      if (!e.vehicle_number) continue;
      const key = e.vehicle_number.toUpperCase().replace(/\s/g, '');
      if (!vehicleMap.has(key)) {
        vehicleMap.set(key, {
          cv_id:             null,
          vehicle_number:    e.vehicle_number,
          vehicle_type_id:   e.vehicle_type_id || null,
          vehicle_type_name: e.vehicle_type_name,
          make_id:           e.make_id || null,
          make_name:         e.make_name,
          model_id:          e.model_id || null,
          model_name:        e.model_name,
          body_type_name:    e.body_type_name || null,
          color:             null, year: null, notes: null,
          visit_count:       1,
          last_seen:         e.created_at ? new Date(e.created_at).toISOString().slice(0, 10) : null,
          source:            'estimate',
        });
      } else {
        const entry = vehicleMap.get(key);
        entry.visit_count++;
        if (!entry.vehicle_type_id)   entry.vehicle_type_id   = e.vehicle_type_id || null;
        if (!entry.vehicle_type_name) entry.vehicle_type_name = e.vehicle_type_name;
        if (!entry.make_id)           entry.make_id           = e.make_id || null;
        if (!entry.make_name)         entry.make_name         = e.make_name;
        if (!entry.model_id)          entry.model_id          = e.model_id || null;
        if (!entry.model_name)        entry.model_name        = e.model_name;
      }
    }

    return res.json({
      item: {
        mobile,
        public_token: publicToken,
        whatsapp,
        email:               profile?.email         || null,
        profile_notes:       profile?.notes         || null,
        default_is_b2b:              profile?.default_is_b2b             || false,
        default_b2b_company_name:    profile?.default_b2b_company_name   || null,
        default_b2b_gst_number:      profile?.default_b2b_gst_number     || null,
        default_b2b_address:         profile?.default_b2b_address        || null,
        customer_name:       name,
        total_appointments:  appts.length,
        total_spend:         totalSpend,
        total_invoiced:      totalInvoiced,
        total_outstanding:   totalOutstanding,
        avg_spend:           avgSpend,
        last_visit:          lastVisit,
        vehicles:            [...vehicleMap.values()],
        appointments:        appts,
        invoices,
        // Standalone estimates (no appointment) — surfaced separately so the
        // customer detail page can show them even before any invoice exists.
        estimates,
      },
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/customers/:mobile/vehicles — list manually-added vehicles
// POST /api/customers/:mobile/vehicles — add a vehicle
// DELETE /api/customers/:mobile/vehicles/:id — remove a vehicle
// ─────────────────────────────────────────────────────────────────────────────

function listCustomerVehicles(req, res, next) {
  handle(req, res, next, async () => {
    const mobile = req.params.mobile;
    const r = await pool.query(`
      -- Manually added vehicles
      SELECT
        cv.id,
        cv.mobile,
        cv.vehicle_number,
        cv.color,
        cv.year,
        cv.notes,
        cv.created_at,
        vt.id   AS vehicle_type_id,  vt.name AS vehicle_type_name,
        mk.id   AS make_id,          mk.name AS make_name,
        md.id   AS model_id,         md.name AS model_name,
        COALESCE(cv.segment_id, md.segment_id) AS segment_id,
        seg.name AS segment_name,
        bt.id   AS body_type_id,     bt.name  AS body_type_name,
        'manual' AS source
      FROM customer_vehicles cv
      LEFT JOIN vehicle_types  vt  ON vt.id  = cv.vehicle_type_id
      LEFT JOIN vehicle_makes  mk  ON mk.id  = cv.make_id
      LEFT JOIN vehicle_models md  ON md.id  = cv.model_id
      LEFT JOIN segments       seg ON seg.id = COALESCE(cv.segment_id, md.segment_id)
      LEFT JOIN body_types     bt  ON bt.id  = md.body_type_id
      WHERE cv.mobile = $1

      UNION

      -- Vehicles from past appointments (lead-converted or otherwise)
      -- Only include if not already present in customer_vehicles for this mobile
      SELECT
        NULL        AS id,
        a.mobile,
        a.vehicle_number,
        NULL        AS color,
        NULL        AS year,
        NULL        AS notes,
        a.created_at,
        vt.id   AS vehicle_type_id,  vt.name AS vehicle_type_name,
        mk.id   AS make_id,          mk.name AS make_name,
        md.id   AS model_id,         md.name AS model_name,
        (a.segment_ids)[1]           AS segment_id,
        seg.name                     AS segment_name,
        bt.id   AS body_type_id,     bt.name  AS body_type_name,
        'appointment' AS source
      FROM appointments a
      LEFT JOIN vehicle_types  vt  ON vt.id  = a.vehicle_type_id
      LEFT JOIN vehicle_makes  mk  ON mk.id  = a.make_id
      LEFT JOIN vehicle_models md  ON md.id  = a.model_id
      LEFT JOIN segments       seg ON seg.id = (a.segment_ids)[1]
      LEFT JOIN body_types     bt  ON bt.id  = a.body_type_id
      WHERE a.mobile = $1
        AND a.vehicle_number IS NOT NULL
        AND a.vehicle_number <> ''
        AND NOT EXISTS (
          SELECT 1 FROM customer_vehicles cv2
          WHERE cv2.mobile = $1
            AND cv2.vehicle_number = a.vehicle_number
        )

      ORDER BY created_at DESC
    `, [mobile]);
    res.json({ items: r.rows });
  });
}

function addCustomerVehicle(req, res, next) {
  handle(req, res, next, async () => {
    const mobile = req.params.mobile;
    const {
      vehicle_number, vehicle_type_id, make_id, model_id,
      color, year, notes, segment_id,
    } = req.body;

    if (!vehicle_number?.trim()) {
      return res.status(400).json({ error: 'Vehicle number is required' });
    }

    const normalised = vehicle_number.trim().toUpperCase();

    // Fix #12: detect conflict explicitly so the caller can decide whether to
    // overwrite — rather than silently clobbering the existing record.
    const existing = await pool.query(
      `SELECT id FROM customer_vehicles WHERE mobile = $1 AND vehicle_number = $2`,
      [mobile, normalised]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: `Vehicle ${normalised} is already registered for this customer.`,
        existing_id: existing.rows[0].id,
      });
    }

    const r = await pool.query(`
      INSERT INTO customer_vehicles
        (mobile, vehicle_number, vehicle_type_id, make_id, model_id, color, year, notes, segment_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING
        id, mobile, vehicle_number, vehicle_type_id, make_id, model_id,
        color, year, notes, segment_id, created_at
    `, [
      mobile,
      normalised,
      vehicle_type_id || null,
      make_id         || null,
      model_id        || null,
      color           || null,
      year            || null,
      notes           || null,
      segment_id      || null,
    ]);

    // Fetch with joins for full response
    const full = await pool.query(`
      SELECT cv.id, cv.mobile, cv.vehicle_number, cv.color, cv.year, cv.notes, cv.created_at,
             vt.id AS vehicle_type_id, vt.name AS vehicle_type_name,
             mk.id AS make_id,         mk.name AS make_name,
             md.id AS model_id,        md.name AS model_name,
             COALESCE(cv.segment_id, md.segment_id) AS segment_id,
             sg.name  AS segment_name,
             bt.id AS body_type_id,    bt.name  AS body_type_name
        FROM customer_vehicles cv
        LEFT JOIN vehicle_types  vt ON vt.id  = cv.vehicle_type_id
        LEFT JOIN vehicle_makes  mk ON mk.id  = cv.make_id
        LEFT JOIN vehicle_models md ON md.id  = cv.model_id
        LEFT JOIN segments       sg ON sg.id  = COALESCE(cv.segment_id, md.segment_id)
        LEFT JOIN body_types     bt ON bt.id  = md.body_type_id
       WHERE cv.id = $1
    `, [r.rows[0].id]);

    res.status(201).json({ item: full.rows[0] });
  });
}

function updateCustomerVehicle(req, res, next) {
  handle(req, res, next, async () => {
    const { mobile, id } = req.params;
    const {
      vehicle_type_id, make_id, model_id, color, year, notes,
      vehicle_number, propagate_vehicle_number,
    } = req.body;

    const existing = await pool.query(
      `SELECT id, vehicle_number FROM customer_vehicles WHERE id = $1 AND mobile = $2`,
      [parseInt(id, 10), mobile]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Vehicle not found' });

    const oldPlate = existing.rows[0].vehicle_number;
    const newPlate = vehicle_number?.trim() ? vehicle_number.trim().toUpperCase() : oldPlate;
    const plateChanged = newPlate !== oldPlate;

    if (plateChanged) {
      const dupe = await pool.query(
        `SELECT id FROM customer_vehicles WHERE mobile = $1 AND vehicle_number = $2 AND id <> $3`,
        [mobile, newPlate, parseInt(id, 10)]
      );
      if (dupe.rows[0]) {
        return res.status(409).json({ error: `Vehicle ${newPlate} is already registered for this customer.` });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE customer_vehicles SET
           vehicle_type_id = $1,
           make_id         = $2,
           model_id        = $3,
           color           = $4,
           year            = $5,
           notes           = $6,
           vehicle_number  = $7
         WHERE id = $8 AND mobile = $9`,
        [
          vehicle_type_id || null,
          make_id         || null,
          model_id        || null,
          color           || null,
          year ? parseInt(year, 10) : null,
          notes           || null,
          newPlate,
          parseInt(id, 10),
          mobile,
        ]
      );

      // Optional cascade: propagate a corrected plate number onto this
      // customer's past appointments/estimates/invoices. Purchase invoices
      // don't store their own vehicle_number — they inherit it live via
      // their linked estimate/appointment — so nothing to update there.
      if (plateChanged && propagate_vehicle_number) {
        await client.query(
          `UPDATE appointments SET vehicle_number = $1 WHERE mobile = $2 AND vehicle_number = $3`,
          [newPlate, mobile, oldPlate]
        );
        await client.query(
          `UPDATE estimates SET vehicle_number = $1 WHERE mobile = $2 AND vehicle_number = $3`,
          [newPlate, mobile, oldPlate]
        );
        await client.query(
          `UPDATE customer_invoices SET vehicle_number = $1 WHERE mobile = $2 AND vehicle_number = $3`,
          [newPlate, mobile, oldPlate]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const full = await pool.query(`
      SELECT cv.id, cv.mobile, cv.vehicle_number, cv.color, cv.year, cv.notes, cv.created_at,
             vt.id AS vehicle_type_id, vt.name AS vehicle_type_name,
             mk.id AS make_id,         mk.name AS make_name,
             md.id AS model_id,        md.name AS model_name,
             COALESCE(cv.segment_id, md.segment_id) AS segment_id,
             seg.name AS segment_name,
             bt.id   AS body_type_id,  bt.name  AS body_type_name
        FROM customer_vehicles cv
        LEFT JOIN vehicle_types  vt  ON vt.id  = cv.vehicle_type_id
        LEFT JOIN vehicle_makes  mk  ON mk.id  = cv.make_id
        LEFT JOIN vehicle_models md  ON md.id  = cv.model_id
        LEFT JOIN segments       seg ON seg.id = COALESCE(cv.segment_id, md.segment_id)
        LEFT JOIN body_types     bt  ON bt.id  = md.body_type_id
       WHERE cv.id = $1
    `, [parseInt(id, 10)]);

    res.json({ item: full.rows[0] });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/customers/:mobile/vehicle-usage?number=PLATE — how many past
// appointments/estimates/invoices reference this exact plate for this
// customer. Used by the Edit Vehicle modal to show what a vehicle-number
// correction would actually touch before offering to propagate it.
// Purchase invoices don't store their own vehicle_number (they inherit it
// live via their linked estimate/appointment), so nothing to count there.
// ─────────────────────────────────────────────────────────────────────────────
function getVehicleUsage(req, res, next) {
  handle(req, res, next, async () => {
    const mobile = req.params.mobile;
    const plate  = (req.query.number || '').trim().toUpperCase();
    if (!plate) return res.status(400).json({ error: 'number query param is required' });

    const [apt, est, ci] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS c FROM appointments WHERE mobile = $1 AND vehicle_number = $2`, [mobile, plate]),
      pool.query(`SELECT COUNT(*)::int AS c FROM estimates WHERE mobile = $1 AND vehicle_number = $2`, [mobile, plate]),
      pool.query(`SELECT COUNT(*)::int AS c FROM customer_invoices WHERE mobile = $1 AND vehicle_number = $2`, [mobile, plate]),
    ]);

    res.json({
      appointments: apt.rows[0].c,
      estimates:    est.rows[0].c,
      invoices:     ci.rows[0].c,
    });
  });
}

function deleteCustomerVehicle(req, res, next) {
  handle(req, res, next, async () => {
    const { mobile, id } = req.params;
    const r = await pool.query(
      `DELETE FROM customer_vehicles WHERE id = $1 AND mobile = $2 RETURNING id`,
      [parseInt(id, 10), mobile]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Vehicle not found' });
    res.status(204).end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/customers/:mobile — upsert customer profile (name, whatsapp, email, notes)
// ─────────────────────────────────────────────────────────────────────────────
function updateCustomer(req, res, next) {
  handle(req, res, next, async () => {
    const mobile = req.params.mobile;
    const {
      display_name, whatsapp, email, notes, state_id, city_id, area_id,
      is_b2b, b2b_company_name, b2b_gst_number, b2b_address,
    } = req.body;

    // Validate B2B fields the same way estimates do — required whenever is_b2b
    // is being turned on. GST number format/checksum validation was
    // intentionally removed per user request; any non-empty value is accepted.
    const isB2b = !!is_b2b;
    if (isB2b) {
      if (!b2b_company_name || !b2b_company_name.trim()) {
        return res.status(400).json({ error: 'Company name is required for a B2B customer.' });
      }
      if (!b2b_address || !b2b_address.trim()) {
        return res.status(400).json({ error: 'Address is required for a B2B customer.' });
      }
      if (!b2b_gst_number || !b2b_gst_number.trim()) {
        return res.status(400).json({ error: 'GST number is required for a B2B customer.' });
      }
    }

    await pool.query(`
      INSERT INTO customer_profiles (
        mobile, display_name, whatsapp, email, notes, state_id, city_id, area_id,
        default_is_b2b, default_b2b_company_name, default_b2b_gst_number, default_b2b_address,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      ON CONFLICT (mobile) DO UPDATE SET
        display_name             = EXCLUDED.display_name,
        whatsapp                 = EXCLUDED.whatsapp,
        email                    = EXCLUDED.email,
        notes                    = EXCLUDED.notes,
        state_id                 = EXCLUDED.state_id,
        city_id                  = EXCLUDED.city_id,
        area_id                  = EXCLUDED.area_id,
        default_is_b2b           = EXCLUDED.default_is_b2b,
        default_b2b_company_name = EXCLUDED.default_b2b_company_name,
        default_b2b_gst_number   = EXCLUDED.default_b2b_gst_number,
        default_b2b_address      = EXCLUDED.default_b2b_address,
        updated_at                = NOW()
    `, [
      mobile,
      display_name?.trim() || null,
      whatsapp?.trim()     || null,
      email?.trim()        || null,
      notes?.trim()        || null,
      state_id             || null,
      city_id              || null,
      area_id              || null,
      isB2b,
      isB2b ? b2b_company_name.trim()          : null,
      isB2b ? b2b_gst_number.trim().toUpperCase() : null,
      isB2b ? b2b_address.trim()               : null,
    ]);

    // Make sure this mobile number has a customer routing identity
    // (public_token) even if it's never appeared on an appointment/estimate.
    await ensureCustomerIdentity(pool, mobile);

    res.json({ ok: true });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/customers/:mobile — soft-delete customer (hides from list)
// Appointment and invoice history is preserved.
// ─────────────────────────────────────────────────────────────────────────────
function deleteCustomer(req, res, next) {
  handle(req, res, next, async () => {
    const mobile = req.params.mobile;

    await pool.query(`
      INSERT INTO customer_profiles (mobile, is_deleted, updated_at)
      VALUES ($1, TRUE, NOW())
      ON CONFLICT (mobile) DO UPDATE SET
        is_deleted = TRUE,
        updated_at = NOW()
    `, [mobile]);

    res.status(204).end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/customers/:mobile/timeline
// Returns a merged chronological timeline of all customer activity:
// appointments, estimates, invoices (purchase + customer), and vehicles added.
// ─────────────────────────────────────────────────────────────────────────────
function getCustomerTimeline(req, res, next) {
  handle(req, res, next, async () => {
    const mobile = req.params.mobile;

    const [apptRes, estRes, piRes, ciRes, vehRes] = await Promise.all([
      // Appointments — status is a status_id FK (not a slug string column),
      // and hubs' name column is hub_name, not name. Same joins as the
      // proven-working appointments query in getCustomer() above.
      pool.query(`
        SELECT
          a.id, a.scheduled_date AS event_date, a.created_at,
          'appointment' AS type,
          ast.name AS status,
          ast.color AS status_color,
          a.vehicle_number,
          vt.name AS vehicle_type_name,
          mk.name AS make_name, md.name AS model_name,
          h.hub_name AS hub_name,
          a.notes
        FROM appointments a
        LEFT JOIN appointment_statuses ast ON ast.id = a.status_id
        LEFT JOIN vehicle_types  vt  ON vt.id  = a.vehicle_type_id
        LEFT JOIN vehicle_makes  mk  ON mk.id  = a.make_id
        LEFT JOIN vehicle_models md  ON md.id  = a.model_id
        LEFT JOIN hubs           h   ON h.id   = a.hub_id
        WHERE a.mobile = $1
        ORDER BY a.scheduled_date DESC, a.created_at DESC
      `, [mobile]),

      // Estimates
      pool.query(`
        SELECT
          e.id, e.estimate_date::text AS event_date, e.created_at,
          'estimate' AS type,
          e.status,
          NULL AS status_color,
          NULL AS vehicle_number,
          NULL AS vehicle_type_name,
          NULL AS make_name, NULL AS model_name,
          h.hub_name AS hub_name,
          e.notes,
          e.grand_total AS amount
        FROM estimates e
        LEFT JOIN hubs h ON h.id = e.hub_id
        WHERE e.mobile = $1
        ORDER BY e.estimate_date DESC, e.id DESC
      `, [mobile]),

      // Purchase invoices (sell invoices from hub side) — purchase_invoices
      // has no invoice_date or mobile column; mobile is derived via the
      // linked appointment/estimate, same pattern as purchase_invoices.controller.js.
      pool.query(`
        SELECT
          -- event_date drives the merged timeline's ordering and the date the
          -- customer sees, so it follows the document's own date. created_at
          -- is kept alongside purely as the JS sort fallback below.
          pi.id, pi.invoice_date::text AS event_date, pi.created_at,
          'purchase_invoice' AS type,
          pi.payment_status AS status,
          NULL AS status_color,
          NULL AS vehicle_number,
          NULL AS vehicle_type_name,
          NULL AS make_name, NULL AS model_name,
          h.hub_name AS hub_name,
          pi.notes,
          pi.grand_total AS amount
        FROM purchase_invoices pi
        LEFT JOIN hubs         h       ON h.id       = pi.hub_id
        LEFT JOIN appointments a       ON a.id       = pi.appointment_id
        LEFT JOIN estimates    est_ctx ON est_ctx.id = pi.estimate_id
        WHERE COALESCE(a.mobile, est_ctx.mobile) = $1
        ORDER BY pi.invoice_date DESC, pi.id DESC
      `, [mobile]),

      // Customer invoices — status lives in the `status` column, not payment_status.
      pool.query(`
        SELECT
          ci.id, ci.invoice_date::text AS event_date, ci.created_at,
          'customer_invoice' AS type,
          ci.status AS status,
          NULL AS status_color,
          NULL AS vehicle_number,
          NULL AS vehicle_type_name,
          NULL AS make_name, NULL AS model_name,
          NULL AS hub_name,
          NULL AS notes,
          ci.grand_total AS amount
        FROM customer_invoices ci
        WHERE ci.mobile = $1
        ORDER BY ci.invoice_date DESC, ci.id DESC
      `, [mobile]),

      // Manually added vehicles
      pool.query(`
        SELECT
          cv.id, cv.created_at AS event_date, cv.created_at,
          'vehicle_added' AS type,
          'added' AS status,
          NULL AS status_color,
          cv.vehicle_number,
          vt.name AS vehicle_type_name,
          mk.name AS make_name, md.name AS model_name,
          NULL AS hub_name,
          cv.notes,
          NULL AS amount
        FROM customer_vehicles cv
        LEFT JOIN vehicle_types  vt ON vt.id = cv.vehicle_type_id
        LEFT JOIN vehicle_makes  mk ON mk.id = cv.make_id
        LEFT JOIN vehicle_models md ON md.id = cv.model_id
        WHERE cv.mobile = $1
        ORDER BY cv.created_at DESC
      `, [mobile]),
    ]);

    // Merge and sort all events by event_date DESC
    const all = [
      ...apptRes.rows,
      ...estRes.rows,
      ...piRes.rows,
      ...ciRes.rows,
      ...vehRes.rows,
    ].sort((a, b) => new Date(b.event_date || b.created_at) - new Date(a.event_date || a.created_at));

    res.json({ items: all, total: all.length });
  });
}

module.exports = {
  listCustomers, getCustomer, updateCustomer, deleteCustomer,
  listCustomerVehicles, addCustomerVehicle, updateCustomerVehicle, deleteCustomerVehicle,
  getCustomerTimeline, getVehicleUsage, getCustomerByToken,
};
