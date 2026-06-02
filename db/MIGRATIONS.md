# Spinoto — Database Migrations Guide

Run each migration **in order**. All migrations are safe to re-run (they use `IF NOT EXISTS`).

## Connection string
```
psql postgres://raju@localhost:5432/spinoto
```

---

## Run ALL pending migrations at once (copy-paste this block)

```bash
cd /Users/raju/Documents/Claude/Projects/Spinoto

psql postgres://raju@localhost:5432/spinoto -f backend/db/migrations/003_service_categories_description.sql
psql postgres://raju@localhost:5432/spinoto -f backend/db/migrations/004_pricing_category_rules.sql
psql postgres://raju@localhost:5432/spinoto -f backend/db/migrations/005_category_pricing_config.sql
psql postgres://raju@localhost:5432/spinoto -f backend/db/migrations/006_cc_categories.sql
psql postgres://raju@localhost:5432/spinoto -f backend/db/migrations/007_cc_category_pricing.sql
psql postgres://raju@localhost:5432/spinoto -f backend/db/migrations/008_vehicle_model_cc.sql
psql postgres://raju@localhost:5432/spinoto -f backend/db/migrations/009_service_vehicle_class.sql
psql postgres://raju@localhost:5432/spinoto -f backend/db/migrations/010_vehicle_models_segment_unique.sql
psql postgres://raju@localhost:5432/spinoto -f backend/db/migrations/011_service_categories_vehicle_class.sql
```

---

## Individual migrations

| # | File | What it adds |
|---|------|-------------|
| 003 | `003_service_categories_description.sql` | `description` column on `service_categories` |
| 004 | `004_pricing_category_rules.sql` | `category_id` column on `pricing` table |
| 005 | `005_category_pricing_config.sql` | `pricing_config` JSONB on `service_categories` |
| 006 | `006_cc_categories.sql` | `cc_categories` table + seed data (C1–C6) |
| 007 | `007_cc_category_pricing.sql` | `cc_category_id` column on `pricing` table |
| 008 | `008_vehicle_model_cc.sql` | `engine_cc` + `cc_category_id` on `vehicle_models` |
| 009 | `009_service_vehicle_class.sql` | `vehicle_class` column on `services` (both/fw/tw) |
| 010 | `010_vehicle_models_segment_unique.sql` | Drops old make+model unique constraint, adds segment-aware partial indexes |
| 011 | `011_service_categories_vehicle_class.sql` | `vehicle_class` column on `service_categories` (both/fw/tw) |

---

## How to check which migrations have been applied

```sql
-- Run inside psql to check columns exist:
SELECT column_name FROM information_schema.columns
WHERE table_name = 'service_categories'
ORDER BY ordinal_position;

SELECT column_name FROM information_schema.columns
WHERE table_name = 'services'
ORDER BY ordinal_position;

SELECT column_name FROM information_schema.columns
WHERE table_name = 'pricing'
ORDER BY ordinal_position;

SELECT column_name FROM information_schema.columns
WHERE table_name = 'vehicle_models'
ORDER BY ordinal_position;

-- Check cc_categories table and data:
SELECT * FROM cc_categories ORDER BY min_cc;
```

---

## Common errors and which migration fixes them

| Error | Fix |
|-------|-----|
| `column sc.pricing_config does not exist` | Run migration **005** |
| `column sc.vehicle_class does not exist` | Run migration **011** |
| `relation "cc_categories" does not exist` | Run migration **006** |
| `column "cc_category_id" does not exist` on pricing | Run migration **007** |
| `column "engine_cc" does not exist` on vehicle_models | Run migration **008** |
| `column "vehicle_class" does not exist` on services | Run migration **009** |
| `duplicate key value violates unique constraint "vehicle_models_make_id_name_key"` | Run migration **010** |
