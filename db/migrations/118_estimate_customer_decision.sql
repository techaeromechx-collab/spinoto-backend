-- 118_estimate_customer_decision.sql
--
-- Lets a customer approve or reject their own estimate from a WhatsApp link.
--
-- ── Why new columns rather than reusing the existing status ─────────────────
--
-- estimates already has a status that an advisor moves. After this, "approved"
-- can mean two quite different things: a staff member clicked it, or somebody
-- holding a forwarded link tapped it on a phone.
--
-- Those are not the same claim, and a dispute six months later turns on which
-- one happened. So the decision is recorded ALONGSIDE the status rather than
-- inferred from it.

BEGIN;

ALTER TABLE estimates
  -- 'customer_link' | 'staff'. NULL = no customer decision recorded.
  ADD COLUMN IF NOT EXISTS decision_source   VARCHAR(20),
  ADD COLUMN IF NOT EXISTS decided_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decision_comment  TEXT,
  -- Evidence, not analytics. "Someone approved ₹15,000 of work and it wasn't
  -- me" is answerable with these and unanswerable without them.
  ADD COLUMN IF NOT EXISTS decision_ip       VARCHAR(64),
  ADD COLUMN IF NOT EXISTS decision_ua       TEXT,
  -- After this instant the page still OPENS but the buttons are gone.
  --
  -- Expiring the view would be worse than useless: the customer reopens the
  -- link to check what they agreed to, and the same URL is printed as a QR on
  -- the estimate. A dead link is a support call. A stale PRICE, though, must
  -- not stay one tap from becoming a commitment.
  ADD COLUMN IF NOT EXISTS decision_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN estimates.decision_source IS
  'customer_link = decided by someone holding the share link. staff = decided inside the CRM. NULL = no customer decision.';
COMMENT ON COLUMN estimates.decision_expires_at IS
  'After this the estimate can still be VIEWED but no longer approved or rejected. NULL = no deadline.';

-- Partial index: the public route looks up by token and the existing index on
-- estimates(public_token) already serves that. This one is for the staff-side
-- question "which estimates are sitting with the customer?"
CREATE INDEX IF NOT EXISTS idx_estimates_awaiting_decision
  ON estimates (decision_expires_at)
  WHERE decision_source IS NULL AND decision_expires_at IS NOT NULL;

COMMIT;
