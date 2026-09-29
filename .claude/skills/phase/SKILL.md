---
name: phase
description: Implement one numbered phase from implementation-plan.md end to end (hypothesis, focused edits, gate, ledger update, commit-ready summary). Use when the user says "start phase N" or "do phase N".
argument-hint: "[phase-number]"
arguments: [n]
disable-model-invocation: true
---

# Implement Phase $n

## Current state
- Branch and status: !`git status --short --branch`
- Recent commits: !`git log --oneline -5`

## Procedure

1. **Load scope.** Read the `### Phase $n` section and the §3 Ledger in `implementation-plan.md`. If the phase depends
   on an open decision or on unavailable tooling (e.g. Docker), stop and say exactly what's blocking.
2. **Check prior work.** If the ledger or git log shows this phase done, don't redo it unless the user asked for a rerun.
3. **State before editing.** Give one falsifiable hypothesis about the controlling behavior, plus the one validation
   check that would disprove it.
4. **Verify versions and APIs.** Run `npm view <pkg> version` (and `peerDependencies`) for any new dependency. Pin
   exact versions. Never write an API from memory for fast-moving packages. Check the installed types.
5. **Implement in small steps.** Only files in the phase scope. After each substantive step, run the narrowest
   check (a single test file, or `tsc` on one package).
6. **Tests.** Add the tests listed for the phase, following `.claude/rules/testing.md`.
7. **Gate.** Run `/gate`. Fix failures, then re-run only the failed checks and say why each is being rerun.
8. **Docs.** Update `README.md` commands/setup if they changed. In the implementation-plan ledger, set this phase's
   row to Done with evidence (the gate commands and their results).
9. **Stop before committing.** Output the handoff:

   `Action | Owner | Status | Evidence | Next owner`

   Include files changed, the exact gate commands and their results, residual risks and untested paths, and the
   proposed commit message from the phase section. Then offer `/commit`.
