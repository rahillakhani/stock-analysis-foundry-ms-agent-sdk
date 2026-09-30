-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('EQUITY', 'FUTURE', 'INDEX');

-- CreateEnum
CREATE TYPE "DecisionIndicator" AS ENUM ('BUY', 'DONT_BUY', 'NEUTRAL');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "TimelineEventType" AS ENUM ('INITIAL_RESEARCH', 'RE_ANALYSIS');

-- CreateTable
CREATE TABLE "Stock" (
    "id" UUID NOT NULL,
    "instrumentKey" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "assetType" "AssetType" NOT NULL,
    "instrument" JSONB NOT NULL,
    "lastAnalysedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisRun" (
    "id" UUID NOT NULL,
    "stockId" UUID NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "policyVersion" TEXT,
    "decisionIndicator" "DecisionIndicator",
    "confidenceScore" DOUBLE PRECISION,
    "fundamentalScore" DOUBLE PRECISION,
    "technicalScore" DOUBLE PRECISION,
    "derivativesScore" DOUBLE PRECISION,
    "sentimentScore" DOUBLE PRECISION,
    "decision" JSONB,
    "explanation" JSONB,
    "researchSnapshot" JSONB,
    "sources" JSONB,
    "unavailableDimensions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "error" JSONB,

    CONSTRAINT "AnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisTimeline" (
    "id" UUID NOT NULL,
    "stockId" UUID NOT NULL,
    "analysisRunId" UUID NOT NULL,
    "eventType" "TimelineEventType" NOT NULL,
    "snapshotData" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisTimeline_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Stock_instrumentKey_key" ON "Stock"("instrumentKey");

-- CreateIndex
CREATE INDEX "Stock_companyName_idx" ON "Stock"("companyName");

-- CreateIndex
CREATE INDEX "AnalysisRun_stockId_startedAt_idx" ON "AnalysisRun"("stockId", "startedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisRun_id_stockId_key" ON "AnalysisRun"("id", "stockId");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisTimeline_analysisRunId_key" ON "AnalysisTimeline"("analysisRunId");

-- CreateIndex
CREATE INDEX "AnalysisTimeline_stockId_createdAt_idx" ON "AnalysisTimeline"("stockId", "createdAt");

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisTimeline" ADD CONSTRAINT "AnalysisTimeline_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisTimeline" ADD CONSTRAINT "AnalysisTimeline_analysisRunId_stockId_fkey" FOREIGN KEY ("analysisRunId", "stockId") REFERENCES "AnalysisRun"("id", "stockId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------
-- Constraints Prisma can't express (hand-written; see implementation-plan.md Phase 6).
-- ---------------------------------------------------------------------------------------------------------------

-- One in-flight (PENDING/RUNNING) run per stock, so concurrent "analyze" requests can't start duplicate runs.
CREATE UNIQUE INDEX "AnalysisRun_one_in_flight_per_stock"
    ON "AnalysisRun"("stockId")
    WHERE "status" IN ('PENDING', 'RUNNING');

-- Status decides which fields exist, mirroring the shared AnalysisRunView contract.
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_status_fields_check" CHECK (
    CASE "status"
        WHEN 'PENDING' THEN "completedAt" IS NULL AND "decision" IS NULL AND "error" IS NULL
        WHEN 'RUNNING' THEN "completedAt" IS NULL AND "decision" IS NULL AND "error" IS NULL
        WHEN 'SUCCEEDED' THEN "completedAt" IS NOT NULL AND "error" IS NULL
            AND "decision" IS NOT NULL AND "decisionIndicator" IS NOT NULL AND "confidenceScore" IS NOT NULL
            AND "policyVersion" IS NOT NULL AND "explanation" IS NOT NULL
            AND "researchSnapshot" IS NOT NULL AND "sources" IS NOT NULL
        WHEN 'PARTIAL' THEN "completedAt" IS NOT NULL AND "error" IS NULL
            AND "decision" IS NOT NULL AND "decisionIndicator" IS NOT NULL AND "confidenceScore" IS NOT NULL
            AND "policyVersion" IS NOT NULL AND "explanation" IS NOT NULL
            AND "researchSnapshot" IS NOT NULL AND "sources" IS NOT NULL
            AND cardinality("unavailableDimensions") > 0
        WHEN 'FAILED' THEN "completedAt" IS NOT NULL AND "error" IS NOT NULL AND "decision" IS NULL
    END
);

ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_completed_after_started_check"
    CHECK ("completedAt" IS NULL OR "completedAt" >= "startedAt");

ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_scores_range_check" CHECK (
    ("confidenceScore" IS NULL OR "confidenceScore" BETWEEN 0 AND 100)
    AND ("fundamentalScore" IS NULL OR "fundamentalScore" BETWEEN 0 AND 100)
    AND ("technicalScore" IS NULL OR "technicalScore" BETWEEN 0 AND 100)
    AND ("derivativesScore" IS NULL OR "derivativesScore" BETWEEN 0 AND 100)
    AND ("sentimentScore" IS NULL OR "sentimentScore" BETWEEN 0 AND 100)
);
