import {
  AnalysedStocks,
  AnalysisRunView,
  AnalyzeAccepted,
  LiveQuote,
  LookupResponse,
  MarketMovers,
  PriceChart,
  SearchResponse,
  type AnalysedStock,
  type ChartInterval,
  type InstrumentSummary,
} from '@stock-analysis/shared';
import { z } from 'zod';

/** A non-2xx API response, carrying the problem-details fields the UI acts on. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly code: string | undefined;
  readonly runId: string | undefined;

  constructor(status: number, detail: string, code?: string, runId?: string) {
    super(detail);
    this.status = status;
    this.code = code;
    this.runId = runId;
  }
}

const Problem = z.object({
  detail: z.string().optional(),
  code: z.string().optional(),
  runId: z.string().optional(),
});

export interface ApiClient {
  search(q: string, signal?: AbortSignal): Promise<InstrumentSummary[]>;
  lookup(query: string, signal?: AbortSignal): Promise<LookupResponse>;
  analyze(instrumentKey: string, force: boolean, signal?: AbortSignal): Promise<AnalyzeAccepted>;
  getRun(runId: string, signal?: AbortSignal): Promise<AnalysisRunView>;
  stocks(signal?: AbortSignal): Promise<AnalysedStock[]>;
  movers(signal?: AbortSignal): Promise<MarketMovers>;
  chart(instrumentKey: string, interval: ChartInterval, signal?: AbortSignal): Promise<PriceChart>;
  quote(instrumentKey: string, signal?: AbortSignal): Promise<LiveQuote>;
}

/**
 * Typed client for /api/v1. Every response is parsed with the shared contract, so the UI never renders data the
 * contract forbids. Requests are same-origin (the dev server proxies /api to the API).
 */
export function createApiClient(fetchImpl: typeof fetch = fetch, basePath = '/api/v1'): ApiClient {
  async function request<S extends z.ZodType>(schema: S, path: string, init?: RequestInit): Promise<z.infer<S>> {
    const url = new URL(`${basePath}${path}`, window.location.origin);
    const res = await fetchImpl(url, {
      ...init,
      headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    });
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const problem = Problem.safeParse(body);
      const detail = problem.success ? (problem.data.detail ?? res.statusText) : res.statusText;
      throw new ApiError(res.status, detail || 'Request failed', problem.data?.code, problem.data?.runId);
    }
    return schema.parse(body);
  }

  return {
    search: async (q, signal) =>
      (await request(SearchResponse, `/stock/search?q=${encodeURIComponent(q)}`, { signal })).candidates,
    lookup: (query, signal) =>
      request(LookupResponse, '/stock/lookup', { method: 'POST', body: JSON.stringify({ query }), signal }),
    analyze: (instrumentKey, force, signal) =>
      request(AnalyzeAccepted, '/stock/analyze', {
        method: 'POST',
        body: JSON.stringify({ instrumentKey, force }),
        signal,
      }),
    getRun: (runId, signal) => request(AnalysisRunView, `/analysis-runs/${encodeURIComponent(runId)}`, { signal }),
    stocks: async (signal) => (await request(AnalysedStocks, '/stocks', { signal })).stocks,
    movers: (signal) => request(MarketMovers, '/market/movers', { signal }),
    chart: (key, interval, signal) =>
      request(PriceChart, `/market/chart/${encodeURIComponent(key)}?interval=${interval}`, { signal }),
    quote: (key, signal) => request(LiveQuote, `/market/quote/${encodeURIComponent(key)}`, { signal }),
  };
}

/** A user-facing message for a market-data failure (the market panels degrade independently of research). */
export function describeMarketError(err: unknown): string {
  if (err instanceof ApiError && err.code === 'MARKET_DATA_DISABLED') {
    return 'Live market data is turned off on this server (RESEARCH_PROVIDER=fixture).';
  }
  if (err instanceof TypeError) return 'Could not reach the server.';
  return 'Market data is unavailable right now.';
}

/** A user-facing message for any failure; never exposes internals. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status >= 500) return 'The server had a problem. Please try again.';
    return err.message;
  }
  if (err instanceof TypeError) return 'Could not reach the server. Check that the API is running.';
  return 'Something went wrong. Please try again.';
}
