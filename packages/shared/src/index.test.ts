import { describe, expect, it } from 'vitest';
import { DECISION_INDICATORS, isDecisionIndicator } from './index.ts';

describe('isDecisionIndicator', () => {
  it.each(DECISION_INDICATORS)('accepts %s', (value) => {
    expect(isDecisionIndicator(value)).toBe(true);
  });

  it.each([["DON'T BUY"], ['buy'], [''], [null], [undefined], [1], [{}]])('rejects %j', (value) => {
    expect(isDecisionIndicator(value)).toBe(false);
  });
});
