-- One approval is bound to the exact local correction plan.
ALTER TABLE correction_requests ADD COLUMN reasons_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE correction_requests ADD COLUMN cash_impact INTEGER NOT NULL DEFAULT 0 CHECK (cash_impact IN (0, 1));
ALTER TABLE correction_requests ADD COLUMN cash_reason TEXT;
ALTER TABLE correction_requests ADD COLUMN plan_hash TEXT NOT NULL DEFAULT '';

ALTER TABLE correction_grants ADD COLUMN plan_hash TEXT NOT NULL DEFAULT '';

-- Older requests were approved before the plan was fixed. They cannot safely
-- authorize an arbitrary post-approval edit, so close only their unfinished state.
UPDATE correction_requests
   SET status = 'cancelled'
 WHERE status IN ('pending', 'approved')
   AND (plan_hash IS NULL OR length(plan_hash) != 64);
