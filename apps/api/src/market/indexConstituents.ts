import { TradingSymbol } from '@stock-analysis/shared';
import { z } from 'zod';

export interface Constituent {
  symbol: string;
  name: string;
}

export interface ConstituentList {
  /** "NIFTY 50", or "NIFTY 50 (snapshot)" when the official list couldn't be fetched. */
  universe: string;
  constituents: readonly Constituent[];
}

/** The subset of fetch this module uses (injectable for offline tests). */
export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface IndexConstituentsOptions {
  fetch?: FetchLike;
  now?: () => number;
  url?: string;
  ttlMs?: number;
  timeoutMs?: number;
  /** Called with a short reason (never a response body) when the official list can't be used. */
  onFallback?: (reason: string) => void;
}

/** The official NIFTY 50 constituents file published by NSE (columns: Company Name, Industry, Symbol, Series, ISIN). */
export const NIFTY_50_URL = 'https://archives.nseindia.com/content/indices/ind_nifty50list.csv';
const UNIVERSE = 'NIFTY 50';
const DEFAULT_TTL_MS = 12 * 60 * 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
/** After a failed download, wait this long before trying again instead of retrying on every request. */
const RETRY_AFTER_MS = 5 * 60_000;
/** A list far from the index size means a truncated or changed file; don't rank on it. */
const MIN_CONSTITUENTS = 40;
const MAX_CONSTITUENTS = 60;

/**
 * Snapshot of NIFTY_50_URL (Company Name, Symbol and Series columns), captured 2026-10-02. Used only when the live
 * file is unreachable or malformed. Constituents change at index rebalances, so it is labelled as a snapshot.
 */
const SNAPSHOT_CSV = `
Company Name,Symbol,Series
Adani Enterprises Ltd.,ADANIENT,EQ
Adani Ports and Special Economic Zone Ltd.,ADANIPORTS,EQ
Apollo Hospitals Enterprise Ltd.,APOLLOHOSP,EQ
Asian Paints Ltd.,ASIANPAINT,EQ
Axis Bank Ltd.,AXISBANK,EQ
BSE Ltd.,BSE,EQ
Bajaj Auto Ltd.,BAJAJ-AUTO,EQ
Bajaj Finance Ltd.,BAJFINANCE,EQ
Bajaj Finserv Ltd.,BAJAJFINSV,EQ
Bharat Electronics Ltd.,BEL,EQ
Bharti Airtel Ltd.,BHARTIARTL,EQ
Cipla Ltd.,CIPLA,EQ
Coal India Ltd.,COALINDIA,EQ
Dr. Reddy's Laboratories Ltd.,DRREDDY,EQ
Eicher Motors Ltd.,EICHERMOT,EQ
Eternal Ltd.,ETERNAL,EQ
Grasim Industries Ltd.,GRASIM,EQ
HCL Technologies Ltd.,HCLTECH,EQ
HDFC Bank Ltd.,HDFCBANK,EQ
HDFC Life Insurance Company Ltd.,HDFCLIFE,EQ
Hindalco Industries Ltd.,HINDALCO,EQ
Hindustan Unilever Ltd.,HINDUNILVR,EQ
ICICI Bank Ltd.,ICICIBANK,EQ
ITC Ltd.,ITC,EQ
Infosys Ltd.,INFY,EQ
InterGlobe Aviation Ltd.,INDIGO,EQ
JSW Steel Ltd.,JSWSTEEL,EQ
Jio Financial Services Ltd.,JIOFIN,EQ
Kotak Mahindra Bank Ltd.,KOTAKBANK,EQ
Larsen & Toubro Ltd.,LT,EQ
Mahindra & Mahindra Ltd.,M&M,EQ
Maruti Suzuki India Ltd.,MARUTI,EQ
Max Healthcare Institute Ltd.,MAXHEALTH,EQ
NTPC Ltd.,NTPC,EQ
Nestle India Ltd.,NESTLEIND,EQ
Oil & Natural Gas Corporation Ltd.,ONGC,EQ
Power Grid Corporation of India Ltd.,POWERGRID,EQ
Reliance Industries Ltd.,RELIANCE,EQ
SBI Life Insurance Company Ltd.,SBILIFE,EQ
Shriram Finance Ltd.,SHRIRAMFIN,EQ
State Bank of India,SBIN,EQ
Sun Pharmaceutical Industries Ltd.,SUNPHARMA,EQ
Tata Consultancy Services Ltd.,TCS,EQ
Tata Consumer Products Ltd.,TATACONSUM,EQ
Tata Motors Passenger Vehicles Ltd.,TMPV,EQ
Tata Steel Ltd.,TATASTEEL,EQ
Tech Mahindra Ltd.,TECHM,EQ
Titan Company Ltd.,TITAN,EQ
Trent Ltd.,TRENT,EQ
UltraTech Cement Ltd.,ULTRACEMCO,EQ
`;

const Name = z.string().trim().min(1).max(200);

/** Parses the NSE constituents CSV (unquoted fields, header row first). Undefined if it doesn't look like one. */
export function parseConstituentsCsv(csv: string): Constituent[] | undefined {
  const [header = '', ...lines] = csv.trim().split(/\r?\n/);
  const columns = header.split(',').map((c) => c.trim());
  const symbolAt = columns.indexOf('Symbol');
  const nameAt = columns.indexOf('Company Name');
  const seriesAt = columns.indexOf('Series');
  if (symbolAt < 0 || nameAt < 0) return undefined;
  const constituents = lines.flatMap((line): Constituent[] => {
    const fields = line.split(',').map((f) => f.trim());
    if (seriesAt >= 0 && fields[seriesAt] !== 'EQ') return [];
    const symbol = TradingSymbol.safeParse(fields[symbolAt]);
    const name = Name.safeParse(fields[nameAt]);
    return symbol.success && name.success ? [{ symbol: symbol.data, name: name.data }] : [];
  });
  return constituents.length >= MIN_CONSTITUENTS && constituents.length <= MAX_CONSTITUENTS ? constituents : undefined;
}

const SNAPSHOT: ConstituentList = {
  universe: `${UNIVERSE} (snapshot)`,
  constituents: parseConstituentsCsv(SNAPSHOT_CSV) ?? [],
};

/**
 * NIFTY 50 constituents from NSE's published file, cached for 12 hours. When the file can't be fetched or parsed,
 * the last good list is kept; without one, the built-in snapshot is used and labelled as such. Never throws.
 */
export class IndexConstituents {
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #url: string;
  readonly #ttlMs: number;
  readonly #timeoutMs: number;
  readonly #onFallback: (reason: string) => void;
  #cached: { list: ConstituentList; expiresAt: number } | undefined;
  #inFlight: Promise<ConstituentList> | undefined;

  constructor(options: IndexConstituentsOptions = {}) {
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? Date.now;
    this.#url = options.url ?? NIFTY_50_URL;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#onFallback = options.onFallback ?? (() => undefined);
  }

  list(): Promise<ConstituentList> {
    if (this.#cached && this.#cached.expiresAt > this.#now()) return Promise.resolve(this.#cached.list);
    // Concurrent callers share one download.
    this.#inFlight ??= this.#refresh().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #refresh(): Promise<ConstituentList> {
    const constituents = await this.#download();
    if (constituents) {
      const list = { universe: UNIVERSE, constituents };
      this.#cached = { list, expiresAt: this.#now() + this.#ttlMs };
      return list;
    }
    const list = this.#cached?.list ?? SNAPSHOT;
    this.#cached = { list, expiresAt: this.#now() + Math.min(this.#ttlMs, RETRY_AFTER_MS) };
    return list;
  }

  async #download(): Promise<Constituent[] | undefined> {
    try {
      const response = await this.#fetch(this.#url, {
        signal: AbortSignal.timeout(this.#timeoutMs),
        // NSE's archive rejects requests without a browser-like user agent.
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stock-analysis)', Accept: 'text/csv' },
      });
      if (!response.ok) {
        this.#onFallback(`HTTP ${response.status}`);
        return undefined;
      }
      const parsed = parseConstituentsCsv(await response.text());
      if (!parsed) this.#onFallback('unrecognized constituents file');
      return parsed;
    } catch (err) {
      this.#onFallback(err instanceof Error ? err.name : 'unknown error');
      return undefined;
    }
  }
}
