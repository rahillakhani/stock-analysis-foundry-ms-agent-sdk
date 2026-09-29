---
name: handoff
description: Produce the CLAUDE.md handoff record for the current action (action, owner, status, output, unresolved issues, next owner) and update the ledger in implementation-plan.md. Use at the end of any phase, review, or test pass, or before pausing work.
---

# Handoff

Status: !`git status --short --branch`

1. Write the handoff block:

   ```
   Action:      <what was done>
   Owner:       <architect | research | planning | validation | implementation | testing | review>
   Status:      <done | partial | blocked | failed>
   Output:      <files/artifacts, with paths>
   Evidence:    <exact commands run and their results; "not run" where applicable>
   Unresolved:  <open issues, risks, untested paths>
   Next owner:  <role> - <the concrete next action>
   ```

2. Update the matching row in the `## 3. Ledger` table of `implementation-plan.md`
   (`Action | Owner | Status | Evidence | Next owner`). Edit an existing row rather than duplicating it.
3. Don't claim anything passed that wasn't run in this session.
