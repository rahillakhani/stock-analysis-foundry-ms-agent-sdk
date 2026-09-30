-- Phase 6 review fixes (hand-written; the schema itself is unchanged).
-- 1. PARTIAL/SUCCEEDED dimension checks are NULL-safe: cardinality(NULL) is NULL, and a CHECK that evaluates to
--    NULL passes, so the previous PARTIAL rule accepted "unavailableDimensions" = NULL.
-- 2. PENDING/RUNNING/FAILED rows can't carry decision data.
-- 3. An explicit ELSE false rejects any future status value until this check is updated for it.

ALTER TABLE "AnalysisRun" DROP CONSTRAINT "AnalysisRun_status_fields_check";

ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_status_fields_check" CHECK (
    CASE "status"
        WHEN 'PENDING' THEN "completedAt" IS NULL AND "error" IS NULL
            AND "decision" IS NULL AND "decisionIndicator" IS NULL AND "confidenceScore" IS NULL
            AND "policyVersion" IS NULL AND "explanation" IS NULL AND "researchSnapshot" IS NULL AND "sources" IS NULL
            AND COALESCE(cardinality("unavailableDimensions"), 0) = 0
        WHEN 'RUNNING' THEN "completedAt" IS NULL AND "error" IS NULL
            AND "decision" IS NULL AND "decisionIndicator" IS NULL AND "confidenceScore" IS NULL
            AND "policyVersion" IS NULL AND "explanation" IS NULL AND "researchSnapshot" IS NULL AND "sources" IS NULL
            AND COALESCE(cardinality("unavailableDimensions"), 0) = 0
        WHEN 'SUCCEEDED' THEN "completedAt" IS NOT NULL AND "error" IS NULL
            AND "decision" IS NOT NULL AND "decisionIndicator" IS NOT NULL AND "confidenceScore" IS NOT NULL
            AND "policyVersion" IS NOT NULL AND "explanation" IS NOT NULL
            AND "researchSnapshot" IS NOT NULL AND "sources" IS NOT NULL
            AND COALESCE(cardinality("unavailableDimensions"), 0) = 0
        WHEN 'PARTIAL' THEN "completedAt" IS NOT NULL AND "error" IS NULL
            AND "decision" IS NOT NULL AND "decisionIndicator" IS NOT NULL AND "confidenceScore" IS NOT NULL
            AND "policyVersion" IS NOT NULL AND "explanation" IS NOT NULL
            AND "researchSnapshot" IS NOT NULL AND "sources" IS NOT NULL
            AND COALESCE(cardinality("unavailableDimensions"), 0) > 0
        WHEN 'FAILED' THEN "completedAt" IS NOT NULL AND "error" IS NOT NULL
            AND "decision" IS NULL AND "decisionIndicator" IS NULL AND "confidenceScore" IS NULL
            AND "explanation" IS NULL AND "researchSnapshot" IS NULL
            AND COALESCE(cardinality("unavailableDimensions"), 0) = 0
        ELSE false
    END
);

-- Only the four research dimensions may be listed (duplicates are rejected by the application; Postgres CHECK
-- constraints can't use the subquery a distinctness test needs).
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_unavailable_dimensions_check" CHECK (
    "unavailableDimensions" IS NULL
    OR "unavailableDimensions" <@ ARRAY['fundamentals', 'technicals', 'derivatives', 'sentiment']::TEXT[]
);
