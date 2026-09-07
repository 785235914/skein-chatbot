# History and repository hardening

## Scope and plan

Baseline: `7c16a9b`. Continue the browser-resume design and implementation plan without changing the public identity or adding a database requirement.

1. Make browser history resilient: storage-access denial must not crash rendering; stalled recovery must time out; switching away must cancel recovery and reject late results; drafts must stay with their conversation.
2. Add local title/session search and an explicit canonical-history refresh action for resumable conversations.
3. Add a value-free configuration doctor, a single verification command, and GitHub CI for Linux and Windows.
4. Verify regression tests, lint, typecheck, build and scrub; independently review the change and start the local project.

Acceptance: cached messages remain visible during recovery and on failure; completed recovery preserves the original provider binding; switching and reload preserve the chosen public session; no raw provider identifiers or configuration enter the browser or repository. Existing restart E2E tests remain required.

Scope size: M (10/24: scope 1, ambiguity 1, dependencies 1, difficulty 1, risk 1, verification 2, parallelism 1, context 2). Main agent owns implementation and integration. A separate read-only acceptance reviewer checks actual changes while the main agent validates startup.

## Review findings

- A denied `window.localStorage` getter throws before the cache module's error handling.
- Recovery can wait indefinitely, disabling creation and all history navigation.
- The recovery sequence guard exists but navigation cannot use it because selection is disabled during recovery.
- Draft text is shared across selected sessions.
- Recovery retry exists, but successful sessions have no explicit refresh action and history has no search.
- No GitHub CI exists. Configuration errors at startup are intentionally opaque, so a sanitized preflight is needed.

## Boundaries

The index includes conversations saved by this browser through Skein. It does not enumerate pre-existing Dify web-app conversations. A stable resume secret, the same provider configuration and the same provider user identity are required. Dify recovery restores at most 200 message pairs; PostgreSQL remains the future full-durability option. The sample API is single-user and requires an authentication/authorization layer before shared public hosting.

## Delivery evidence

Implemented and locally accepted on 2026-09-07. `pnpm check` passed: 31 test files / 489 tests, lint, typecheck, build and scrub. A separate read-only acceptance reviewer returned ACCEPT with no Critical/Important findings.

The live Mock browser journey passed: create a conversation, receive the answer, reload the page, search its title, switch to a new conversation, select the saved one and continue it. Historical browser entries already present were retained. API and Demo were started with `pnpm dev:mock` on their default loopback ports.

`pnpm doctor:dify` reported invalid/missing `DIFY_API_KEY`, `DIFY_BASE_URL`, and `SESSION_RESUME_SECRET` without exposing values. Real Dify restart recovery remains NOT RUN locally; provider-simulated restart and original-binding continuation remain covered by the passing E2E suite. GitHub CI configuration was added; the local gate does not itself prove hosted CI execution.

## Retrospective and recovery

The previous cache/recovery tests protected successful paths but did not exercise a denied browser storage getter, stalled HTTP recovery, navigation during recovery, or per-conversation drafts. The added tests cover those boundaries and retain old cache data on failures. Configuration diagnosis reuses server validation to avoid two divergent configuration contracts.

Baseline `7c16a9b` is the recovery reference. The changes add no database migration or cache schema change. Reverting this hardening commit would restore prior behavior without deleting saved browser history. Drafts remain page-local and are not persisted across reloads. No new permanent-memory candidate is needed beyond the repository's existing security and verification conventions.
