#!/usr/bin/env node
// PreToolUse guard for Edit/Write/MultiEdit. Exit 2 blocks the call and sends stderr to Claude.
// Blocks: writes to real env files, edits to already-committed Prisma migrations, and content
// that looks like a credential. Fails open (exit 0) on unparseable input so it never wedges a session.
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';

const SECRET_PATTERNS = [
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Azure storage connection string', re: /AccountKey=[A-Za-z0-9+/=]{40,}/ },
  {
    name: 'Azure/OpenAI-style API key assignment',
    re: /(api[_-]?key|subscription[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9]{32,}/i,
  },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'OpenAI-style secret key', re: /\bsk-[A-Za-z0-9_-]{32,}\b/ },
  {
    name: 'Postgres URL with inline password',
    re: /postgres(?:ql)?:\/\/[^:\s/]+:(?!password@|postgres@|test@|\$\{)[^@\s]{8,}@/i,
  },
];

function block(reason) {
  process.stderr.write(`Blocked by .claude/hooks/guard-writes.mjs: ${reason}\n`);
  process.exit(2);
}

let input;
try {
  const raw = await new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const toolInput = input?.tool_input ?? {};
const filePath = toolInput.file_path;
if (typeof filePath !== 'string') process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const rel = relative(projectDir, filePath);
const base = rel.split('/').pop() ?? '';

// 1. Real env files hold secrets; only the committed template may be edited.
if (/^\.env(\..+)?$/.test(base) && base !== '.env.example') {
  block(`${rel} is a local secrets file. Edit .env.example (placeholders only) instead.`);
}

// 2. Committed migrations are immutable; create a new migration instead.
if (/(^|\/)prisma\/migrations\/.+\/migration\.sql$/.test(rel)) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', rel], { cwd: projectDir, stdio: 'ignore' });
    block(`${rel} is a committed migration. Create a new migration with \`npx prisma migrate dev --name <change>\`.`);
  } catch {
    // Not tracked yet: still being authored in this phase, allow.
  }
}

// 3. Credential-looking content. Fixtures and docs must use obvious placeholders.
const texts = [toolInput.content, toolInput.file_text, toolInput.new_string];
if (Array.isArray(toolInput.edits)) texts.push(...toolInput.edits.map((e) => e?.new_string));
const body = texts.filter((t) => typeof t === 'string').join('\n');
for (const { name, re } of SECRET_PATTERNS) {
  if (re.test(body)) {
    block(`content in ${rel} looks like a ${name}. Use a placeholder and load real values from env or Key Vault.`);
  }
}

process.exit(0);
