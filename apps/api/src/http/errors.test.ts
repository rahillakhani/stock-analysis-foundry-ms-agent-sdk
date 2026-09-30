import { describe, expect, it } from 'vitest';
import { AppError } from './errors.ts';

describe('AppError', () => {
  it.each([400, 404, 409, 503, 599])('accepts error status %i', (status) => {
    expect(new AppError(status, 'detail')).toMatchObject({ status, detail: 'detail' });
  });

  it.each([200, 302, 399, 600, 1000, 404.5, Number.NaN])('rejects non-error status %s', (status) => {
    expect(() => new AppError(status, 'detail')).toThrow(RangeError);
  });
});
