import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from './env.ts';

describe('loadEnv', () => {
  const DB = 'postgresql://app@localhost:5432/stock_analysis';

  it('applies defaults, requiring a database URL for the default postgres storage', () => {
    expect(loadEnv({ DATABASE_URL: DB })).toEqual({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 3000,
      LOG_LEVEL: 'info',
      STORAGE: 'postgres',
      RESEARCH_PROVIDER: 'live',
      DATABASE_URL: DB,
    });
  });

  it('requires DATABASE_URL when STORAGE=postgres (the default)', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL: is required when STORAGE=postgres/);
  });

  it('allows an explicit in-memory store without a database', () => {
    expect(loadEnv({ STORAGE: 'memory' })).toMatchObject({ STORAGE: 'memory' });
  });

  it('treats an empty DATABASE_URL as unset', () => {
    expect(loadEnv({ STORAGE: 'memory', DATABASE_URL: '' }).DATABASE_URL).toBeUndefined();
    expect(() => loadEnv({ DATABASE_URL: '' })).toThrow(/DATABASE_URL: is required/);
  });

  it('rejects a non-postgres DATABASE_URL without echoing it', () => {
    const secret = 'mysql://root:hunter2@db/x';
    let message = '';
    try {
      loadEnv({ DATABASE_URL: secret });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL: must be a postgresql:\/\/ connection URL/);
    expect(message).not.toContain('hunter2');
  });

  it('coerces PORT from a string', () => {
    expect(loadEnv({ STORAGE: 'memory', PORT: '8080' }).PORT).toBe(8080);
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(loadEnv({ STORAGE: 'memory' }))).toBe(true);
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
    ['STORAGE', 'sqlite'],
    ['RESEARCH_PROVIDER', 'bloomberg'],
  ])('rejects %s=%j, naming the variable', (name, value) => {
    expect(() => loadEnv({ STORAGE: 'memory', [name]: value })).toThrow(EnvValidationError);
    expect(() => loadEnv({ STORAGE: 'memory', [name]: value })).toThrow(new RegExp(`${name}:`));
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
