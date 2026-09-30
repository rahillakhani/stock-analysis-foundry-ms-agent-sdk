# Full-Stack Application Blueprint: AI Stock & Futures Research Engine

Act as a Principal Software Architect and Lead Full-Stack JavaScript/TypeScript Developer. Build a production-grade, end-to-end full-stack application that analyzes Indian and global stocks/futures using Microsoft Agent Framework / Microsoft 365 Agents SDK, Azure AI Services, Model Context Protocol (MCP) clients, Node.js, Prisma ORM, and PostgreSQL.

---

## 1. System Architecture & Tech Stack

* **Frontend:** React 18+ (Vite, TypeScript, Tailwind CSS, Shadcn UI, Lucide React, Recharts).
* **Backend API:** Node.js (v20+) with Express (TypeScript, Zod schema validation, Prisma ORM).
* **Database:** PostgreSQL storing stock metadata, analysis runs, decision indicators, and timeline event snapshots.
* **AI & Orchestration Engine:** Microsoft Agents SDK (`@microsoft/agents-bot-builder` / `@microsoft/agents-hosting`) combined with Azure AI Foundry / Azure OpenAI for agentic workflow state machines, multi-agent reasoning, and decision generation.
* **Tool Integration:** Model Context Protocol (`@modelcontextprotocol/sdk`) Client executing tools for Web Search, Exchange APIs (NSE/BSE), Financial Filings, and Technical Indicators.

---

## 2. Core Decision Engine & Business Logic Workflow

Whenever a user inputs a query (e.g., "TATASTEEL", "Tata Steel", "RELIANCE", "Nifty 50 Futures"):

### Step 1: Query Normalization & Cache Check
1. Normalize input string to a standardized symbol (e.g., `TATASTEEL.NS` or `RELIANCE.BSE`).
2. Query PostgreSQL via Prisma for an existing record matching `ticker` or `companyName`.
3. **If record exists:**
   * Calculate time elapsed since `lastAnalysedAt`.
   * Return existing record summary, decision indicator, and full research timeline.
   * Return a UI prompt flag asking the user: *"Record found (Last analyzed X days/hours ago). Would you like to review existing analysis or trigger a fresh re-analysis?"*
4. **If no record exists** (or user forces re-analysis), proceed to Step 2.

### Step 2: MCP Tool Research Phase (Data Acquisition)
Using MCP Client bindings (`@modelcontextprotocol/sdk`), execute research across four dimensions:
1. **Fundamental Data:** Revenue growth, Net Margins, P/E, P/S, Debt-to-Equity, ROE, ROCE, Promoter Holdings %, Promoter Pledging %, and Auditor Notes.
2. **Technical & Price Action Data:** Current Price, 20-day / 50-day / 200-day EMAs, RSI(14), ATR, multi-week consolidation breakouts, and volume multipliers ($>1.5\times$ 20-day volume).
3. **Derivatives & F&O Mechanics (If Futures/F&O contract):**
   * Price vs Open Interest (OI) dynamics: Long Build-Up, Short Build-Up, Short Covering, Long Unwinding.
   * Futures Basis (Contango vs Backwardation) and SEBI F&O Ban status.
4. **Sentiment & Market Microstructure:** Bulk/Block deals (past 30 days), FII/DII net flows, corporate announcements, and macro trends.

### Step 3: Microsoft Agent SDK Reasoning & Signal Generation
1. Route aggregated research payload through a Microsoft Agent Framework orchestrator backed by Azure OpenAI / Azure AI Inference.
2. Evaluate rules:
   * **BUY Signal:** Strong fundamentals (ROE $> 15\%$, Debt-to-Equity $< 0.5$), Promoter Pledging $< 15\%$, Price above 50-day EMA, and Long Build-Up (Price $\uparrow$ + OI $\uparrow$).
   * **DON'T BUY / SKIP Signal:** High promoter pledging ($>15\%$), shrinking operating margins, bearish RSI divergence, F&O Ban status, or Short Build-Up (Price $\downarrow$ + OI $\uparrow$).
   * **NEUTRAL / WATCHLIST:** Mixed indicators requiring further confirmation.
3. Compute a numeric Confidence Score ($0.0$ to $100.0$) and Risk-to-Reward ($R:R$) ratio estimate.

### Step 4: Database Upsert & Timeline Event Logging
1. **New Stock:** Create `Stock` record, initial `AnalysisRun`, and initial `AnalysisTimeline` entry.
2. **Existing Stock:** Update `Stock` record metadata, append new `AnalysisRun` record, and append a timestamped snapshot to `AnalysisTimeline`.

---

## 3. Database Schema Design (Prisma ORM)

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum AssetType {
  EQUITY
  FUTURE
  INDEX
}

enum DecisionIndicator {
  BUY
  DONT_BUY
  NEUTRAL
}

model Stock {
  id              String             @id @default(uuid())
  ticker          String             @unique
  companyName     String
  exchange        String             @default("NSE")
  assetType       AssetType          @default(EQUITY)
  createdAt       DateTime           @default(now())
  updatedAt       DateTime           @updatedAt
  analysisRuns    AnalysisRun[]
  timelineRecords AnalysisTimeline[]

  @@index([ticker])
}

model AnalysisRun {
  id                  String             @id @default(uuid())
  stockId             String
  stock               Stock              @relation(fields: [stockId], references: [id], onDelete: Cascade)
  decisionIndicator   DecisionIndicator
  confidenceScore     Float
  fundamentalScore    Float
  technicalScore      Float
  derivativesScore    Float
  summaryMarkdown     String             @db.Text
  keyDrivers          Json
  riskFactors         Json
  analysedAt          DateTime           @default(now())
  timelineRecords     AnalysisTimeline[]

  @@index([stockId])
}

model AnalysisTimeline {
  id            String      @id @default(uuid())
  stockId       String
  stock         Stock       @relation(fields: [stockId], references: [id], onDelete: Cascade)
  analysisRunId String
  analysisRun   AnalysisRun @relation(fields: [analysisRunId], references: [id], onDelete: Cascade)
  eventType     String      // e.g., 'INITIAL_RESEARCH', 'RE_ANALYSIS', 'EARNINGS_UPDATE'
  snapshotData  Json
  createdAt     DateTime    @default(now())
}
4. Technical Implementation Specification
Backend Architecture (Node.js, Express, Microsoft Agent SDK & MCP)
File Structure:

src/server.ts: Express application setup and middleware.

src/routes/stockRoutes.ts: /api/v1/stock/search and /api/v1/stock/analyze endpoints.

src/services/mcpClient.ts: MCP Client initialization and tool execution bindings (@modelcontextprotocol/sdk).

src/services/msAgentService.ts: Microsoft Agent SDK orchestrator integrating Azure AI / Azure OpenAI inference.

src/db/prisma.ts: Prisma Client instance setup.

Frontend Interface (React, TypeScript & Tailwind CSS)
Components:

SearchBar.tsx: Input accepting stock symbol or company name with autocomplete.

ReAnalyzeModal.tsx: Alert dialog displaying existing analysis date, past decision badge, and choice to [View Existing] or [Run Fresh Re-Analysis].

DecisionBadge.tsx: Prominent badge (BUY in dark green, DON'T BUY in dark red, NEUTRAL in yellow).

MetricsGrid.tsx: Progress bars and indicators for Fundamental, Technical, and F&O scores.

TimelineView.tsx: Interactive vertical timeline showing decision evolution across previous runs.

5. Deployment Setup
Generate a complete docker-compose.yml orchestrating:

PostgreSQL container with healthcheck.

Node.js Express backend API service.

Vite React frontend application.