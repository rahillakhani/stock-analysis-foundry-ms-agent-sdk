import {
  AnalysisRunView,
  AnalyzeAccepted,
  LookupResponse,
  SearchResponse,
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
  };
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
