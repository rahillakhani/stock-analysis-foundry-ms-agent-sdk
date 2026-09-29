---
name: commit
description: Create a conventional commit for the current phase after verifying the gate passed and the diff is in scope.
argument-hint: "[optional commit message override]"
disable-model-invocation: true
---

# Commit

## Current state
- Branch: !`git branch --show-current`
- Status: !`git status --short`
- Diff stat: !`git diff HEAD --stat`

## Procedure

1. If the branch is `main`, create a branch first: `phase-<n>-<slug>` or `<type>/<slug>`.
2. Review the diff for out-of-scope changes, debug leftovers, secrets, `.env` files, and generated artifacts
   (`dist/`, `coverage/`, `node_modules/`). Stage files explicitly by path. Never `git add -A`.
3. Confirm `/gate` passed in this session **after** the last code change. If it didn't, run it now.
4. Message: Conventional Commits (`feat(api): ...`, `chore: ...`, `docs: ...`, `test: ...`). Use $ARGUMENTS if
   given; otherwise use the phase's commit message from `implementation-plan.md`. The body lists what changed, how
   it was validated (commands), and known gaps. End with the attribution trailer required by the current session
   instructions.
5. Commit. Don't push unless the user asks.
6. Show `git log --oneline -1` and `git status --short`.
