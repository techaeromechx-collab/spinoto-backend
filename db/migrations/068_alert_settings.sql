-- Alert Settings column on company_settings
-- Stores configurable smart alert thresholds as JSON.

ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS alert_settings JSONB NOT NULL DEFAULT '{
    "no_activity_hours": 2,
    "inactive_lead_days": 7,
    "daily_target_hour": 18,
    "escalation_overdue_days": 3,
    "escalation_missed_count": 2,
    "work_start_hour": 9,
    "work_end_hour": 18
  }'::jsonb;
