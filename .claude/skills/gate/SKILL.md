---
name: gate
description: Run the repository quality gate (format check, lint, typecheck, unit tests, and integration tests when Postgres is available) and report exact commands and results. Use before declaring any phase or change complete, and before committing.
allowed-tools: Bash(npm run *) Bash(npm test *) Bash(npm test) Bash(docker compose ps *)
---

# Quality Gate

Available scripts: !`node -e "try{console.log(Object.keys(require('./package.json').scripts||{}).join(', ')||'(none)')}catch{console.log('(no package.json yet)')}"`

Run each check that exists, in this order, and stop at the first failing category to report it:

1. `npm run format:check`
2. `npm run lint`
3. `npm run typecheck`
4. `npm test`
5. `npm run test:int`: only if the script exists **and** `docker compose ps` shows the `db` service healthy.
   Otherwise report it as **SKIPPED (reason)**. Never report it as passed.
6. `npm run build`: only if the change touches build config, Dockerfiles, or `apps/web`.

Report as a table: `Check | Command | Result | Notes` with PASS / FAIL / SKIPPED. For failures, include the first
relevant error lines verbatim. Don't summarize a failure as a pass, and don't edit code in this skill. Fixes are
the implementer's job.
