// Behavioural contract every AnalysisRepository implementation must satisfy. Run against the in-memory store in
// unit tests and against Postgres in integration tests, so the two can't drift.
import { ResearchSnapshot, type Instrument } from '@stock-analysis/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { evaluate } from '../domain/decision/evaluate.ts';
import { POLICY_V1 } from '../domain/decision/policy.ts';
import { strongEquity } from '../test-support/snapshots.ts';
import {
  RunInFlightError,
  RunStateError,
  type AnalysisRepository,
  type CompletedRunInput,
} from './analysisRepository.ts';

export interface ContractClock {
  set(iso: string): void;
  now: () => Date;
}

export function createClock(start = '2026-09-30T10:00:00.000Z'): ContractClock {
  let current = new Date(start);
  return { set: (iso) => void (current = new Date(iso)), now: () => new Date(current) };
}

const TESTCO: Instrument = strongEquity().instrument;
const OTHERCO: Instrument = { exchange: 'NSE', symbol: 'OTHERCO', name: 'Other Co Ltd', assetType: 'EQUITY' };

function completed(status: 'SUCCEEDED' | 'PARTIAL' = 'SUCCEEDED'): CompletedRunInput {
  const snapshot = ResearchSnapshot.parse(strongEquity());
  return {
    status,
    decision: evaluate(snapshot, POLICY_V1, new Date('2026-09-30T10:00:00.000Z')),
    explanation: { status: 'UNAVAILABLE' },
    snapshot,
    sources: snapshot.sources,
    unavailableDimensions: status === 'PARTIAL' ? ['sentiment'] : [],
  };
}

export function describeAnalysisRepositoryContract(
  label: string,
  setup: (clock: ContractClock) => Promise<AnalysisRepository>,
): void {
  describe(`AnalysisRepository contract: ${label}`, () => {
    let clock: ContractClock;
    let repo: AnalysisRepository;

    beforeEach(async () => {
      clock = createClock();
      repo = await setup(clock);
    });

    it('creates a stock once per instrument key and refreshes its instrument', async () => {
      const first = await repo.upsertStock(TESTCO);
      const second = await repo.upsertStock({ ...TESTCO, name: 'Test Co Limited' });

      expect(second.id).toBe(first.id);
      expect(first).toMatchObject({ instrumentKey: 'NSE:TESTCO', lastAnalysedAt: null });
      expect((await repo.findStockByKey('NSE:TESTCO'))?.instrument.name).toBe('Test Co Limited');
      expect(await repo.findStockByKey('NSE:NOPE')).toBeNull();
    });

    it('starts a PENDING run stamped with the clock and moves it to RUNNING', async () => {
      const stock = await repo.upsertStock(TESTCO);
      clock.set('2026-09-30T10:01:00.000Z');
      const run = await repo.createRun(stock.id);

      expect(run).toMatchObject({
        status: 'PENDING',
        instrumentKey: 'NSE:TESTCO',
        startedAt: '2026-09-30T10:01:00.000Z',
      });
      expect((await repo.markRunning(run.id)).status).toBe('RUNNING');
      await expect(repo.markRunning(run.id)).rejects.toBeInstanceOf(RunStateError);
      expect((await repo.findInFlightRun(stock.id))?.id).toBe(run.id);
    });

    it('rejects a second in-flight run for the same stock, naming the existing run', async () => {
      const stock = await repo.upsertStock(TESTCO);
      const run = await repo.createRun(stock.id);

      const error = await repo.createRun(stock.id).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(RunInFlightError);
      expect((error as RunInFlightError).runId).toBe(run.id);
    });

    it('keeps in-flight runs independent per stock', async () => {
      const a = await repo.upsertStock(TESTCO);
      const b = await repo.upsertStock(OTHERCO);
      await repo.createRun(a.id);
      await expect(repo.createRun(b.id)).resolves.toMatchObject({ status: 'PENDING' });
    });

    it('completes a run atomically: decision stored, timeline appended, lastAnalysedAt set', async () => {
      const stock = await repo.upsertStock(TESTCO);
      const run = await repo.createRun(stock.id);
      await repo.markRunning(run.id);
      clock.set('2026-09-30T10:02:00.000Z');
      const input = completed();

      const done = await repo.completeRun(run.id, input);

      expect(done).toMatchObject({ status: 'SUCCEEDED', completedAt: '2026-09-30T10:02:00.000Z' });
      expect(done.status === 'SUCCEEDED' && done.decision).toEqual(input.decision);
      expect(await repo.getRun(run.id)).toEqual(done);
      expect(await repo.findInFlightRun(stock.id)).toBeNull();
      expect((await repo.findStockByKey('NSE:TESTCO'))?.lastAnalysedAt).toBe('2026-09-30T10:02:00.000Z');
      expect(await repo.getTimeline(stock.id)).toEqual([
        expect.objectContaining({
          runId: run.id,
          eventType: 'INITIAL_RESEARCH',
          createdAt: '2026-09-30T10:02:00.000Z',
          indicator: input.decision.indicator,
          confidenceScore: input.decision.confidenceScore,
          policyVersion: 'v1',
        }),
      ]);
    });

    it('appends RE_ANALYSIS entries oldest first and reports the newest completed run', async () => {
      const stock = await repo.upsertStock(TESTCO);
      const first = await repo.createRun(stock.id);
      clock.set('2026-09-30T10:02:00.000Z');
      await repo.completeRun(first.id, completed());
      clock.set('2026-10-01T09:00:00.000Z');
      const second = await repo.createRun(stock.id);
      clock.set('2026-10-01T09:01:00.000Z');
      await repo.completeRun(second.id, completed('PARTIAL'));

      const timeline = await repo.getTimeline(stock.id);
      expect(timeline.map((t) => [t.runId, t.eventType])).toEqual([
        [first.id, 'INITIAL_RESEARCH'],
        [second.id, 'RE_ANALYSIS'],
      ]);
      const latest = await repo.getLatestCompletedRun(stock.id);
      expect(latest).toMatchObject({ id: second.id, status: 'PARTIAL', unavailableDimensions: ['sentiment'] });
    });

    it('enforces PARTIAL/SUCCEEDED dimension rules without changing the run', async () => {
      const stock = await repo.upsertStock(TESTCO);
      const run = await repo.createRun(stock.id);

      await expect(
        repo.completeRun(run.id, { ...completed('PARTIAL'), unavailableDimensions: [] }),
      ).rejects.toBeInstanceOf(RunStateError);
      await expect(
        repo.completeRun(run.id, { ...completed('SUCCEEDED'), unavailableDimensions: ['derivatives'] }),
      ).rejects.toBeInstanceOf(RunStateError);
      expect((await repo.getRun(run.id))?.status).toBe('PENDING');
      expect(await repo.getTimeline(stock.id)).toEqual([]);
    });

    it('fails a run without touching the timeline or lastAnalysedAt, and it is not an existing analysis', async () => {
      const stock = await repo.upsertStock(TESTCO);
      const run = await repo.createRun(stock.id);
      clock.set('2026-09-30T10:03:00.000Z');

      const failed = await repo.failRun(run.id, { code: 'PROVIDER_TIMEOUT', message: 'Research timed out.' });

      expect(failed).toMatchObject({
        status: 'FAILED',
        completedAt: '2026-09-30T10:03:00.000Z',
        error: { code: 'PROVIDER_TIMEOUT', message: 'Research timed out.' },
      });
      expect(await repo.getTimeline(stock.id)).toEqual([]);
      expect(await repo.getLatestCompletedRun(stock.id)).toBeNull();
      expect((await repo.findStockByKey('NSE:TESTCO'))?.lastAnalysedAt).toBeNull();
      await expect(repo.completeRun(run.id, completed())).rejects.toBeInstanceOf(RunStateError);
      await expect(repo.createRun(stock.id)).resolves.toMatchObject({ status: 'PENDING' });
    });

    it('rejects operations on unknown runs and stocks', async () => {
      const missing = '00000000-0000-4000-8000-000000000000';
      expect(await repo.getRun(missing)).toBeNull();
      await expect(repo.markRunning(missing)).rejects.toBeInstanceOf(RunStateError);
      await expect(repo.completeRun(missing, completed())).rejects.toBeInstanceOf(RunStateError);
      await expect(repo.failRun(missing, { code: 'X_Y', message: 'x' })).rejects.toBeInstanceOf(RunStateError);
      await expect(repo.createRun(missing)).rejects.toBeInstanceOf(RunStateError);
    });

    it('rejects a completion that fails the view contract and leaves everything unchanged', async () => {
      const stock = await repo.upsertStock(TESTCO);
      const run = await repo.createRun(stock.id);
      const invented = {
        ...completed(),
        explanation: {
          status: 'AVAILABLE' as const,
          summaryMarkdown: 'x',
          keyDrivers: [],
          riskFactors: [],
          citations: ['fixture:invented'],
        },
      };

      await expect(repo.completeRun(run.id, invented)).rejects.toThrow(/not listed in sources/);
      expect((await repo.getRun(run.id))?.status).toBe('PENDING');
      expect(await repo.getTimeline(stock.id)).toEqual([]);
      expect((await repo.findStockByKey('NSE:TESTCO'))?.lastAnalysedAt).toBeNull();
      await expect(repo.completeRun(run.id, completed())).resolves.toMatchObject({ status: 'SUCCEEDED' });
    });

    it('rejects an invalid research snapshot', async () => {
      const stock = await repo.upsertStock(TESTCO);
      const run = await repo.createRun(stock.id);
      const bad = {
        ...completed(),
        snapshot: { ...completed().snapshot, schemaVersion: 2 },
      } as unknown as CompletedRunInput;
      await expect(repo.completeRun(run.id, bad)).rejects.toThrow();
      expect((await repo.getRun(run.id))?.status).toBe('PENDING');
    });

    it('rejects an invalid instrument', async () => {
      await expect(repo.upsertStock({ ...TESTCO, symbol: 'lower' })).rejects.toThrow();
    });

    it('treats non-UUID ids as not found', async () => {
      expect(await repo.getRun('abc')).toBeNull();
      expect(await repo.findInFlightRun('abc')).toBeNull();
      expect(await repo.getLatestCompletedRun('abc')).toBeNull();
      expect(await repo.getTimeline('abc')).toEqual([]);
      await expect(repo.createRun('abc')).rejects.toBeInstanceOf(RunStateError);
      await expect(repo.markRunning('abc')).rejects.toBeInstanceOf(RunStateError);
      await expect(repo.completeRun('abc', completed())).rejects.toBeInstanceOf(RunStateError);
      await expect(repo.failRun('abc', { code: 'X_Y', message: 'x' })).rejects.toBeInstanceOf(RunStateError);
    });

    it('orders same-millisecond completions deterministically by id', async () => {
      const stock = await repo.upsertStock(TESTCO);
      const first = await repo.createRun(stock.id);
      await repo.completeRun(first.id, completed());
      const second = await repo.createRun(stock.id);
      await repo.completeRun(second.id, completed());

      const latest = await repo.getLatestCompletedRun(stock.id);
      expect(latest?.id).toBe([first.id, second.id].sort().at(-1));
      const timeline = await repo.getTimeline(stock.id);
      expect(timeline.map((t) => t.id)).toEqual(timeline.map((t) => t.id).sort());
    });

    it('fails every in-flight run at startup so their stocks are not blocked', async () => {
      const a = await repo.upsertStock(TESTCO);
      const b = await repo.upsertStock(OTHERCO);
      const pending = await repo.createRun(a.id);
      const running = await repo.createRun(b.id);
      await repo.markRunning(running.id);
      clock.set('2026-09-30T10:05:00.000Z');

      expect(await repo.failInFlightRuns({ code: 'INTERRUPTED', message: 'Interrupted by a restart.' })).toBe(2);
      for (const id of [pending.id, running.id]) {
        expect(await repo.getRun(id)).toMatchObject({ status: 'FAILED', error: { code: 'INTERRUPTED' } });
      }
      await expect(repo.createRun(a.id)).resolves.toMatchObject({ status: 'PENDING' });
      expect(await repo.failInFlightRuns({ code: 'INTERRUPTED', message: 'x' })).toBe(1);
    });

    it('returns only the latest timeline entries, oldest first, when limited', async () => {
      const stock = await repo.upsertStock(TESTCO);
      const runIds: string[] = [];
      for (let i = 0; i < 4; i++) {
        clock.set(`2026-10-0${i + 1}T10:00:00.000Z`);
        const run = await repo.createRun(stock.id);
        await repo.completeRun(run.id, completed());
        runIds.push(run.id);
      }
      expect((await repo.getTimeline(stock.id, 2)).map((t) => t.runId)).toEqual(runIds.slice(2));
      expect((await repo.getTimeline(stock.id)).map((t) => t.runId)).toEqual(runIds);
    });

    it('keeps timelines separate per stock', async () => {
      const a = await repo.upsertStock(TESTCO);
      const b = await repo.upsertStock(OTHERCO);
      await repo.completeRun((await repo.createRun(a.id)).id, completed());
      expect(await repo.getTimeline(b.id)).toEqual([]);
      expect(await repo.getTimeline(a.id)).toHaveLength(1);
    });
  });
}
