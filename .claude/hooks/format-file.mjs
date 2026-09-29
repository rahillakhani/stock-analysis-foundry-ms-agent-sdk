#!/usr/bin/env node
// PostToolUse formatter for Edit/Write/MultiEdit. Runs the repo's own Prettier on the touched file.
// No-op until Prettier is installed (Phase 1), for unsupported extensions, or on any error:
// formatting must never block work, and lint/typecheck remain the real gate.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const FORMATTABLE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|json|css|md|yml|yaml)$/;

try {
  const raw = await new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
  const input = JSON.parse(raw);
  const filePath = input?.tool_input?.file_path;
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  const prettier = join(projectDir, 'node_modules', '.bin', 'prettier');

  if (typeof filePath === 'string' && FORMATTABLE.test(filePath) && existsSync(filePath) && existsSync(prettier)) {
    execFileSync(prettier, ['--write', '--log-level', 'warn', '--ignore-unknown', filePath], {
      cwd: projectDir,
      stdio: 'ignore',
      timeout: 25_000,
    });
  }
} catch {
  // Intentionally silent; see header.
}
process.exit(0);
