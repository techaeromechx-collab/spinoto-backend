-- 092: Separate claim code prefixes per promise type
-- Warranty claims keep WC-xxxxx; guarantee claims get GC-xxxxx.
-- New claims are prefixed correctly by the controller — this backfills any
-- guarantee claims that were created with a WC- code before the split.

UPDATE warranty_claims
   SET claim_code = 'GC-' || LPAD(id::text, 5, '0')
 WHERE claim_type = 'guarantee'
   AND claim_code LIKE 'WC-%';
