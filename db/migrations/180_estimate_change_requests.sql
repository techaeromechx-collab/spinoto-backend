-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 180: hub edits to an estimate become a request, not a write
--
-- THE PROBLEM THIS FIXES
-- ─────────────────────
-- A hub could edit an estimate at any status, including one that had already
-- been invoiced. controllers/estimates.controller.js updateEstimate says so in
-- its own comment — "Status restriction removed — estimates can be edited at
-- any status. Invoice sync is handled separately after save." The edit was
-- applied immediately; the invoices were not, because both sync endpoints are
-- staff-only (EDIT_INVOICE on the customer invoice, plus an explicit
-- isHubUser refusal inside syncPurchaseInvoiceFromEstimate).
--
-- So a hub changing a ₹10 discount to ₹30 left the estimate reading ₹962.60
-- and the customer invoice reading ₹986.00, and:
--
--   * nothing was recorded  — updateEstimate calls logActivity only for a hub
--                             reassignment, so the edit left no audit row
--   * nobody was told       — no notification of any kind was sent
--   * nothing was flagged   — there is no "this invoice no longer matches its
--                             estimate" concept anywhere in the system
--
-- The UI's advice was literally "Ask Spinoto to update the invoices to match",
-- i.e. telephone somebody. If the hub closed the dialog and said nothing, the
-- two documents disagreed for ever and the customer was billed the old figure.
--
-- WHAT REPLACES IT
-- ────────────────
-- The hub's edit is captured here and applied to NOTHING until a Spinoto user
-- approves it. On approval the estimate and both invoices move together; on
-- rejection nothing moved at all. The estimate and its invoices therefore
-- cannot disagree, which is a stronger guarantee than the system had before
-- this table existed — previously they could drift silently and permanently.
--
-- This deliberately mirrors the review the system ALREADY has for a new
-- estimate (draft → submit → pending_company_review → company-approve /
-- company-revise, estimates.controller.js). Same idea, same vocabulary, so
-- there is nothing new for staff to learn — the difference is only that a
-- status cannot carry a proposed change, so the proposal lives in a row.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS estimate_change_requests (
  id               SERIAL PRIMARY KEY,
  estimate_id      INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,

  -- Denormalised from the estimate at request time, on purpose. The reviewer
  -- needs to know which hub asked even if the estimate is later reassigned,
  -- and a request is a historical record of who asked for what and when.
  hub_id           INTEGER REFERENCES hubs(id),

  -- The proposed update, exactly as updateSchema validated it. Stored whole
  -- rather than as columns because it is a partial patch whose shape is that
  -- schema's business: notes, items[], discount_mode, the transaction discount
  -- pair, the B2B block. Splitting it into columns here would mean two places
  -- to change every time an estimate gains a field, and the second one would
  -- be forgotten.
  payload          JSONB NOT NULL,

  -- What the numbers are NOW, and what they would become. Computed once, at
  -- request time, so the notification and the list can show "₹986.00 → ₹962.60"
  -- without re-running the pricing engine per row. The review screen recomputes
  -- before it applies anything — these two are for display and for the record
  -- of what the hub was looking at when they asked.
  before_totals    JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_totals     JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- A short human sentence: "Discount changed from ₹10 to ₹30". Generated at
  -- request time and stored, because it is what the notification said — and a
  -- notification that no longer matches the row it points at is worse than no
  -- notification.
  summary          TEXT,

  -- 'applying' is the claim a reviewer takes before any writing starts. Two
  -- people pressing Approve at the same instant would otherwise both read
  -- 'pending', both pass the check, and both apply the change — charging the
  -- discount twice. Exactly one UPDATE can move a row out of 'pending', so
  -- exactly one caller proceeds.
  --
  -- A row left sitting in 'applying' means the process died mid-apply, and
  -- being able to SEE that is the point of giving it a name rather than
  -- holding a lock nobody can inspect.
  status           VARCHAR(20) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','applying','approved','rejected','superseded','failed')),

  requested_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  decided_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at       TIMESTAMPTZ,
  -- Why it was rejected, or what went wrong on a 'failed' apply. The reason is
  -- the entire point of a rejection reaching the hub — same reasoning as the
  -- customer's estimate-rejection comment in public.estimate.controller.js.
  decision_note    TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ONE pending request per estimate.
--
-- A hub that edits twice before anyone looks should leave the LATEST proposal
-- standing, not a queue — approving a stale first request would apply figures
-- the hub has already moved on from. The second submit marks the first
-- 'superseded' and inserts itself; this index is what makes that a database
-- guarantee rather than a convention the next handler has to remember.
--
-- Partial, so decided rows accumulate freely as history.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ecr_one_pending_per_estimate
  ON estimate_change_requests (estimate_id)
  WHERE status = 'pending';

-- The reviewer's list: "what is waiting for me", newest first.
CREATE INDEX IF NOT EXISTS idx_ecr_pending
  ON estimate_change_requests (status, requested_at DESC)
  WHERE status = 'pending';

-- The hub's own view, and the badge lookup on an estimate.
CREATE INDEX IF NOT EXISTS idx_ecr_estimate  ON estimate_change_requests (estimate_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_ecr_hub       ON estimate_change_requests (hub_id, status);

COMMENT ON TABLE estimate_change_requests IS
  'A hub''s proposed edit to an estimate, held unapplied until a Spinoto user approves it. On approval the estimate and its invoices are updated together.';

DO $$
BEGIN
  RAISE NOTICE 'estimate_change_requests ready. Hub edits now queue for approval instead of silently diverging from their invoices.';
END $$;
