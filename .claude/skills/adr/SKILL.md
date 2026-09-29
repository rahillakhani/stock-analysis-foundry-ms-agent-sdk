---
name: adr
description: Record an architecture decision as a numbered ADR in docs/adr/. Use when a design choice is made or changed (framework, provider, data model, sync vs job, auth, versions).
argument-hint: "[decision title]"
---

# Architecture Decision Record

Existing ADRs: !`ls docs/adr 2>/dev/null || echo "(none yet)"`

Create `docs/adr/NNNN-<kebab-title>.md` with the next number (4 digits) for: $ARGUMENTS

Template:

```markdown
# NNNN. <Title>

- Status: Proposed | Accepted | Superseded by NNNN
- Date: <YYYY-MM-DD>
- Deciders: <names or roles>

## Context
Problem, forces, and constraints. Separate **verified facts** (with source: docs URL, `npm view` output, file path)
from **assumptions**.

## Options considered
1. <Option>: pros / cons / risks
2. ...

## Decision
What was chosen, and why it beats the alternatives.

## Consequences
What becomes easier or harder. Follow-up work. How to reverse the decision.

## Validation
The check that would show this decision is wrong.
```

Rules: never invent external facts. Verify package names and versions with `npm view`, and APIs with official docs.
If a decision supersedes an older ADR, update the old ADR's Status line. Status stays `Proposed` until the user
accepts it.
