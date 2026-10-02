-- CreateTable
CREATE TABLE "WatchlistItem" (
    "instrumentKey" TEXT NOT NULL,
    "instrument" JSONB NOT NULL,
    "pinnedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchlistItem_pkey" PRIMARY KEY ("instrumentKey")
);

-- CreateIndex
CREATE INDEX "WatchlistItem_pinnedAt_idx" ON "WatchlistItem"("pinnedAt");
