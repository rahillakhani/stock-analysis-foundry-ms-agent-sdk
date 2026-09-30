import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from './env.ts';

describe('loadEnv', () => {
  it('applies defaults for an empty environment', () => {
    expect(loadEnv({})).toEqual({ NODE_ENV: 'development', HOST: '127.0.0.1', PORT: 3000, LOG_LEVEL: 'info' });
  });

  it('coerces PORT from a string', () => {
    expect(loadEnv({ PORT: '8080' }).PORT).toBe(8080);
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(loadEnv({}))).toBe(true);
  });

  it.each([
    ['PORT', 'not-a-number'],
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', '80.5'],
    ['PORT', '0x50'],
    ['PORT', '1e3'],
    ['PORT', ' 80'],
    ['PORT', ''],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
    ['HOST', ''],
  ])('rejects %s=%j, naming the variable', (name, value) => {
    expect(() => loadEnv({ [name]: value })).toThrow(EnvValidationError);
    expect(() => loadEnv({ [name]: value })).toThrow(new RegExp(`${name}:`));
  });

  it('never echoes the rejected value in the error message', () => {
    const secretLookingValue = 'hunter2-super-secret-value';
    let message = '';
    try {
      loadEnv({ PORT: secretLookingValue, NODE_ENV: secretLookingValue, LOG_LEVEL: secretLookingValue });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/PORT:/);
    expect(message).toMatch(/NODE_ENV:/);
    expect(message).toMatch(/LOG_LEVEL:/);
    expect(message).not.toContain(secretLookingValue);
  });
});
