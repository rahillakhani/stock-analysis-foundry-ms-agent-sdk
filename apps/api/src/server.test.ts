import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const serverEntry = fileURLToPath(new URL('./server.ts', import.meta.url));

describe('server startup', () => {
  it('exits with code 1 and names the variable when configuration is invalid', async () => {
    // Same resolution as `npm run dev`: workspace packages load from TypeScript source, never a stale dist/.
    const result = await execFileAsync(process.execPath, ['--conditions=development', serverEntry], {
      env: { PATH: process.env.PATH, PORT: 'not-a-port-hunter2' },
      timeout: 10_000,
    }).then(
      () => ({ code: 0, stderr: '' }),
      (err: { code: number; stderr: string }) => ({ code: err.code, stderr: err.stderr }),
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Invalid environment configuration/);
    expect(result.stderr).toMatch(/PORT:/);
    expect(result.stderr).not.toContain('hunter2');
  });
});
