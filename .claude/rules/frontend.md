---
paths:
  - "apps/web/**"
---

# Frontend Conventions

- React + Vite + TypeScript + Tailwind + shadcn/ui. Use existing shadcn primitives before writing new base components.
- The API client uses DTOs and Zod schemas from `packages/shared`. Parse responses; never trust shape by casting.
- Every data view handles loading, empty, error (with retry), partial-data, and stale-data states explicitly.
- Never render a decision badge without its analysis timestamp, confidence score, data freshness, and the
  investment disclaimer.
- Cancel in-flight requests and polling with `AbortController` on unmount or when a new search starts.
- Accessible by default: labelled inputs, keyboard-operable modal and autocomplete, and color never the only signal
  (the badge includes text).
- Test user-visible behavior with RTL queries by role/label, and mock the network with MSW, not module mocks.
