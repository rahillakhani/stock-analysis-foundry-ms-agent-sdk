import { describe, expect, it } from 'vitest';
import { resolveRequestId } from './requestContext.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it.each(['abc-123', 'trace.id_42', 'A'.repeat(128)])('reuses a safe incoming id %j', (id) => {
    expect(resolveRequestId(id)).toBe(id);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too long', 'A'.repeat(129)],
    ['log injection', 'abc\ninjected'],
    ['spaces', 'a b'],
    ['array header', ['a', 'b']],
  ])('generates a uuid when the incoming id is %s', (_label, incoming) => {
    expect(resolveRequestId(incoming)).toMatch(UUID);
  });
});
