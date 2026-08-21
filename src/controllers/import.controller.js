'use strict';

const { parse: parseCsvSync } = require('csv-parse/sync');
const XLSX                     = require('xlsx');
const { pool }                 = require('../config/db');
// The same generator every other lead-creating path uses. Sharing it is the
// point: a second implementation here could drift in length or alphabet, and
// the column's whole job is to look identical no matter which path made the row.
const { generatePublicToken }  = require('../utils/publicToken');

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_FIELD_LENGTH   = 255;
const CSV_INJECTION_RE   = /^[=+\-@\t\r]/;
const CONTROL_CHARS_RE   = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

// ─── Mobile normaliser ───────────────────────────────────────────────────────
function normaliseMobile(v) {
  return String(v || '').replace(/\D/g, '').replace(/^91(\d{10})$/, '$1');
}

// ─── Import type definitions ──────────────────────────────────────────────────
//
//  identityFields  — the subset of columns that uniquely identify a record.
//                    Used for in-file dedup AND for DB lookup during upsert.
//                    Fields NOT in identityFields are the ones that get updated.
//
//  Example — vehicles:
//    identity  → make + model  (who the record IS)
//    updatable → type          (what can change on it)
//
const IMPORT_TYPES = {
  vehicles: {
    required:       ['type', 'make', 'model'],
    optional:       ['segment', 'body_type', 'engine_cc'],  // NULL stored when blank
    label:          'Vehicle',
    // Identity includes segment so the same model can have separate Petrol / CNG / Electric variants
    identityFields: ['make', 'model', 'segment'],           // type/body_type/engine_cc updatable per variant
  },
  locations: {
    required:       ['state', 'city', 'area'],
    optional:       ['pincode'],
    label:          'Location',
    identityFields: ['state', 'city', 'area'],  // pincode is updatable
  },
  services: {
    required:       ['category', 'service'],
    optional:       ['description', 'vehicle_class', 'gst_percent', 'sac_code'],
    label:          'Service',
    identityFields: ['category', 'service'],           // description, vehicle_class, gst_percent, sac_code are updatable
  },
  pricing: {
    required:       ['price', 'rule_type'],
    optional:       ['category', 'service', 'vehicle_type', 'body_type', 'segment', 'make', 'model', 'cc_category', 'is_active'],
    label:          'Pricing Rule',
    identityFields: ['category', 'service', 'vehicle_type', 'body_type', 'segment', 'make', 'model', 'cc_category'],
  },
  parts: {
    required:       ['name'],
    optional:       ['category', 'vehicle_type', 'customer_rate', 'gst_percent', 'hsn_code'],
    label:          'Part',
    identityFields: ['name'],
  },
};

// ─── Sample data for templates ─────────────────────────────────────────────────
const TEMPLATE_SAMPLES = {
  vehicles: [
    // 4W — each segment variant is a separate row
    { type: 'Four-Wheeler', make: 'Maruti',  model: 'Swift',       segment: 'Petrol',   body_type: 'Hatchback', engine_cc: '' },
    { type: 'Four-Wheeler', make: 'Maruti',  model: 'Swift',       segment: 'CNG',      body_type: 'Hatchback', engine_cc: '' },
    { type: 'Four-Wheeler', make: 'Hyundai', model: 'Creta',       segment: 'Diesel',   body_type: 'SUV',       engine_cc: '' },
    // 2W — Petrol and Electric variants as separate rows
    { type: 'Two-Wheeler',  make: 'Honda',   model: 'Activa',      segment: 'Petrol',   body_type: '',          engine_cc: '110' },
    { type: 'Two-Wheeler',  make: 'Honda',   model: 'Activa',      segment: 'Electric', body_type: '',          engine_cc: '0'   },
    { type: 'Two-Wheeler',  make: 'Royal Enfield', model: 'Classic 350', segment: 'Petrol', body_type: '',      engine_cc: '349' },
  ],
  locations: [
    { state: 'Maharashtra', city: 'Mumbai',    area: 'Andheri',    pincode: '400053' },
    { state: 'Maharashtra', city: 'Pune',      area: 'Kothrud',    pincode: '411038' },
    { state: 'Karnataka',   city: 'Bengaluru', area: 'Koramangala',pincode: '560034' },
  ],
  services: [
    { category: 'Wash',        service: 'Exterior Wash',       description: 'Full exterior hand wash',          vehicle_class: 'both', gst_percent: '18', sac_code: '998714' },
    { category: 'Wash',        service: 'Interior Vacuuming',  description: 'Complete interior vacuum cleaning', vehicle_class: 'both', gst_percent: '18', sac_code: '998714' },
    { category: 'AC',          service: 'AC Gas Refill',       description: 'Refrigerant top-up',               vehicle_class: '4W',   gst_percent: '18', sac_code: '998714' },
    { category: 'Two-Wheeler', service: 'Chain Lubrication',   description: 'Chain cleaning and lubrication',   vehicle_class: '2W',   gst_percent: '18', sac_code: ''       },
    { category: 'Detailing',   service: 'Engine Bay Cleaning', description: 'Professional engine degreasing',   vehicle_class: 'both', gst_percent: '18', sac_code: ''       },
  ],
  parts: [
    { name: 'Engine Oil Filter',  category: 'Engine',   vehicle_type: 'both', customer_rate: '450.00', gst_percent: '28', hsn_code: '84099900' },
    { name: 'Air Filter',         category: 'Engine',   vehicle_type: 'both', customer_rate: '320.00', gst_percent: '28', hsn_code: '84212300' },
    { name: 'Brake Pad Set',      category: 'Brakes',   vehicle_type: '4W',   customer_rate: '1200.00', gst_percent: '28', hsn_code: '87083000' },
    { name: 'Brake Shoe',         category: 'Brakes',   vehicle_type: '2W',   customer_rate: '350.00', gst_percent: '28', hsn_code: '87083000' },
    { name: 'Spark Plug',         category: 'Engine',   vehicle_type: '',     customer_rate: '',        gst_percent: '18', hsn_code: '85111000' },
    { name: 'Wiper Blade',        category: 'Body',     vehicle_type: '4W',   gst_percent: '18', hsn_code: '85122000' },
    { name: 'Chain Lubrication',  category: '',         vehicle_type: '2W',   gst_percent: '18', hsn_code: ''         },
  ],
  leads: [
    { mobile: '9712301573', name: 'Raj Patel',    whatsapp: '',           state: 'Gujarat',     city: 'Ahmedabad', area: 'Navrangpura', vehicle_type: '4W', make: 'Maruti',  model: 'Swift',   lead_source: 'Walk-in',  status: 'Follow-Up - General',            assigned_to: '',                  notes: 'Interested in full service', services: 'AC Service',  categories: ''     },
    { mobile: '9898123456', name: 'Priya Shah',   whatsapp: '9898123456', state: 'Gujarat',     city: 'Surat',     area: 'Adajan',      vehicle_type: '2W', make: 'Honda',   model: 'Activa',  lead_source: 'Website',  status: 'Call Unanswered - Attempt 1', assigned_to: 'agent@example.com', notes: '',                           services: '',            categories: 'AC;Wash' },
    { mobile: '9876543210', name: 'Amit Kumar',   whatsapp: '',           state: '',            city: '',          area: '',            vehicle_type: '',   make: '',        model: '',        lead_source: 'Referral', status: '',                     assigned_to: '',                  notes: '',                           services: '',            categories: ''     },
  ],
  pricing: [
    // ── Category-level rules (no service column) ─────────────────────────────
    // Applies to ALL services inside the category
    { category: 'Wash',        service: '',                    price: '399', rule_type: 'Universal',   vehicle_type: '',   body_type: '',    segment: '',    make: '',       model: '',      cc_category: '',   is_active: 'true' },
    { category: 'AC',          service: '',                    price: '999', rule_type: 'Body Type',   vehicle_type: '4W', body_type: 'SUV', segment: '',    make: '',       model: '',      cc_category: '',   is_active: 'true' },
    // ── Service-level rules (category + service — service validated inside category) ──
    { category: 'Wash',        service: 'Exterior Wash',       price: '499', rule_type: 'Universal',   vehicle_type: '',   body_type: '',    segment: '',    make: '',       model: '',      cc_category: '',   is_active: 'true' },
    { category: 'Wash',        service: 'Exterior Wash',       price: '699', rule_type: 'Segment',     vehicle_type: '4W', body_type: '',    segment: 'SUV', make: '',       model: '',      cc_category: '',   is_active: 'true' },
    { category: 'Wash',        service: 'Exterior Wash',       price: '349', rule_type: 'Model',       vehicle_type: '4W', body_type: '',    segment: '',    make: 'Maruti', model: 'Swift', cc_category: '',   is_active: 'true' },
    { category: 'Two-Wheeler',  service: 'Chain Lubrication',  price: '249', rule_type: 'CC Category', vehicle_type: '2W', body_type: '',    segment: '',    make: '',       model: '',      cc_category: 'C1', is_active: 'true' },
  ],
};

// ═════════════════════════════════════════════════════════════════════════════
// FILE PARSING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Detects the file format and parses it into an array of raw row objects.
 * Throws a structured error for unsupported formats.
 */
function parseUploadedFile(file) {
  const ext  = (file.originalname || '').split('.').pop().toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();

  const isCSV  = ext === 'csv'  || mime.includes('csv') || mime === 'text/plain';
  const isXLSX = ext === 'xlsx' || mime.includes('spreadsheetml');

  if (!isCSV && !isXLSX) {
    const err = new Error('INVALID_FILE_FORMAT');
    err.status = 400;
    err.userMessage = `Invalid file format. Only .csv and .xlsx files are accepted. You uploaded: .${ext}`;
    err.code = 'INVALID_FILE_FORMAT';
    throw err;
  }

  if (isCSV) {
    return parseCsvSync(file.buffer, {
      columns:            true,
      skip_empty_lines:   true,
      trim:               true,
      relax_column_count: true,
      bom:                true,   // strip UTF-8 BOM
    });
  }

  // XLSX path
  const workbook  = XLSX.read(file.buffer, { type: 'buffer', raw: false });
  const sheetName = workbook.SheetNames[0];
  const sheet     = workbook.Sheets[sheetName];
  const rawRows   = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

  // Normalise: trim all keys and values
  return rawRows.map(row => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[k.trim()] = String(v ?? '').trim();
    }
    return out;
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// COLUMN VALIDATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Builds a case-insensitive mapping from normalised column names -> actual keys.
 * Returns { missing, extra, getValue }
 */
function analyseColumns(rows, required, optional = []) {
  if (!rows.length) {
    return { missing: required, extra: [], getValue: () => '' };
  }

  // Map lowercase -> first raw key that matches
  const lowerMap = {};
  for (const rawKey of Object.keys(rows[0])) {
    const lower = rawKey.toLowerCase().trim();
    if (!(lower in lowerMap)) lowerMap[lower] = rawKey;
  }

  const allKnownLower = [...required, ...optional].map(c => c.toLowerCase());
  const missing       = required.filter(c => !(c.toLowerCase() in lowerMap));
  const extra         = Object.keys(lowerMap).filter(k => !allKnownLower.includes(k));

  const getValue = (row, col) => {
    const rawKey = lowerMap[col.toLowerCase()];
    return rawKey !== undefined ? String(row[rawKey] ?? '').trim() : '';
  };

  return { missing, extra, getValue };
}

// ═════════════════════════════════════════════════════════════════════════════
// ROW-LEVEL VALIDATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Validates every data row.
 *
 * identityFields — columns that together identify a record (used for in-file
 * dedup). Two rows with the same identity values are flagged as duplicates
 * even if their other fields differ (e.g. same make+model but different type).
 *
 * Returns { errors, validRows, skippedBlanks }
 * Each error: { row, column, code, message, rowData }
 */
function validateRows(rows, required, optional, identityFields, getValue) {
  const errors      = [];
  const validRows   = [];
  let skippedBlanks = 0;
  const seenIdentities = new Set();

  for (let i = 0; i < rows.length; i++) {
    const row    = rows[i];
    const rowNum = i + 2; // 1-based; row 1 = header

    // Skip completely blank rows silently
    const allEmpty = [...required, ...optional].every(col => !getValue(row, col));
    if (allEmpty) { skippedBlanks++; continue; }

    let rowHasError = false;

    // ── Per-field validation ────────────────────────────────────────────────
    for (const col of required) {
      const val = getValue(row, col);

      if (!val) {
        errors.push({
          row:     rowNum,
          column:  col,
          code:    'EMPTY_FIELD',
          message: `The '${col}' field cannot be blank.`,
          rowData: required.map(c => getValue(row, c)).join(' | '),
        });
        rowHasError = true;
        continue;
      }

      if (val.length > MAX_FIELD_LENGTH) {
        errors.push({
          row:     rowNum,
          column:  col,
          code:    'FIELD_TOO_LONG',
          message: `The '${col}' field exceeds ${MAX_FIELD_LENGTH} characters (${val.length} found).`,
          rowData: val.substring(0, 60) + '…',
        });
        rowHasError = true;
        continue;
      }

      if (CONTROL_CHARS_RE.test(val)) {
        errors.push({
          row:     rowNum,
          column:  col,
          code:    'INVALID_CHARACTERS',
          message: `The '${col}' field contains invalid control characters.`,
          rowData: val,
        });
        rowHasError = true;
        continue;
      }

      if (CSV_INJECTION_RE.test(val)) {
        errors.push({
          row:     rowNum,
          column:  col,
          code:    'CSV_INJECTION',
          message: `The '${col}' field starts with a restricted character (=, +, -, @).`,
          rowData: val,
        });
        rowHasError = true;
      }
    }

    if (rowHasError) continue;

    // ── In-file identity duplicate check ────────────────────────────────────
    // Two rows that share the same identity key (e.g. same make + model) are
    // ambiguous — we cannot know which version of the updatable fields to apply.
    const identityKey = identityFields.map(c => getValue(row, c).toLowerCase()).join('§');
    if (seenIdentities.has(identityKey)) {
      errors.push({
        row:     rowNum,
        column:  identityFields.join(' + '),
        code:    'DUPLICATE_IN_FILE',
        message: `Duplicate identity: a row with the same ${identityFields.join(' + ')} combination already appears earlier in this file. ` +
                 `Only one row per unique ${identityFields.join(' + ')} is allowed.`,
        rowData: required.map(c => getValue(row, c)).join(' | '),
      });
      continue;
    }
    seenIdentities.add(identityKey);
    validRows.push(row);
  }

  return { errors, validRows, skippedBlanks };
}

// ═════════════════════════════════════════════════════════════════════════════
// GENERIC IMPORT HANDLER FACTORY
// ═════════════════════════════════════════════════════════════════════════════

function makeImportHandler(type, dbInserter) {
  return async function importHandler(req, res, next) {
    // 1. File present?
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error:   'No file uploaded. Please attach a .csv or .xlsx file.',
        code:    'NO_FILE',
      });
    }

    let def = IMPORT_TYPES[type];

    // When uploading vehicles with ?class=2W or ?class=4W, 'type' is auto-determined
    // by the backend so the CSV doesn't need it. Adjust required/optional accordingly.
    if (type === 'vehicles' && (req.query.class === '2W' || req.query.class === '4W')) {
      const isTW = req.query.class === '2W';
      def = {
        ...def,
        // 4W: segment + body_type are required (same model can exist with different fuel types)
        // 2W: engine_cc is optional (CC category auto-classified)
        required:      isTW ? ['make', 'model'] : ['make', 'model', 'segment', 'body_type'],
        optional:      isTW ? ['engine_cc'] : [],
        // softRequired — 2W only: rows missing engine_cc still upload but get a warning
        softRequired:  isTW ? ['engine_cc'] : [],
        // segment is part of 4W identity so same model with different fuel is a separate record
        identityFields: isTW ? ['make', 'model'] : ['make', 'model', 'segment'],
      };
    }

    // 2. Parse file
    let rows;
    try {
      rows = parseUploadedFile(req.file);
    } catch (err) {
      return res.status(400).json({
        success: false,
        error:   err.userMessage || err.message,
        code:    err.code || 'PARSE_ERROR',
      });
    }

    // 3. Empty file check
    if (!rows.length) {
      return res.status(400).json({
        success: false,
        error:   'The uploaded file is empty or contains no data rows after the header.',
        code:    'EMPTY_FILE',
      });
    }

    // 4. Column validation
    const { missing, extra, getValue } = analyseColumns(rows, def.required, def.optional);

    if (missing.length) {
      return res.status(400).json({
        success: false,
        error:   `Missing required column(s): ${missing.map(c => `'${c}'`).join(', ')}. Please check your file and try again.`,
        code:    'MISSING_COLUMN',
        details: { missing, extra },
      });
    }

    // 5. Row-level validation (uses identityFields for in-file dedup)
    const { errors, validRows, skippedBlanks } = validateRows(
      rows, def.required, def.optional, def.identityFields, getValue
    );

    // All-or-nothing: reject if any errors
    if (errors.length) {
      return res.status(422).json({
        success:      false,
        error:        `Validation failed — ${errors.length} error(s) found. No data has been inserted or updated.`,
        code:         'VALIDATION_FAILED',
        errorCount:   errors.length,
        skippedBlanks,
        warnings:     extra.length
          ? [`Unrecognised column(s) ignored: ${extra.map(c => `'${c}'`).join(', ')}`]
          : [],
        errors,
      });
    }

    // 5b. Soft-required check — rows missing these fields are still uploaded
    //     but generate a per-row warning explaining the pricing impact.
    const softRequired  = def.softRequired || [];
    const rowWarnings   = [];
    if (softRequired.length) {
      // Build a lookup: validRow → original row index (for row number in warning)
      const validRowSet = new Set(validRows);
      let rowIndex = 1; // 1-based data row counter (header = row 1)
      for (const row of rows) {
        rowIndex++;
        if (!validRowSet.has(row)) continue; // already failed hard validation
        const make  = getValue(row, 'make')  || '';
        const model = getValue(row, 'model') || '';
        const missingCols = softRequired.filter(col => !getValue(row, col));
        if (!missingCols.length) continue;

        const colLabels = missingCols.map(c => `'${c}'`).join(', ');
        const impact = missingCols.includes('engine_cc')
          ? 'CC Category cannot be determined — CC-based pricing rules will not apply for this vehicle.'
          : `Missing ${colLabels} — segment/body-type pricing rules will not apply for this vehicle.`;

        rowWarnings.push({
          row:     rowIndex,
          name:    `${make} ${model}`.trim(),
          missing: missingCols,
          message: `Row ${rowIndex} (${make} ${model}) is missing ${colLabels}. ${impact}`,
        });
      }
    }

    // 6. Database upsert (transaction)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { inserted, updated, unchanged } = await dbInserter(client, validRows, getValue, req.query);
      await client.query('COMMIT');

      const parts = [];
      if (inserted  > 0) parts.push(`${inserted} inserted`);
      if (updated   > 0) parts.push(`${updated} updated`);
      if (unchanged > 0) parts.push(`${unchanged} unchanged`);

      const colWarnings = extra.length
        ? [`Unrecognised column(s) were ignored: ${extra.map(c => `'${c}'`).join(', ')}`]
        : [];

      return res.json({
        success:     true,
        message:     parts.length
          ? `Upload complete: ${parts.join(', ')}.`
          : 'No changes — all records already matched the database.',
        inserted,
        updated,
        unchanged,
        skippedBlanks,
        warnings:    colWarnings,
        rowWarnings, // per-row soft-required warnings (pricing impact)
      });
    } catch (err) {
      await client.query('ROLLBACK');
      // If the dbInserter threw a structured validation error, return it as a clean 422
      if (err.status === 422) {
        return res.status(422).json({
          success:    false,
          error:      err.message,
          code:       'VALIDATION_FAILED',
          errorCount: err.errors?.length ?? 1,
          skippedBlanks,
          warnings:   [],
          errors:     err.errors ?? [{ row: '–', column: '–', code: 'VALIDATION_ERROR', message: err.message, rowData: '' }],
        });
      }
      next(err);
    } finally {
      client.release();
    }
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// DB UPSERT FUNCTIONS
// Each returns { inserted, updated, unchanged }
// ═════════════════════════════════════════════════════════════════════════════

// ── Helper: get or create a record, return its id ────────────────────────────
async function getOrCreate(client, table, whereCol, whereVal, extraInsert = {}) {
  let r = await client.query(
    `SELECT id FROM ${table} WHERE LOWER(${whereCol}) = LOWER($1)`, [whereVal]
  );
  if (r.rows[0]) return r.rows[0].id;
  const keys   = [whereCol, ...Object.keys(extraInsert)];
  const vals   = [whereVal, ...Object.values(extraInsert)];
  const cols   = keys.join(', ');
  const params = keys.map((_, i) => `$${i + 1}`).join(', ');
  r = await client.query(
    `INSERT INTO ${table} (${cols}) VALUES (${params}) RETURNING id`, vals
  );
  return r.rows[0].id;
}

async function getOrCreateWhere2(client, table, col1, val1, col2, val2, extraInsert = {}) {
  let r = await client.query(
    `SELECT id FROM ${table} WHERE ${col1} = $1 AND LOWER(${col2}) = LOWER($2)`,
    [val1, val2]
  );
  if (r.rows[0]) return r.rows[0].id;
  const extra  = Object.entries(extraInsert);
  const cols   = [col1, col2, ...extra.map(([k]) => k)].join(', ');
  const vals   = [val1, val2, ...extra.map(([, v]) => v)];
  const params = vals.map((_, i) => `$${i + 1}`).join(', ');
  r = await client.query(
    `INSERT INTO ${table} (${cols}) VALUES (${params}) RETURNING id`, vals
  );
  return r.rows[0].id;
}

// ── VEHICLES ─────────────────────────────────────────────────────────────────
//  Identity:  make + model
//  Updatable: type, segment, body_type
//
//  segment and body_type are optional — blank values are stored as NULL.
//  They are get-or-created when a non-blank value is provided.
//
//  Strategy:
//    1. Look up the model by (make_name, model_name) across ALL types.
//    2a. Found and all fields match → unchanged.
//    2b. Found but any field differs → resolve target make/segment/body_type,
//        UPDATE the record.
//    3.  Not found → INSERT fresh.
//
async function upsertVehicles(client, rows, getValue, query = {}) {
  let inserted = 0, updated = 0, unchanged = 0;

  // When class=2W|4W, auto-resolve vehicle type name from DB once (not per row)
  let classTypeName = null;
  if (query.class === '2W' || query.class === '4W') {
    const is2W = query.class === '2W';
    // Find the first active vehicle type matching the class
    const typeRows = await client.query(`SELECT name FROM vehicle_types WHERE is_active = TRUE`);
    const matched = typeRows.rows.find(r =>
      is2W
        ? (r.name.toLowerCase().includes('two') || r.name.toLowerCase().includes('2w'))
        : !(r.name.toLowerCase().includes('two') || r.name.toLowerCase().includes('2w') ||
            r.name.toLowerCase().includes('bike') || r.name.toLowerCase().includes('scoot'))
    );
    if (!matched) {
      throw Object.assign(
        new Error(`No active ${is2W ? 'Two-Wheeler' : 'Four-Wheeler'} vehicle type found. Please create one in Reference Data first.`),
        { status: 422 }
      );
    }
    classTypeName = matched.name;

    // ── Cross-sheet guard ────────────────────────────────────────────────────
    // Detect if the user accidentally uploaded the wrong sheet.
    // If uploading as 2W but rows contain non-empty body_type → wrong sheet.
    // If uploading as 4W but rows contain non-empty engine_cc → wrong sheet.
    const crossCheckCol = is2W ? 'body_type' : 'engine_cc';
    const hasCrossData  = rows.some(r => {
      const v = getValue(r, crossCheckCol);
      return v && String(v).trim() !== '';
    });
    if (hasCrossData) {
      const msg = is2W
        ? `This looks like a 4W (Four-Wheeler) sheet — it contains 'body_type' data. Please use the "Bulk Upload 4W" button instead.`
        : `This looks like a 2W (Two-Wheeler) sheet — it contains 'engine_cc' data. Please use the "Bulk Upload 2W" button instead.`;
      throw Object.assign(new Error(msg), { status: 422 });
    }
  }

  for (const row of rows) {
    const typeName     = classTypeName || getValue(row, 'type');
    const makeName     = getValue(row, 'make');
    const modelName    = getValue(row, 'model');
    // 2W uploads never have segment — skip it regardless of what's in the row
    const segmentName  = query.class === '2W' ? null : (getValue(row, 'segment')   || null);
    // 4W uploads never have engine_cc
    const bodyTypeName = query.class === '2W' ? null : (getValue(row, 'body_type') || null);
    const engineCcRaw  = query.class === '4W' ? null : (getValue(row, 'engine_cc') || null);

    // Parse engine_cc — must be a positive integer if provided
    let engineCc = null;
    if (engineCcRaw !== null) {
      const parsed = parseInt(engineCcRaw, 10);
      if (!isNaN(parsed) && parsed > 0) engineCc = parsed;
    }

    // ── Resolve segment id (error if not found in reference data) ──────────────────────
    let segmentId = null;
    if (segmentName) {
      segmentId = (await client.query(
        'SELECT id FROM segments WHERE LOWER(name) = LOWER($1)', [segmentName]
      )).rows[0]?.id ?? null;
      if (!segmentId) {
        throw Object.assign(
          new Error(`Row ${rowIndex}: Segment "${segmentName}" is not in the reference data. Please add it first before uploading.`),
          { status: 422 }
        );
      }
    }

    // ── Resolve body_type id (error if not found in reference data) ────────────────────
    let bodyTypeId = null;
    if (bodyTypeName) {
      bodyTypeId = (await client.query(
        'SELECT id FROM body_types WHERE LOWER(name) = LOWER($1)', [bodyTypeName]
      )).rows[0]?.id ?? null;
      if (!bodyTypeId) {
        throw Object.assign(
          new Error(`Row ${rowIndex}: Body Type "${bodyTypeName}" is not in the reference data. Please add it first before uploading.`),
          { status: 422 }
        );
      }
    }

    // ── Auto-classify CC category from engine_cc ────────────────────────────
    let ccCategoryId = null;
    if (engineCc !== null) {
      const ccRow = (await client.query(
        `SELECT id FROM cc_categories
          WHERE is_active = TRUE AND min_cc <= $1 AND max_cc >= $1
          LIMIT 1`,
        [engineCc]
      )).rows[0];
      ccCategoryId = ccRow?.id ?? null;
    }

    // ── 1. Look up existing model by (make_name, model_name, segment_name) ──
    // Segment is part of identity — Honda Activa Petrol and Honda Activa Electric
    // are stored as separate vehicle_model rows.
    const existing = await client.query(
      `SELECT vm.id             AS model_id,
              vm.make_id,
              vm.segment_id,
              vm.body_type_id,
              vm.engine_cc,
              vm.cc_category_id,
              vt.name           AS current_type
       FROM   vehicle_models vm
       JOIN   vehicle_makes  vmk ON vmk.id = vm.make_id
       JOIN   vehicle_types  vt  ON vt.id  = vmk.vehicle_type_id
       LEFT JOIN segments    seg ON seg.id  = vm.segment_id
       WHERE  LOWER(vm.name)  = LOWER($1)
         AND  LOWER(vmk.name) = LOWER($2)
         AND  (
               ($3::text IS NULL AND vm.segment_id IS NULL)
               OR LOWER(seg.name) = LOWER($3::text)
              )`,
      [modelName, makeName, segmentName]
    );

    if (existing.rows.length > 0) {
      const {
        model_id,
        make_id:        currentMakeId,
        segment_id:     currentSegmentId,
        body_type_id:   currentBodyTypeId,
        engine_cc:      currentEngineCc,
        cc_category_id: currentCcCategoryId,
      } = existing.rows[0];

      // Resolve target make (type may have changed)
      const targetTypeId = await getOrCreate(client, 'vehicle_types', 'name', typeName);
      const targetMakeId = await getOrCreateWhere2(
        client, 'vehicle_makes', 'vehicle_type_id', targetTypeId, 'name', makeName
      );

      const typeChanged       = targetMakeId !== currentMakeId;
      const segmentChanged    = (segmentId     ?? null) !== (currentSegmentId     ?? null);
      const bodyTypeChanged   = (bodyTypeId    ?? null) !== (currentBodyTypeId    ?? null);
      const engineCcChanged   = (engineCc      ?? null) !== (currentEngineCc      ?? null);
      const ccCatChanged      = (ccCategoryId  ?? null) !== (currentCcCategoryId  ?? null);

      if (!typeChanged && !segmentChanged && !bodyTypeChanged && !engineCcChanged && !ccCatChanged) {
        unchanged++;
      } else {
        if (typeChanged) {
          const conflict = await client.query(
            'SELECT id FROM vehicle_models WHERE make_id = $1 AND LOWER(name) = LOWER($2)',
            [targetMakeId, modelName]
          );
          if (conflict.rows.length > 0) { unchanged++; continue; }
        }

        await client.query(
          `UPDATE vehicle_models
             SET make_id = $1, segment_id = $2, body_type_id = $3,
                 engine_cc = $4, cc_category_id = $5
           WHERE id = $6`,
          [targetMakeId, segmentId, bodyTypeId, engineCc, ccCategoryId, model_id]
        );
        updated++;
      }
    } else {
      // 3. Not found — insert fresh
      const typeId = await getOrCreate(client, 'vehicle_types', 'name', typeName);
      const makeId = await getOrCreateWhere2(
        client, 'vehicle_makes', 'vehicle_type_id', typeId, 'name', makeName
      );
      await client.query(
        `INSERT INTO vehicle_models
           (make_id, name, segment_id, body_type_id, engine_cc, cc_category_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [makeId, modelName, segmentId, bodyTypeId, engineCc, ccCategoryId]
      );
      inserted++;
    }
  }

  return { inserted, updated, unchanged };
}

// ── LOCATIONS ─────────────────────────────────────────────────────────────────
//  Identity: state + city + area
//  Updatable: pincode
//
async function upsertLocations(client, rows, getValue) {
  let inserted = 0, updated = 0, unchanged = 0;

  for (const row of rows) {
    const stateName = getValue(row, 'state');
    const cityName  = getValue(row, 'city');
    const areaName  = getValue(row, 'area');
    const pincode   = getValue(row, 'pincode') || null;

    // Resolve or create state + city
    const stateId = await getOrCreate(client, 'states', 'name', stateName);
    const cityId  = await getOrCreateWhere2(
      client, 'cities', 'state_id', stateId, 'name', cityName
    );

    // Look up the area by (city_id, area_name)
    const existing = await client.query(
      'SELECT id, pincode FROM areas WHERE city_id = $1 AND LOWER(name) = LOWER($2)',
      [cityId, areaName]
    );

    if (existing.rows.length > 0) {
      const { id: areaId, pincode: currentPincode } = existing.rows[0];
      const pincodeChanged = (pincode ?? null) !== (currentPincode ?? null);

      if (pincodeChanged) {
        await client.query(
          'UPDATE areas SET pincode = $1 WHERE id = $2',
          [pincode, areaId]
        );
        updated++;
      } else {
        unchanged++;
      }
    } else {
      await client.query(
        'INSERT INTO areas (city_id, name, pincode) VALUES ($1, $2, $3)',
        [cityId, areaName, pincode]
      );
      inserted++;
    }
  }

  return { inserted, updated, unchanged };
}

// ── SERVICES ──────────────────────────────────────────────────────────────────
//  Identity: category + service
//  Updatable: description, vehicle_class, gst_percent, sac_code
//
//  vehicle_class in the CSV uses the standardised values:
//    "4W"   → stored as "4W"   (Four-Wheeler only)
//    "2W"   → stored as "2W"   (Two-Wheeler only)
//    "both" → stored as "both" (default, shown for all vehicles)
//
const VALID_VEHICLE_CLASS_INPUT = new Set(['both', '4w', '2w']);  // what the CSV accepts (case-insensitive)

function normaliseVehicleClass(raw) {
  const v = (raw || '').toLowerCase().trim();
  if (v === '' || v === 'both') return 'both';
  if (v === '4w') return '4W';
  if (v === '2w') return '2W';
  return raw.trim();  // unknown — will fail validation
}

const VALID_VEHICLE_CLASSES = new Set(['both', '4W', '2W']);

async function upsertServices(client, rows, getValue) {
  let inserted = 0, updated = 0, unchanged = 0;

  // ── Pre-validate vehicle_class for ALL rows before any DB work ──────────────
  // Accepts: 4W, 2W, both (case-insensitive). Blank defaults to "both".
  // Collect all invalid rows so every error is shown at once (not just the first).
  const vcErrors = [];
  for (let i = 0; i < rows.length; i++) {
    const vcRaw = (getValue(rows[i], 'vehicle_class') || '').toLowerCase().trim();
    if (vcRaw !== '' && !VALID_VEHICLE_CLASS_INPUT.has(vcRaw)) {
      vcErrors.push({
        row:     i + 2,
        column:  'vehicle_class',
        code:    'INVALID_VALUE',
        message: `Invalid vehicle_class "${getValue(rows[i], 'vehicle_class')}" for service "${getValue(rows[i], 'service')}". Allowed values: 4W, 2W, both.`,
        rowData: getValue(rows[i], 'service') || '',
      });
    }
  }
  if (vcErrors.length) {
    const err = new Error(`${vcErrors.length} invalid vehicle_class value(s) found. No services have been imported.`);
    err.status = 422;
    err.errors = vcErrors;
    throw err;
  }

  for (const row of rows) {
    const catName     = getValue(row, 'category');
    const serviceName = getValue(row, 'service');
    const desc        = getValue(row, 'description') || null;

    // Normalise: 4W → fw, 2W → tw, both/blank → both
    const vehicleClass = normaliseVehicleClass(getValue(row, 'vehicle_class'));

    // Optional GST % — store as numeric or null
    const gstRaw      = getValue(row, 'gst_percent');
    const gstPercent  = gstRaw !== '' && gstRaw != null && !isNaN(parseFloat(gstRaw))
      ? parseFloat(gstRaw)
      : null;

    // Optional SAC code — trim, store as string or null
    const sacCode = (getValue(row, 'sac_code') || '').trim() || null;

    // Resolve or create service_category
    const catId = await getOrCreate(client, 'service_categories', 'name', catName);

    // Look up existing service
    const existing = await client.query(
      'SELECT id, description, vehicle_class, gst_percent, sac_code FROM services WHERE category_id = $1 AND LOWER(name) = LOWER($2)',
      [catId, serviceName]
    );

    if (existing.rows.length > 0) {
      const { id: serviceId, description: currentDesc, vehicle_class: currentVc,
              gst_percent: currentGst, sac_code: currentSac } = existing.rows[0];
      const descChanged = (desc ?? null) !== (currentDesc ?? null);
      const vcChanged   = vehicleClass !== (currentVc || 'both');
      const gstChanged  = (gstPercent ?? null) !== (currentGst ?? null);
      const sacChanged  = (sacCode ?? null) !== (currentSac ?? null);

      if (descChanged || vcChanged || gstChanged || sacChanged) {
        await client.query(
          'UPDATE services SET description = $1, vehicle_class = $2, gst_percent = $3, sac_code = $4 WHERE id = $5',
          [desc, vehicleClass, gstPercent, sacCode, serviceId]
        );
        updated++;
      } else {
        unchanged++;
      }
    } else {
      await client.query(
        'INSERT INTO services (category_id, name, description, vehicle_class, gst_percent, sac_code) VALUES ($1, $2, $3, $4, $5, $6)',
        [catId, serviceName, desc, vehicleClass, gstPercent, sacCode]
      );
      inserted++;
    }
  }

  return { inserted, updated, unchanged };
}

// ── PRICING ───────────────────────────────────────────────────────────────────
//  Two-pass, all-or-nothing import (same pattern as importLeads).
//  Pass 1 → validate every row (basic + all DB reference lookups), collect errors.
//  Pass 2 → only runs if zero errors; upserts all rows.
//
//  vehicle_type must match exactly what is stored in your DB (e.g. "4W" / "2W").
//
async function importPricing(req, res, next) {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded.', code: 'NO_FILE' });
  }

  const REQUIRED      = ['price', 'rule_type'];
  const OPTIONAL      = ['category', 'service', 'vehicle_type', 'body_type', 'segment', 'make', 'model', 'cc_category', 'is_active'];
  const IDENTITY_COLS = ['category', 'service', 'vehicle_type', 'body_type', 'segment', 'make', 'model', 'cc_category'];
  const VALID_RULE_TYPES = new Set(['universal', 'body_type', 'segment', 'make', 'model', 'cc_category']);

  // 1. Parse
  let rows;
  try { rows = parseUploadedFile(req.file); }
  catch (err) {
    return res.status(400).json({ success: false, error: err.userMessage || err.message, code: err.code || 'PARSE_ERROR' });
  }
  if (!rows.length) {
    return res.status(400).json({ success: false, error: 'The uploaded file is empty.', code: 'EMPTY_FILE' });
  }

  // 2. Column analysis
  const { missing, extra, getValue } = analyseColumns(rows, REQUIRED, OPTIONAL);
  if (missing.length) {
    return res.status(400).json({
      success: false,
      error:   `Missing required column(s): ${missing.map(c => `'${c}'`).join(', ')}.`,
      code:    'MISSING_COLUMN',
      details: { missing, extra },
    });
  }

  const rowErrors      = [];
  const parsedRows     = [];
  let   skippedBlanks  = 0;
  const seenIdentities = new Set();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Pass 1: validate every row ──────────────────────────────────────────
    for (let i = 0; i < rows.length; i++) {
      const row    = rows[i];
      const rowNum = i + 2;

      // Skip fully blank rows silently
      if ([...REQUIRED, ...OPTIONAL].every(col => !getValue(row, col))) { skippedBlanks++; continue; }

      const errs = [];

      const categoryName    = getValue(row, 'category')     || null;
      const serviceName     = getValue(row, 'service')      || null;
      const priceStr        = getValue(row, 'price');
      const ruleTypeRaw     = getValue(row, 'rule_type');
      const vehicleTypeName = getValue(row, 'vehicle_type') || null;
      const bodyTypeName    = getValue(row, 'body_type')    || null;
      const segmentName     = getValue(row, 'segment')      || null;
      const makeName        = getValue(row, 'make')         || null;
      const modelName       = getValue(row, 'model')        || null;
      const ccCategoryName  = getValue(row, 'cc_category')  || null;
      const isActiveRaw     = getValue(row, 'is_active');

      // price
      const price = parseFloat(priceStr);
      if (!priceStr)                         errs.push({ col: 'price',     msg: `The 'price' column is required.` });
      else if (isNaN(price) || price <= 0)   errs.push({ col: 'price',     msg: `Invalid price "${priceStr}" — must be a positive number.` });

      // rule_type
      let ruleTypeNorm = '';
      if (!ruleTypeRaw) {
        errs.push({ col: 'rule_type', msg: `The 'rule_type' column is required.` });
      } else {
        ruleTypeNorm = ruleTypeRaw.toLowerCase().replace(/ /g, '_');
        if (!VALID_RULE_TYPES.has(ruleTypeNorm))
          errs.push({ col: 'rule_type', msg: `Invalid rule_type "${ruleTypeRaw}". Valid values: Universal, Body Type, Segment, Make, Model, CC Category.` });
      }

      // category required
      if (!categoryName) errs.push({ col: 'category', msg: `The 'category' column is required for every pricing row.` });

      // conditional required by rule_type
      if (ruleTypeNorm) {
        if (ruleTypeNorm === 'body_type'                         && !bodyTypeName)  errs.push({ col: 'body_type',   msg: `'body_type' is required when rule_type = "Body Type".` });
        if (ruleTypeNorm === 'segment'                           && !segmentName)   errs.push({ col: 'segment',     msg: `'segment' is required when rule_type = "Segment".` });
        if (['make', 'model'].includes(ruleTypeNorm)             && !makeName)      errs.push({ col: 'make',        msg: `'make' is required when rule_type = "Make" or "Model".` });
        if (ruleTypeNorm === 'model'                             && !modelName)     errs.push({ col: 'model',       msg: `'model' is required when rule_type = "Model".` });
        if (ruleTypeNorm === 'cc_category'                       && !ccCategoryName) errs.push({ col: 'cc_category', msg: `'cc_category' is required when rule_type = "CC Category".` });
      }

      // in-file dedup
      const identityKey = IDENTITY_COLS.map(c => (getValue(row, c) || '').toLowerCase()).join('§');
      if (seenIdentities.has(identityKey)) {
        errs.push({ col: 'dimensions', msg: `Duplicate rule: a row with the same dimension combination already appears earlier in this file.` });
      } else {
        seenIdentities.add(identityKey);
      }

      // ── DB reference lookups (only if no structural errors yet) ────────────
      let categoryId = null, serviceId = null, vehicleTypeId = null;
      let makeId = null, modelId = null, bodyTypeId = null, segmentId = null, ccCategoryId = null;

      if (errs.length === 0) {
        // category — must exist
        const catR = await client.query(`SELECT id FROM service_categories WHERE LOWER(name) = LOWER($1)`, [categoryName]);
        if (catR.rows[0]) {
          categoryId = catR.rows[0].id;
        } else {
          errs.push({ col: 'category', msg: `Service category "${categoryName}" does not exist. Please create it first.` });
        }

        // service — must exist inside category
        if (categoryId && serviceName) {
          const svcR = await client.query(
            `SELECT s.id FROM services s WHERE LOWER(s.name) = LOWER($1) AND s.category_id = $2`,
            [serviceName, categoryId]
          );
          if (svcR.rows[0]) {
            serviceId = svcR.rows[0].id;
          } else {
            const anyR = await client.query(
              `SELECT sc.name AS cat_name FROM services s
                 JOIN service_categories sc ON sc.id = s.category_id
                WHERE LOWER(s.name) = LOWER($1) LIMIT 1`,
              [serviceName]
            );
            if (anyR.rows[0]) {
              errs.push({ col: 'service', msg: `Service "${serviceName}" exists but belongs to category "${anyR.rows[0].cat_name}", not "${categoryName}".` });
            } else {
              errs.push({ col: 'service', msg: `Service "${serviceName}" does not exist in category "${categoryName}". Create it first.` });
            }
          }
        }

        // vehicle_type — exact case-insensitive match; must match DB value (e.g. "4W" / "2W")
        if (vehicleTypeName) {
          const vtR = await client.query(`SELECT id FROM vehicle_types WHERE LOWER(name) = LOWER($1)`, [vehicleTypeName]);
          if (vtR.rows[0]) {
            vehicleTypeId = vtR.rows[0].id;
          } else {
            errs.push({ col: 'vehicle_type', msg: `Vehicle type "${vehicleTypeName}" does not exist. Use the exact name stored in your reference data (e.g. "4W" or "2W").` });
          }
        }

        // make — must belong to vehicle_type if provided
        if (makeName) {
          const makeQ = vehicleTypeId
            ? await client.query(`SELECT id FROM vehicle_makes WHERE LOWER(name) = LOWER($1) AND vehicle_type_id = $2`, [makeName, vehicleTypeId])
            : await client.query(`SELECT id FROM vehicle_makes WHERE LOWER(name) = LOWER($1)`, [makeName]);
          if (makeQ.rows[0]) {
            makeId = makeQ.rows[0].id;
          } else {
            const anyMake = await client.query(
              `SELECT vt.name AS type_name FROM vehicle_makes vm
                 JOIN vehicle_types vt ON vt.id = vm.vehicle_type_id
                WHERE LOWER(vm.name) = LOWER($1) LIMIT 1`,
              [makeName]
            );
            if (anyMake.rows[0]) {
              errs.push({ col: 'make', msg: `Make "${makeName}" exists but belongs to vehicle type "${anyMake.rows[0].type_name}", not "${vehicleTypeName}".` });
            } else {
              errs.push({ col: 'make', msg: `Make "${makeName}" does not exist. Please create it first.` });
            }
          }
        }

        // model — must belong to make
        if (modelName) {
          if (!makeId) {
            errs.push({ col: 'make', msg: `'make' is required when 'model' is specified.` });
          } else {
            const modelQ = await client.query(
              `SELECT id FROM vehicle_models WHERE LOWER(name) = LOWER($1) AND make_id = $2`, [modelName, makeId]
            );
            if (modelQ.rows[0]) {
              modelId = modelQ.rows[0].id;
            } else {
              const anyModel = await client.query(
                `SELECT vm.name AS make_name FROM vehicle_models mo
                   JOIN vehicle_makes vm ON vm.id = mo.make_id
                  WHERE LOWER(mo.name) = LOWER($1) LIMIT 1`,
                [modelName]
              );
              if (anyModel.rows[0]) {
                errs.push({ col: 'model', msg: `Model "${modelName}" exists but belongs to make "${anyModel.rows[0].make_name}", not "${makeName}".` });
              } else {
                errs.push({ col: 'model', msg: `Model "${modelName}" does not exist under make "${makeName}".` });
              }
            }
          }
        }

        // body_type
        if (bodyTypeName) {
          const btR = await client.query(`SELECT id FROM body_types WHERE LOWER(name) = LOWER($1)`, [bodyTypeName]);
          if (btR.rows[0]) { bodyTypeId = btR.rows[0].id; }
          else errs.push({ col: 'body_type', msg: `Body type "${bodyTypeName}" does not exist.` });
        }

        // segment
        if (segmentName) {
          const segR = await client.query(`SELECT id FROM segments WHERE LOWER(name) = LOWER($1)`, [segmentName]);
          if (segR.rows[0]) { segmentId = segR.rows[0].id; }
          else errs.push({ col: 'segment', msg: `Segment "${segmentName}" does not exist.` });
        }

        // cc_category
        if (ccCategoryName) {
          const ccR = await client.query(`SELECT id FROM cc_categories WHERE LOWER(name) = LOWER($1)`, [ccCategoryName]);
          if (ccR.rows[0]) { ccCategoryId = ccR.rows[0].id; }
          else errs.push({ col: 'cc_category', msg: `CC category "${ccCategoryName}" does not exist.` });
        }
      }

      if (errs.length) {
        for (const e of errs) {
          rowErrors.push({
            row:     rowNum,
            column:  e.col,
            code:    'VALIDATION_ERROR',
            message: e.msg,
            rowData: `${categoryName || ''}${serviceName ? ' / ' + serviceName : ''}`,
          });
        }
      } else {
        const isActive = (!isActiveRaw || isActiveRaw === '')
          ? true
          : ['true', '1', 'yes'].includes(isActiveRaw.toLowerCase());
        parsedRows.push({
          categoryId, serviceId, vehicleTypeId, bodyTypeId,
          segmentId, makeId, modelId, ccCategoryId,
          price, isActive,
          // for pricing_config dimension tracking
          vehicleTypeName, bodyTypeName, segmentName, makeName, ccCategoryName,
        });
      }
    }

    // ── If ANY row has errors → reject everything ────────────────────────────
    if (rowErrors.length) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        success:      false,
        error:        `Validation failed — ${rowErrors.length} error(s) found. No pricing rules have been imported.`,
        code:         'VALIDATION_FAILED',
        errorCount:   rowErrors.length,
        skippedBlanks,
        warnings:     extra.length ? [`Unrecognised column(s) ignored: ${extra.map(c => `'${c}'`).join(', ')}`] : [],
        errors:       rowErrors,
      });
    }

    // ── Pass 2: upsert all valid rows ────────────────────────────────────────
    let inserted = 0, updated = 0, unchanged = 0;
    const categoryDimsMap = new Map();

    for (const r of parsedRows) {
      // Track dimension keys per category for pricing_config merge
      const dims = categoryDimsMap.get(r.categoryId) || new Set();
      if (r.vehicleTypeName) dims.add('vehicle_type');
      if (r.bodyTypeName)    dims.add('body_type');
      if (r.segmentName)     dims.add('segment');
      if (r.makeName || r.modelId) dims.add('make');
      if (r.ccCategoryName)  dims.add('cc_category');
      categoryDimsMap.set(r.categoryId, dims);

      const dbServiceId  = r.serviceId;
      const dbCategoryId = r.serviceId ? null : r.categoryId;

      const existing = await client.query(
        `SELECT id, price, is_active FROM pricing
          WHERE (service_id      = $1  OR ($1  IS NULL AND service_id      IS NULL))
            AND (category_id     = $2  OR ($2  IS NULL AND category_id     IS NULL))
            AND (vehicle_type_id = $3  OR ($3  IS NULL AND vehicle_type_id IS NULL))
            AND (body_type_id    = $4  OR ($4  IS NULL AND body_type_id    IS NULL))
            AND (segment_id      = $5  OR ($5  IS NULL AND segment_id      IS NULL))
            AND (make_id         = $6  OR ($6  IS NULL AND make_id         IS NULL))
            AND (model_id        = $7  OR ($7  IS NULL AND model_id        IS NULL))
            AND (cc_category_id  = $8  OR ($8  IS NULL AND cc_category_id  IS NULL))`,
        [dbServiceId, dbCategoryId, r.vehicleTypeId, r.bodyTypeId, r.segmentId, r.makeId, r.modelId, r.ccCategoryId]
      );

      if (existing.rows.length > 0) {
        const { id: ruleId, price: currentPrice, is_active: currentActive } = existing.rows[0];
        const priceChanged  = Math.abs(Number(currentPrice) - r.price) > 0.001;
        const activeChanged = currentActive !== r.isActive;
        if (priceChanged || activeChanged) {
          await client.query(
            `UPDATE pricing SET price = $1, is_active = $2, updated_at = NOW() WHERE id = $3`,
            [r.price, r.isActive, ruleId]
          );
          updated++;
        } else {
          unchanged++;
        }
      } else {
        await client.query(
          `INSERT INTO pricing
             (service_id, category_id, vehicle_type_id, body_type_id, segment_id,
              make_id, model_id, cc_category_id, price, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [dbServiceId, dbCategoryId, r.vehicleTypeId, r.bodyTypeId, r.segmentId,
           r.makeId, r.modelId, r.ccCategoryId, r.price, r.isActive]
        );
        inserted++;
      }
    }

    // Merge detected dimensions into pricing_config (add only, never remove)
    for (const [catId, newDims] of categoryDimsMap) {
      if (newDims.size === 0) continue;
      const catRow = await client.query(`SELECT pricing_config FROM service_categories WHERE id = $1`, [catId]);
      const existingDims = Array.isArray(catRow.rows[0]?.pricing_config) ? catRow.rows[0].pricing_config : [];
      const merged = [...new Set([...existingDims, ...newDims])];
      await client.query(`UPDATE service_categories SET pricing_config = $1 WHERE id = $2`, [JSON.stringify(merged), catId]);
    }

    await client.query('COMMIT');

    const colWarnings = extra.length ? [`Unrecognised column(s) ignored: ${extra.map(c => `'${c}'`).join(', ')}`] : [];
    const parts = [];
    if (inserted  > 0) parts.push(`${inserted} inserted`);
    if (updated   > 0) parts.push(`${updated} updated`);
    if (unchanged > 0) parts.push(`${unchanged} unchanged`);

    return res.json({
      success:     true,
      message:     parts.length ? `Upload complete: ${parts.join(', ')}.` : 'No changes — all records already matched the database.',
      inserted, updated, unchanged, skippedBlanks,
      warnings:    colWarnings,
      rowWarnings: [],
    });

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

// kept for reference — no longer called directly (importPricing is standalone)
async function upsertPricing(client, rows, getValue) {
  let inserted = 0, updated = 0, unchanged = 0;

  // Track which dimension keys are used per category across all rows.
  // After the upsert loop we merge these into pricing_config so the
  // Configure Dimensions modal reflects what was uploaded.
  // Key: categoryId (number), Value: Set<string> of dimension keys
  const categoryDimsMap = new Map();

  // ── Generic lookup — throws a friendly "please create first" error ─────────
  async function requireId(table, nameCol, name, friendlyLabel) {
    if (!name) return null;
    const r = await client.query(
      `SELECT id FROM ${table} WHERE LOWER(${nameCol}) = LOWER($1)`, [name]
    );
    if (!r.rows[0]) {
      const err = new Error(
        `${friendlyLabel} "${name}" does not exist. ` +
        `Please create it first before uploading pricing rules that reference it.`
      );
      err.status = 422;
      throw err;
    }
    return r.rows[0].id;
  }

  for (const row of rows) {
    const categoryName    = getValue(row, 'category')     || null;
    const serviceName     = getValue(row, 'service')      || null;
    const priceStr        = getValue(row, 'price');
    const ruleType        = getValue(row, 'rule_type').toLowerCase();
    const vehicleTypeName = getValue(row, 'vehicle_type') || null;
    const bodyTypeName    = getValue(row, 'body_type')    || null;
    const segmentName     = getValue(row, 'segment')      || null;
    const makeName        = getValue(row, 'make')         || null;
    const modelName       = getValue(row, 'model')        || null;
    const ccCategoryName  = getValue(row, 'cc_category')  || null;
    const isActiveRaw     = getValue(row, 'is_active');

    // ── Must have at least category ────────────────────────────────────────
    if (!categoryName) {
      throw Object.assign(
        new Error(`The 'category' column is required for every pricing row. Please provide a category name.`),
        { status: 422 }
      );
    }

    // ── Price validation ───────────────────────────────────────────────────
    const price = parseFloat(priceStr);
    if (isNaN(price) || price <= 0) {
      throw Object.assign(
        new Error(`Invalid price "${priceStr}" — must be a positive number.`),
        { status: 422 }
      );
    }

    // ── is_active ──────────────────────────────────────────────────────────
    const isActive = isActiveRaw === '' || isActiveRaw === undefined
      ? true
      : ['true', '1', 'yes'].includes(isActiveRaw.toLowerCase());

    // ── Validate conditional required fields by rule_type ──────────────────
    const rt = ruleType.replace(/ /g, '_');
    if (rt === 'body_type' && !bodyTypeName)
      throw Object.assign(new Error(`'body_type' column is required when rule_type = "Body Type".`), { status: 422 });
    if (rt === 'segment' && !segmentName)
      throw Object.assign(new Error(`'segment' column is required when rule_type = "Segment".`), { status: 422 });
    if (['make', 'model'].includes(rt) && !makeName)
      throw Object.assign(new Error(`'make' column is required when rule_type = "Make" or "Model".`), { status: 422 });
    if (rt === 'model' && !modelName)
      throw Object.assign(new Error(`'model' column is required when rule_type = "Model".`), { status: 422 });
    if (rt === 'cc_category' && !ccCategoryName)
      throw Object.assign(new Error(`'cc_category' column is required when rule_type = "CC Category".`), { status: 422 });

    // ── Resolve category — must exist ──────────────────────────────────────
    const categoryId = await requireId(
      'service_categories', 'name', categoryName,
      'Service category'
    );

    // ── Resolve service (if provided — must exist INSIDE the category) ─────
    let serviceId = null;
    if (serviceName) {
      const svcR = await client.query(
        `SELECT s.id FROM services s
          WHERE LOWER(s.name) = LOWER($1)
            AND s.category_id = $2`,
        [serviceName, categoryId]
      );
      if (!svcR.rows[0]) {
        // Give a more helpful message: check if the service exists in a different category
        const anyR = await client.query(
          `SELECT sc.name AS cat_name FROM services s
            JOIN service_categories sc ON sc.id = s.category_id
           WHERE LOWER(s.name) = LOWER($1)
           LIMIT 1`,
          [serviceName]
        );
        if (anyR.rows[0]) {
          throw Object.assign(new Error(
            `Service "${serviceName}" exists but belongs to category "${anyR.rows[0].cat_name}", ` +
            `not "${categoryName}". Please check the category name or move the service first.`
          ), { status: 422 });
        } else {
          throw Object.assign(new Error(
            `Service "${serviceName}" does not exist inside category "${categoryName}". ` +
            `Please create this service first under the correct category before uploading pricing rules.`
          ), { status: 422 });
        }
      }
      serviceId = svcR.rows[0].id;
    }
    // serviceId=null + categoryId set → category-level rule (valid)

    // ── Resolve vehicle dimensions — all must already exist ────────────────
    const vehicleTypeId = await requireId('vehicle_types', 'name', vehicleTypeName, 'Vehicle type');

    // Resolve make (must belong to vehicle_type if both provided)
    let makeId = null;
    if (makeName) {
      const makeQ = vehicleTypeId
        ? await client.query(
            `SELECT id FROM vehicle_makes WHERE LOWER(name) = LOWER($1) AND vehicle_type_id = $2`,
            [makeName, vehicleTypeId]
          )
        : await client.query(
            `SELECT id FROM vehicle_makes WHERE LOWER(name) = LOWER($1)`,
            [makeName]
          );
      if (!makeQ.rows[0]) {
        // Check if make exists under a different vehicle type
        const anyMake = await client.query(
          `SELECT vt.name AS type_name FROM vehicle_makes vm
            JOIN vehicle_types vt ON vt.id = vm.vehicle_type_id
           WHERE LOWER(vm.name) = LOWER($1) LIMIT 1`,
          [makeName]
        );
        if (anyMake.rows[0]) {
          throw Object.assign(new Error(
            `Make "${makeName}" exists but belongs to vehicle type "${anyMake.rows[0].type_name}", ` +
            `not "${vehicleTypeName}". Please check the vehicle_type column.`
          ), { status: 422 });
        } else {
          throw Object.assign(new Error(
            `Make "${makeName}" does not exist. ` +
            `Please create this make first before uploading pricing rules that reference it.`
          ), { status: 422 });
        }
      }
      makeId = makeQ.rows[0].id;
    }

    // Resolve model (must belong to make)
    let modelId = null;
    if (modelName) {
      if (!makeId) throw Object.assign(
        new Error(`'make' column is required when 'model' is specified.`),
        { status: 422 }
      );
      const modelQ = await client.query(
        `SELECT id FROM vehicle_models WHERE LOWER(name) = LOWER($1) AND make_id = $2`,
        [modelName, makeId]
      );
      if (!modelQ.rows[0]) {
        // Check if model exists under a different make
        const anyModel = await client.query(
          `SELECT vm.name AS make_name FROM vehicle_models mo
            JOIN vehicle_makes vm ON vm.id = mo.make_id
           WHERE LOWER(mo.name) = LOWER($1) LIMIT 1`,
          [modelName]
        );
        if (anyModel.rows[0]) {
          throw Object.assign(new Error(
            `Model "${modelName}" exists but belongs to make "${anyModel.rows[0].make_name}", ` +
            `not "${makeName}". Please check the make column.`
          ), { status: 422 });
        } else {
          throw Object.assign(new Error(
            `Model "${modelName}" does not exist under make "${makeName}". ` +
            `Please create this model first before uploading pricing rules that reference it.`
          ), { status: 422 });
        }
      }
      modelId = modelQ.rows[0].id;
    }

    const bodyTypeId = bodyTypeName
      ? await requireId('body_types', 'name', bodyTypeName, 'Body type')
      : null;

    const segmentId = segmentName
      ? await requireId('segments', 'name', segmentName, 'Segment')
      : null;

    const ccCategoryId = ccCategoryName
      ? await requireId('cc_categories', 'name', ccCategoryName, 'CC category')
      : null;

    // ── Track dimension keys used for this category ───────────────────────────
    // We always attribute dimensions to the resolved categoryId (regardless of
    // whether this is a service-level or category-level rule), because
    // pricing_config lives on the category, not the individual service.
    {
      const dims = categoryDimsMap.get(categoryId) || new Set();
      if (vehicleTypeName) dims.add('vehicle_type');
      if (bodyTypeName)    dims.add('body_type');
      if (segmentName)     dims.add('segment');
      if (makeName || modelName) dims.add('make');
      if (ccCategoryName)  dims.add('cc_category');
      categoryDimsMap.set(categoryId, dims);
    }

    // ── DB target IDs — exactly one of these is non-null (enforced by constraint) ─
    // categoryId was resolved above for validation only (to confirm service belongs
    // to that category). For service-level rules the DB stores service_id + NULL
    // category_id. For category-level rules it's NULL service_id + category_id.
    const dbServiceId  = serviceId;                    // non-null → service-level rule
    const dbCategoryId = serviceId ? null : categoryId; // null when service-level

    // ── Upsert — match on the stored target IDs + all vehicle dimensions ───────
    const existing = await client.query(
      `SELECT id, price, is_active FROM pricing
        WHERE (service_id  = $1  OR ($1  IS NULL AND service_id  IS NULL))
          AND (category_id = $2  OR ($2  IS NULL AND category_id IS NULL))
          AND (vehicle_type_id = $3 OR ($3 IS NULL AND vehicle_type_id IS NULL))
          AND (body_type_id    = $4 OR ($4 IS NULL AND body_type_id    IS NULL))
          AND (segment_id      = $5 OR ($5 IS NULL AND segment_id      IS NULL))
          AND (make_id         = $6 OR ($6 IS NULL AND make_id         IS NULL))
          AND (model_id        = $7 OR ($7 IS NULL AND model_id        IS NULL))
          AND (cc_category_id  = $8 OR ($8 IS NULL AND cc_category_id  IS NULL))`,
      [dbServiceId, dbCategoryId, vehicleTypeId, bodyTypeId, segmentId, makeId, modelId, ccCategoryId]
    );

    if (existing.rows.length > 0) {
      const { id: ruleId, price: currentPrice, is_active: currentActive } = existing.rows[0];
      const priceChanged    = Math.abs(Number(currentPrice) - price) > 0.001;
      const isActiveChanged = currentActive !== isActive;

      if (priceChanged || isActiveChanged) {
        await client.query(
          `UPDATE pricing SET price = $1, is_active = $2, updated_at = NOW() WHERE id = $3`,
          [price, isActive, ruleId]
        );
        updated++;
      } else {
        unchanged++;
      }
    } else {
      await client.query(
        `INSERT INTO pricing
           (service_id, category_id, vehicle_type_id, body_type_id, segment_id, make_id, model_id, cc_category_id, price, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [dbServiceId, dbCategoryId, vehicleTypeId, bodyTypeId, segmentId, makeId, modelId, ccCategoryId, price, isActive]
      );
      inserted++;
    }
  }

  // ── Merge detected dimensions into pricing_config for each touched category ─
  // We only ADD keys; we never remove keys that were already configured manually.
  // This means uploading Segment rows for AC won't clear a pre-existing Body Type config.
  for (const [catId, newDims] of categoryDimsMap) {
    if (newDims.size === 0) continue;
    const catRow = await client.query(
      `SELECT pricing_config FROM service_categories WHERE id = $1`,
      [catId]
    );
    const existing = Array.isArray(catRow.rows[0]?.pricing_config)
      ? catRow.rows[0].pricing_config
      : [];
    const merged = [...new Set([...existing, ...newDims])];
    await client.query(
      `UPDATE service_categories SET pricing_config = $1 WHERE id = $2`,
      [JSON.stringify(merged), catId]
    );
  }

  return { inserted, updated, unchanged };
}

// ── LEADS ─────────────────────────────────────────────────────────────────────
//  Only mobile is required.
//  All reference fields (status, make, model, etc.) are looked up by name.
//  If not found → row warning (NOT an error); lead is still inserted with
//  every other valid field.
//  Each CSV row always creates a NEW lead — no upsert.
//
async function importLeads(req, res, next) {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded.', code: 'NO_FILE' });
  }

  // ── 1. Parse ────────────────────────────────────────────────────────────────
  let rows;
  try { rows = parseUploadedFile(req.file); }
  catch (err) {
    return res.status(400).json({ success: false, error: err.userMessage || err.message, code: err.code || 'PARSE_ERROR' });
  }

  if (!rows.length) {
    return res.status(400).json({ success: false, error: 'The uploaded file is empty.', code: 'EMPTY_FILE' });
  }

  // ── 2. Column map (case-insensitive) ────────────────────────────────────────
  const KNOWN_COLS = ['mobile','name','whatsapp','state','city','area',
                      'vehicle_type','make','model','lead_source','status',
                      'assigned_to','notes','services','categories'];
  const { missing, extra, getValue } = analyseColumns(rows, ['mobile'], KNOWN_COLS.filter(c => c !== 'mobile'));

  if (missing.length) {
    return res.status(400).json({
      success: false,
      error:  `Missing required column: 'mobile'. Please check your file.`,
      code:   'MISSING_COLUMN',
    });
  }

  // ── 3. First pass — validate ALL rows, collect errors ───────────────────────
  // We do NOT insert anything until every row is checked.
  // Reference fields (status, vehicle_type, make, model, state, city, area,
  // assigned_to, services, categories) must exist in the DB exactly as typed
  // (case-insensitive). A mismatch = row error → nothing is uploaded.

  const rowErrors    = [];  // { row, column, code, message, rowData }
  const rowWarnings  = [];  // { row, message } — soft warnings, import still proceeds
  const parsedRows   = [];  // successfully validated rows ready to insert
  let   skippedBlanks = 0;

  const client = await pool.connect();
  try {
    // Use a read-only transaction for the validation pass
    await client.query('BEGIN');

    for (let i = 0; i < rows.length; i++) {
      const row    = rows[i];
      const rowNum = i + 2;

      // Skip fully blank rows silently
      const allEmpty = KNOWN_COLS.every(col => !getValue(row, col));
      if (allEmpty) { skippedBlanks++; continue; }

      const errs = [];  // errors for this row

      // ── mobile (only hard-required field) ──────────────────────────────────
      const rawMobile = getValue(row, 'mobile');
      const mobile    = normaliseMobile(rawMobile);
      if (!mobile || mobile.length < 7) {
        errs.push({ col: 'mobile', msg: `mobile "${rawMobile || '(blank)'}" is invalid or missing.` });
      }

      // ── plain-text fields (no lookup needed) ───────────────────────────────
      const name    = getValue(row, 'name')         || null;
      const whatsapp= normaliseMobile(getValue(row, 'whatsapp')) || null;
      const leadSrc = getValue(row, 'lead_source')  || null;
      const notes   = getValue(row, 'notes')        || null;

      // ── status ─────────────────────────────────────────────────────────────
      let statusName = null;
      const statusRaw = getValue(row, 'status');
      if (statusRaw) {
        const sr = await client.query(
          `SELECT name FROM lead_statuses WHERE LOWER(name) = LOWER($1) AND is_active = TRUE`, [statusRaw]
        );
        if (sr.rows[0]) statusName = sr.rows[0].name;
        else errs.push({ col: 'status', msg: `Status "${statusRaw}" does not exist in Lead Statuses.` });
      }

      // ── location: state → city → area ──────────────────────────────────────
      let stateId = null, cityId = null, areaId = null;
      const stateRaw = getValue(row, 'state');
      const cityRaw  = getValue(row, 'city');
      const areaRaw  = getValue(row, 'area');

      if (stateRaw) {
        const sr = await client.query(`SELECT id FROM states WHERE LOWER(name) = LOWER($1)`, [stateRaw]);
        if (sr.rows[0]) {
          stateId = sr.rows[0].id;
          if (cityRaw) {
            const cr = await client.query(
              `SELECT id FROM cities WHERE state_id = $1 AND LOWER(name) = LOWER($2)`, [stateId, cityRaw]
            );
            if (cr.rows[0]) {
              cityId = cr.rows[0].id;
              if (areaRaw) {
                const ar = await client.query(
                  `SELECT id FROM areas WHERE city_id = $1 AND LOWER(name) = LOWER($2)`, [cityId, areaRaw]
                );
                if (ar.rows[0]) areaId = ar.rows[0].id;
                else errs.push({ col: 'area', msg: `Area "${areaRaw}" does not exist in ${cityRaw}, ${stateRaw}.` });
              }
            } else {
              errs.push({ col: 'city', msg: `City "${cityRaw}" does not exist in ${stateRaw}.` });
            }
          }
        } else {
          errs.push({ col: 'state', msg: `State "${stateRaw}" does not exist.` });
        }
      }

      // ── vehicle: type → make → model ───────────────────────────────────────
      // Exact case-insensitive match only.
      // Make / model not found → soft warning (lead still imports, note appended).
      // Vehicle type not found → hard error (can't classify lead at all).
      let vehicleTypeId = null, makeId = null, modelId = null, bodyTypeId = null, ccCategoryId = null, segmentId = null;
      let vehicleNote   = null; // appended to notes when make/model can't be resolved
      const vtRaw    = getValue(row, 'vehicle_type');
      const makeRaw  = getValue(row, 'make');
      const modelRaw = getValue(row, 'model');

      if (vtRaw) {
        const vtr = await client.query(
          `SELECT id FROM vehicle_types WHERE LOWER(name) = LOWER($1) AND is_active = TRUE`, [vtRaw]
        );
        if (vtr.rows[0]) {
          vehicleTypeId = vtr.rows[0].id;
          if (makeRaw) {
            const mkr = await client.query(
              `SELECT id FROM vehicle_makes WHERE vehicle_type_id = $1 AND LOWER(name) = LOWER($2)`,
              [vehicleTypeId, makeRaw]
            );
            if (mkr.rows[0]) {
              makeId = mkr.rows[0].id;
              if (modelRaw) {
                const mdr = await client.query(
                  `SELECT id, body_type_id, cc_category_id, segment_id FROM vehicle_models WHERE make_id = $1 AND LOWER(name) = LOWER($2)`,
                  [makeId, modelRaw]
                );
                if (mdr.rows[0]) {
                  modelId      = mdr.rows[0].id;
                  bodyTypeId   = mdr.rows[0].body_type_id   || null;
                  ccCategoryId = mdr.rows[0].cc_category_id || null;
                  segmentId    = mdr.rows[0].segment_id     || null;
                } else {
                  // Model not in master — soft warning, import without model
                  makeId = null; // clear make too so lead has no partial vehicle data
                  vehicleNote = `[Vehicle not in master: "${makeRaw} ${modelRaw}" — add this make & model to the Vehicle Master so correct pricing and services can be matched]`;
                  rowWarnings.push({ row: rowNum, message: `Row ${rowNum}: Model "${modelRaw}" not found under "${makeRaw}" in Vehicle Master. Lead imported without vehicle data.` });
                }
              }
            } else {
              // Make not in master — soft warning
              vehicleNote = `[Vehicle not in master: "${makeRaw}${modelRaw ? ' ' + modelRaw : ''}" — add this make${modelRaw ? ' & model' : ''} to the Vehicle Master so correct pricing and services can be matched]`;
              rowWarnings.push({ row: rowNum, message: `Row ${rowNum}: Make "${makeRaw}" not found in Vehicle Master. Lead imported without vehicle data.` });
              vehicleTypeId = null; // clear vehicle type too — no partial data
            }
          }
        } else {
          errs.push({ col: 'vehicle_type', msg: `Vehicle type "${vtRaw}" does not exist. Check your reference data.` });
        }
      } else if (makeRaw) {
        // make provided without vehicle_type — look across all types
        const mkr = await client.query(
          `SELECT id FROM vehicle_makes WHERE LOWER(name) = LOWER($1) LIMIT 1`, [makeRaw]
        );
        if (mkr.rows[0]) {
          makeId = mkr.rows[0].id;
          if (modelRaw) {
            const mdr = await client.query(
              `SELECT id, body_type_id, cc_category_id, segment_id FROM vehicle_models WHERE make_id = $1 AND LOWER(name) = LOWER($2)`,
              [makeId, modelRaw]
            );
            if (mdr.rows[0]) {
              modelId      = mdr.rows[0].id;
              bodyTypeId   = mdr.rows[0].body_type_id   || null;
              ccCategoryId = mdr.rows[0].cc_category_id || null;
              segmentId    = mdr.rows[0].segment_id     || null;
            } else {
              makeId = null;
              vehicleNote = `[Vehicle not in master: "${makeRaw} ${modelRaw}" — add this make & model to the Vehicle Master so correct pricing and services can be matched]`;
              rowWarnings.push({ row: rowNum, message: `Row ${rowNum}: Model "${modelRaw}" not found under "${makeRaw}" in Vehicle Master. Lead imported without vehicle data.` });
            }
          }
        } else {
          vehicleNote = `[Vehicle not in master: "${makeRaw}${modelRaw ? ' ' + modelRaw : ''}" — add this make${modelRaw ? ' & model' : ''} to the Vehicle Master so correct pricing and services can be matched]`;
          rowWarnings.push({ row: rowNum, message: `Row ${rowNum}: Make "${makeRaw}" not found in Vehicle Master. Lead imported without vehicle data.` });
        }
      }

      // ── Soft warning: 2W model found but cc_category missing in Vehicle Master ─
      const vtIs2W = /2.?w|two.?wheel/i.test(vtRaw || '');
      if (vtIs2W && modelId && !ccCategoryId) {
        rowWarnings.push({
          row:     rowNum,
          message: `Row ${rowNum}: "${makeRaw} ${modelRaw}" is in the Vehicle Master but engine CC category is not configured — service pricing for this 2W may not match correctly. Please update the Vehicle Master.`,
        });
      }

      // ── assigned_to ────────────────────────────────────────────────────────
      let assignedTo = null;
      const assigneeRaw = getValue(row, 'assigned_to');
      if (assigneeRaw) {
        const ur = await client.query(
          `SELECT id FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(name) = LOWER($1) LIMIT 1`,
          [assigneeRaw]
        );
        if (ur.rows[0]) assignedTo = ur.rows[0].id;
        else errs.push({ col: 'assigned_to', msg: `User "${assigneeRaw}" does not exist.` });
      }

      // ── services (semicolon-separated) ────────────────────────────────────
      const serviceIds = [];
      const servicesRaw = getValue(row, 'services');
      if (servicesRaw) {
        for (const svcName of servicesRaw.split(';').map(s => s.trim()).filter(Boolean)) {
          const sr = await client.query(
            `SELECT id FROM services WHERE LOWER(name) = LOWER($1) AND is_active = TRUE LIMIT 1`, [svcName]
          );
          if (sr.rows[0]) serviceIds.push(sr.rows[0].id);
          else errs.push({ col: 'services', msg: `Service "${svcName}" does not exist.` });
        }
      }

      // ── categories (semicolon-separated) ─────────────────────────────────
      const categoryIds = [];
      const catsRaw = getValue(row, 'categories');
      if (catsRaw) {
        for (const catName of catsRaw.split(';').map(s => s.trim()).filter(Boolean)) {
          const cr = await client.query(
            `SELECT id FROM service_categories WHERE LOWER(name) = LOWER($1)`, [catName]
          );
          if (cr.rows[0]) categoryIds.push(cr.rows[0].id);
          else errs.push({ col: 'categories', msg: `Service category "${catName}" does not exist.` });
        }
      }

      // ── Collect or store ───────────────────────────────────────────────────
      if (errs.length) {
        for (const e of errs) {
          rowErrors.push({
            row:     rowNum,
            column:  e.col,
            code:    'REFERENCE_NOT_FOUND',
            message: e.msg,
            rowData: mobile || rawMobile || '',
          });
        }
      } else {
        let action = 'insert';
        let existingLeadId = null;
        let isMergedInFile = false;

        // 1. In-file duplicate check: check if an earlier row in the same batch has the same mobile and same vehicle_type
        const matchInFile = parsedRows.find(
          r => r.mobile === mobile && r.vehicleTypeId === vehicleTypeId
        );
        if (matchInFile) {
          matchInFile.statusName = statusName || null;
          isMergedInFile = true;
        } else {
          // 2. Database duplicate check: query existing leads with the same mobile
          const dupRes = await client.query(
            `SELECT l.id, l.vehicle_type_id,
                    (EXISTS (SELECT 1 FROM appointments a WHERE a.lead_id = l.id) OR ls.converts_to_appointment = TRUE OR ls.is_locked = TRUE) AS is_closed
               FROM leads l
               LEFT JOIN lead_statuses ls ON LOWER(ls.name) = LOWER(l.status)
              WHERE l.mobile = $1`,
            [mobile]
          );
          if (dupRes.rows.length > 0) {
            const matchInDb = dupRes.rows.find(el => el.vehicle_type_id === vehicleTypeId && !el.is_closed);
            if (matchInDb) {
              action = 'update_status';
              existingLeadId = matchInDb.id;
            }
          }
        }

        if (isMergedInFile) {
          // Skip inserting duplicate row, it is merged in-file
        } else {
          parsedRows.push({ rowNum, mobile, name, whatsapp, leadSrc, notes, vehicleNote, statusName, stateId, cityId, areaId, vehicleTypeId, makeId, modelId, bodyTypeId, segmentId, assignedTo, serviceIds, categoryIds, action, existingLeadId });
        }
      }
    }

    // ── If ANY row has errors → rollback, return all errors, insert nothing ─
    if (rowErrors.length) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        success:      false,
        error:        `Validation failed — ${rowErrors.length} error(s) found. No leads have been imported.`,
        code:         'VALIDATION_FAILED',
        errorCount:   rowErrors.length,
        skippedBlanks,
        warnings:     [],
        errors:       rowErrors,
      });
    }

    // ── All rows valid — insert or update everything ─────────────────────────
    const createdBy = req.user?.id || null;
    let inserted = 0;
    let updated  = 0;

    // ── Batched writes ───────────────────────────────────────────────────────
    // Previously this looped one INSERT/UPDATE per row (plus one price SELECT
    // and one INSERT per lead-service) — ~4–6 round trips per lead. Now:
    // a handful of multi-row statements, chunked to keep each statement's
    // parameter count well under Postgres's 65,535 limit and locks short.
    const chunk = (arr, n) => {
      const out = [];
      for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
      return out;
    };

    const toUpdate = parsedRows.filter(r => r.action === 'update_status');
    const toInsert = parsedRows.filter(r => r.action !== 'update_status');

    // 1) Status updates — one statement per chunk via VALUES join,
    //    plus one ANY() statement to close pending follow-ups.
    for (const batch of chunk(toUpdate, 500)) {
      const values = [];
      const params = [];
      batch.forEach((r, i) => {
        params.push(r.existingLeadId, r.statusName || null);
        values.push(`($${i * 2 + 1}::int, $${i * 2 + 2}::text)`);
      });
      await client.query(
        `UPDATE leads AS l SET status = v.status
           FROM (VALUES ${values.join(',')}) AS v(id, status)
          WHERE l.id = v.id`,
        params
      );
      /* auto_closed = TRUE, and this is the site that made the reports lie
         loudest. An import updating 400 statuses closes 400 follow-ups in one
         statement; without this flag every one of them was booked as a
         completed follow-up, on_time for any not yet due, and attributed to
         whoever happened to be assigned to the lead. */
      await client.query(
        `UPDATE lead_events SET is_done = TRUE, done_at = NOW(), auto_closed = TRUE
          WHERE lead_id = ANY($1) AND is_done = FALSE`,
        [batch.map(r => r.existingLeadId)]
      );
    }
    updated = toUpdate.length;

    // 2) Pre-fetch service prices ONCE for all distinct services in the file
    //    (was: one SELECT per service per lead).
    const allServiceIds = [...new Set(toInsert.flatMap(r => r.serviceIds))];
    const priceBySvc = new Map();
    if (allServiceIds.length) {
      const pr = await client.query(
        `SELECT DISTINCT ON (service_id) service_id, price
           FROM pricing WHERE service_id = ANY($1)
          ORDER BY service_id, id`,
        [allServiceIds]
      );
      for (const row of pr.rows) priceBySvc.set(row.service_id, row.price);
    }

    // 3) Lead inserts — multi-row VALUES with RETURNING id. Postgres returns
    //    RETURNING rows in insert order for a plain VALUES insert, so ids map
    //    back to the batch by index. 200 rows × 17 params = 3,400 params/stmt.
    //
    //    ── public_token is the 17th, and it was missing until now ──────────
    //
    //    Every other INSERT INTO leads in this codebase supplies one
    //    (leads.controller.js, waInboundLead.service.js). This one did not, so
    //    EVERY lead ever created by Bulk Upload had a null token — and the
    //    frontend routes detail pages by token, so clicking one produced the
    //    URL /leads/null, a 404 from /api/leads/by-token/null, and a record
    //    that could not be linked to or reopened by refreshing.
    //
    //    It stayed invisible because the record still OPENS on click: the
    //    numeric id travels separately. Only the URL was broken.
    //
    //    Generated per row rather than once per batch — a shared token would
    //    violate the unique index on the second row of the very first import.
    const svcRows = []; // [leadId, serviceId, price]
    const catRows = []; // [leadId, categoryId]
    const COLS = 17;
    for (const batch of chunk(toInsert, 200)) {
      const values = [];
      const params = [];
      batch.forEach((r, i) => {
        const base = i * COLS;
        params.push(
          r.name, r.mobile, r.whatsapp,
          r.stateId, r.cityId, r.areaId,
          r.vehicleTypeId, r.makeId, r.modelId, r.bodyTypeId,
          r.segmentId ? [r.segmentId] : [],
          r.leadSrc,
          r.statusName || null,
          r.vehicleNote
            ? [r.notes, r.vehicleNote].filter(Boolean).join('\n')
            : (r.notes || null),
          r.assignedTo, createdBy, generatePublicToken()
        );
        values.push(`(${Array.from({ length: COLS }, (_, j) => `$${base + j + 1}`).join(',')})`);
      });
      const ins = await client.query(
        `INSERT INTO leads
           (name, mobile, whatsapp, state_id, city_id, area_id,
            vehicle_type_id, make_id, model_id, body_type_id, segment_ids, lead_source, status, notes,
            assigned_to, created_by, public_token)
         VALUES ${values.join(',')}
         RETURNING id`,
        params
      );
      ins.rows.forEach((row, i) => {
        const r = batch[i];
        for (const svcId of r.serviceIds) svcRows.push([row.id, svcId, priceBySvc.get(svcId) || 0]);
        for (const catId of r.categoryIds) catRows.push([row.id, catId]);
      });
    }
    inserted = toInsert.length;

    // 4) Lead services + categories — multi-row inserts, chunked.
    for (const batch of chunk(svcRows, 1000)) {
      const values = batch.map((_, i) => `($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3})`).join(',');
      await client.query(
        `INSERT INTO lead_services (lead_id, service_id, price) VALUES ${values} ON CONFLICT DO NOTHING`,
        batch.flat()
      );
    }
    for (const batch of chunk(catRows, 1000)) {
      const values = batch.map((_, i) => `($${i * 2 + 1},$${i * 2 + 2})`).join(',');
      await client.query(
        `INSERT INTO lead_categories (lead_id, category_id) VALUES ${values} ON CONFLICT DO NOTHING`,
        batch.flat()
      );
    }

    await client.query('COMMIT');

    const colWarnings = extra.length
      ? [`Unrecognised column(s) ignored: ${extra.map(c => `'${c}'`).join(', ')}`]
      : [];

    return res.json({
      success:      true,
      message:      `Upload complete: ${inserted} lead(s) imported, ${updated} lead(s) updated.`,
      inserted,
      updated,
      unchanged:    0,
      skippedBlanks,
      warnings:     colWarnings,
      rowWarnings,
    });

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

// ── PARTS ─────────────────────────────────────────────────────────────────────
//  Identity:  name (case-insensitive)
//  Updatable: category, vehicle_type, gst_percent, hsn_code
//  vehicle_type: '2W', '4W', 'both', or blank (stored as NULL)
//
const VALID_PART_VEHICLE_TYPES = new Set(['2w', '4w', 'both']);

async function upsertParts(client, rows, getValue) {
  let inserted = 0, updated = 0, unchanged = 0;

  // Pre-validate vehicle_type for all rows before any DB work
  const vtErrors = [];
  for (let i = 0; i < rows.length; i++) {
    const vtRaw = (getValue(rows[i], 'vehicle_type') || '').toLowerCase().trim();
    if (vtRaw !== '' && !VALID_PART_VEHICLE_TYPES.has(vtRaw)) {
      vtErrors.push({
        row:     i + 2,
        column:  'vehicle_type',
        code:    'INVALID_VALUE',
        message: `Invalid vehicle_type "${getValue(rows[i], 'vehicle_type')}" for part "${getValue(rows[i], 'name')}". Allowed values: 2W, 4W, both (or leave blank).`,
        rowData: getValue(rows[i], 'name') || '',
      });
    }
  }
  if (vtErrors.length) {
    const err = new Error(`${vtErrors.length} invalid vehicle_type value(s) found. No parts have been imported.`);
    err.status = 422;
    err.errors = vtErrors;
    throw err;
  }

  for (const row of rows) {
    const partName    = getValue(row, 'name');
    const category    = getValue(row, 'category')     || null;
    const vtRaw       = (getValue(row, 'vehicle_type') || '').toUpperCase().trim();
    const vehicleType = vtRaw === '2W' || vtRaw === '4W' || vtRaw.toLowerCase() === 'both'
      ? (vtRaw.toLowerCase() === 'both' ? 'both' : vtRaw)
      : null;

    // Optional GST % — store as numeric or null
    const gstRaw     = getValue(row, 'gst_percent');
    const gstPercent = gstRaw !== '' && gstRaw != null && !isNaN(parseFloat(gstRaw))
      ? parseFloat(gstRaw)
      : null;

    // Optional HSN code — trim, store as string or null
    const hsnCode = (getValue(row, 'hsn_code') || '').trim() || null;

    // Optional customer rate (inc. GST) — store as numeric or null
    const rateRaw      = getValue(row, 'customer_rate');
    const customerRate = rateRaw !== '' && rateRaw != null && !isNaN(parseFloat(rateRaw))
      ? parseFloat(rateRaw)
      : null;

    // Look up existing part by name (case-insensitive)
    const existing = await client.query(
      'SELECT id, category, vehicle_type, customer_rate, gst_percent, hsn_code FROM parts WHERE LOWER(name) = LOWER($1)',
      [partName]
    );

    if (existing.rows.length > 0) {
      const { id, category: currentCat, vehicle_type: currentVt,
              customer_rate: currentRate, gst_percent: currentGst, hsn_code: currentHsn } = existing.rows[0];
      const catChanged  = (category     ?? null) !== (currentCat  ?? null);
      const vtChanged   = (vehicleType  ?? null) !== (currentVt   ?? null);
      const rateChanged = (customerRate ?? null) !== (currentRate != null ? parseFloat(currentRate) : null);
      const gstChanged  = (gstPercent   ?? null) !== (currentGst  ?? null);
      const hsnChanged  = (hsnCode      ?? null) !== (currentHsn  ?? null);

      if (catChanged || vtChanged || rateChanged || gstChanged || hsnChanged) {
        await client.query(
          'UPDATE parts SET category = $1, vehicle_type = $2, customer_rate = $3, gst_percent = $4, hsn_code = $5 WHERE id = $6',
          [category, vehicleType, customerRate, gstPercent, hsnCode, id]
        );
        updated++;
      } else {
        unchanged++;
      }
    } else {
      await client.query(
        'INSERT INTO parts (name, category, vehicle_type, customer_rate, gst_percent, hsn_code) VALUES ($1, $2, $3, $4, $5, $6)',
        [partName, category, vehicleType, customerRate, gstPercent, hsnCode]
      );
      inserted++;
    }
  }

  return { inserted, updated, unchanged };
}

// ═════════════════════════════════════════════════════════════════════════════
// EXPORT: Import handlers
// ═════════════════════════════════════════════════════════════════════════════

const importVehicles  = makeImportHandler('vehicles',  upsertVehicles);
const importLocations = makeImportHandler('locations', upsertLocations);
const importServices  = makeImportHandler('services',  upsertServices);
const importParts     = makeImportHandler('parts',     upsertParts);
// importPricing is a standalone two-pass function defined above

// ═════════════════════════════════════════════════════════════════════════════
// TEMPLATE DOWNLOAD
// ═════════════════════════════════════════════════════════════════════════════

async function downloadTemplate(req, res) {
  const { type }   = req.params;
  const { format } = req.query; // 'csv' | 'xlsx'  (default: csv)

  // leads has its own column set (not in IMPORT_TYPES)
  if (type === 'leads') {
    const columns = ['mobile','name','whatsapp','state','city','area',
                     'vehicle_type','make','model','lead_source','status',
                     'assigned_to','notes','services','categories'];
    const samples = TEMPLATE_SAMPLES.leads;
    if (format === 'xlsx') {
      const wsData = [columns, ...samples.map(row => columns.map(c => row[c] ?? ''))];
      const ws     = XLSX.utils.aoa_to_sheet(wsData);
      ws['!cols']  = columns.map(() => ({ wch: 20 }));
      const wb     = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'leads_template');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Disposition', 'attachment; filename="leads_template.xlsx"');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      return res.send(buf);
    }
    const header = columns.join(',');
    const rows   = samples.map(row =>
      columns.map(c => {
        const val = String(row[c] ?? '');
        return val.includes(',') || val.includes('"') ? `"${val.replace(/"/g, '""')}"` : val;
      }).join(',')
    );
    res.setHeader('Content-Disposition', 'attachment; filename="leads_template.csv"');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.send('﻿' + [header, ...rows].join('\r\n'));
  }

  if (!IMPORT_TYPES[type]) {
    return res.status(404).json({ error: `Unknown import type: ${type}` });
  }

  let def     = IMPORT_TYPES[type];
  // Vehicle class-specific template: strip type column, restrict to relevant columns
  if (type === 'vehicles' && (req.query.class === '2W' || req.query.class === '4W')) {
    const isTW = req.query.class === '2W';
    def = {
      ...def,
      required: ['make', 'model'],
      optional: isTW ? ['engine_cc'] : ['segment', 'body_type'],
    };
  }
  const columns = [...def.required, ...def.optional];
  const samples = (type === 'vehicles' && req.query.class)
    ? (req.query.class === '2W'
        ? [
            { make: 'Honda',         model: 'Activa 6G',      engine_cc: '110' },
            { make: 'Royal Enfield', model: 'Classic 350',    engine_cc: '349' },
            { make: 'Bajaj',         model: 'Pulsar 220',     engine_cc: '220' },
          ]
        : [
            { make: 'Maruti',  model: 'Swift',    segment: 'Petrol', body_type: 'Hatchback' },
            { make: 'Hyundai', model: 'Creta',    segment: 'Diesel', body_type: 'SUV'       },
            { make: 'Tata',    model: 'Nexon',    segment: 'Petrol', body_type: 'SUV'       },
          ])
    : TEMPLATE_SAMPLES[type];

  if (format === 'xlsx') {
    const wsData = [columns, ...samples.map(row => columns.map(c => row[c] ?? ''))];
    const ws     = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols']  = columns.map(() => ({ wch: 22 }));
    const wb     = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `${type}_template`);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="${type}_template.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buf);
  }

  // Default: CSV (UTF-8 BOM for Excel compatibility)
  const header = columns.join(',');
  const rows   = samples.map(row =>
    columns.map(c => {
      const val = String(row[c] ?? '');
      return val.includes(',') || val.includes('"')
        ? `"${val.replace(/"/g, '""')}"`
        : val;
    }).join(',')
  );
  const csv = [header, ...rows].join('\r\n');
  res.setHeader('Content-Disposition', `attachment; filename="${type}_template.csv"`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  return res.send('﻿' + csv);
}

module.exports = {
  importVehicles,
  importLocations,
  importServices,
  importPricing,
  importLeads,
  importParts,
  downloadTemplate,
};
