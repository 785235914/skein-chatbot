# Implementation Status

## Milestone 0 — Source Analysis

- Status: completed
- Completed: local Dify exports were parsed with secret-safe structural extraction; environment and UI suitability were inspected; architecture and implementation plan were frozen.
- Files changed: `docs/source-analysis.md`, `IMPLEMENTATION_PLAN.md`, `.agent-work/*`, this file.
- Tests: source SHA-256 values matched before and after analysis; no source files changed. Executable gate passed on Node 24.18.0 / pnpm 11.9.0: lint 0, typecheck 0, test 3/3, build 0.
- Design decisions: generic Core, adapter-owned protocol mapping, profile-owned app schema mapping, provider-neutral conversation-binding result, independent demo fallback.
- Known issues: reference exports contain suspected live credentials; real Dify credentials and PostgreSQL database credentials are unavailable.
- Next step: Milestone 1 repository skeleton.

## Milestone 1 — Repository Skeleton

- Status: completed
- Completed: pnpm workspace, strict TypeScript, canonical public contracts, provider-neutral Core ports/domain, complete Mock orchestrator scenarios, Fastify health/readiness endpoints and independent React/Vite demo shell.
- Files changed: root toolchain/config; `packages/contracts`; `packages/core`; `packages/adapters/mock`; `apps/api`; `apps/demo-web`; architecture/public API docs.
- Tests: executable gate passed: lint 0, typecheck 0, 5 test files / 29 tests passed, build 0 (contracts, Core, Mock, API and Vite production bundle).
- Design decisions: optional public mode uses Runtime default; HTTP failures use PublicError; store exposes aggregate atomic commit; demo validates all server payloads.
- Known issues: chat/session routes are intentionally deferred to Milestone 2; PostgreSQL and real provider credentials remain unavailable.
- Next step: Milestone 2 Public Chat API.

## Milestone 2 — Public Chat API

- Status: completed
- Completed: blocking and SSE chat routes, new/existing session lifecycle, messages/session queries, reset, abort registry/signal propagation, canonical runtime events, aggregate atomic commit and in-memory store.
- Files changed: `packages/core/src/runtime`; Core/runtime tests; `packages/test-utils`; `apps/api` routes/composition/config/error mapping/tests.
- Tests: gate passed: lint 0, typecheck 0, 9 test files / 73 tests passed, build 0. Live built-server smoke returned health 200, canonical blocking Mock answer, and ordered SSE `turn.started` -> status -> deltas -> `turn.completed`.
- Design decisions: fixed provider-neutral HTTP status/message allowlist; provider metadata is never public; completed event is emitted only after commit; unknown provider status text is normalized.
- Known issues: in-memory state is process-local by design until PostgreSQL adapter; reliability/guards are later milestones.
- Next step: Milestone 3 Dify Adapter.

## Milestone 3 — Dify Adapter

- Status: completed
- Completed: configurable Dify chat-message transport, Bearer app-key authentication, blocking and incremental SSE modes, conversation binding, bounded/fatal UTF-8 parsing, response/source/context normalization, profile validation, provider-neutral errors, API composition and a sanitized real-provider smoke command.
- Files changed: `packages/adapters/dify`; `config/dify-profiles/default.yaml`; `config/dify-profiles/example.yaml`; `apps/api` provider composition/config; `scripts/smoke-dify.ts`; Dify documentation.
- Tests: milestone full gate passed before M4 work began: lint 0, typecheck 0, 12 test files / 115 tests passed, build 0. Independent focused rerun passed: Dify/API lint 0, 4 test files / 44 tests, adapter build 0. Cases include API-key-only app switching, two profile schemas, conversation binding, 401/429/500, malformed JSON/UTF-8, fragmented SSE, cumulative answer limit, abort, workflow/New Agent event sequences and secret-safe errors.
- Design decisions: profile name participates in `providerKey`; key-only switching uses fresh Skein sessions; streaming-only apps opt in through the profile; additive V1 streaming rejects `message_replace` and paused human-input flows instead of exposing provider semantics.
- Known issues: `pnpm smoke:dify` is implemented and secret-safe but reported `NOT RUN (.env.local not found)`; real deployment compatibility remains an external environment check.
- Next step: Milestone 4 PostgreSQL persistence.

## Milestone 4 — PostgreSQL Persistence

- Status: completed; real-database restart smoke externally unperformed
- Completed: Prisma schema and deterministic migration for all eight runtime models; guarded bootstrap/migration scripts; atomic `PrismaRuntimeStore` with revision CAS, rollback, reset, failed turns, active-message compaction markers and provider bindings; fake-client restart/conformance tests; presence-based `DATABASE_URL` API composition and idempotent client cleanup.
- Files changed: `prisma/**`, `packages/persistence/postgres/**`, API config/composition/lifecycle tests, persistence documentation.
- Tests: Prisma validation passed; client generation and package build passed; persistence/API composition tests are included in the 18-file / 220-test integrated gate. The concurrent-compaction regression verifies one winner and one `SESSION_CONFLICT` in both store adapters.
- Design decisions: PostgreSQL is selected only when a non-empty `DATABASE_URL` exists; migration and restart smoke require exact dedicated database-name confirmation; no database is created or dropped automatically.
- Known issues: PostgreSQL 17.10 is reachable, but no authorized credentials or pre-provisioned `skein_chatbot_test` database are available. `test:postgres` reports `NOT RUN`; no real database was created, migrated or queried.
- Next step: Milestone 8 guard pipeline after the M4-M7 integrated gate.

## Milestone 5 — Context / Turn Snapshot

- Status: completed
- Completed: strict provider-neutral JSON/context validator; 64 KiB serialized context, depth 16 and array length 128 limits; unsafe/non-JSON/reserved-key rejection; exact generic context shape; optional `ContextExtensionProvider`; load, patch, merged-context and revision validation around the immutable turn snapshot and atomic commit.
- Files changed: `packages/core/src/context`; Core context merge/result/runtime wiring; `packages/core/test/context-validation.test.ts`.
- Tests: 21/21 new context cases and the integrated lint/typecheck/171-test/build gate passed. Cases include exact boundaries, cycles, accessors, sparse arrays, unsafe prototypes, extension rejection/unsafe output, persisted corruption, revision mismatch, runtime-key ownership and zero partial commit.
- Design decisions: provider patch failures are `PROVIDER_INVALID_RESPONSE`; stored/extension/merged context failures are `CONTEXT_INVALID`; workflow state remains generic and the Runtime exclusively owns revision/timestamps/last turn.
- Known issues: none within M5 scope.
- Next step: Milestone 6 memory and compaction integration.

## Milestone 6 — Memory / Compaction

- Status: completed
- Completed: recent-message window, bounded validated conversation summary, deterministic provider-free redacted fallback, count/token/manual triggers, `CompactionProvider`, active-only aggregate loading and TurnRunner pre-orchestration compaction for blocking and streaming calls.
- Files changed: Core memory/compaction modules and ports, runtime integration, both RuntimeStore adapters and focused tests, memory documentation.
- Tests: threshold/window/token/redaction/summary/state-integrity cases plus runtime integration and the same-revision identical-ID concurrency regression passed. The integrated gate is lint 0, typecheck 0, 18 files / 220 tests, build 0.
- Design decisions: summary is semantic and never authoritative workflow state; compaction does not change context revision; compacted messages remain queryable through full message history; concurrent duplicate compaction has exactly one winner.
- Known issues: live PostgreSQL concurrency was not run without an authorized dedicated test database; transactional fake coverage and SQL predicate inspection passed.
- Next step: Milestone 7 reliability.

## Milestone 7 — Reliability

- Status: completed
- Completed: provider-neutral QUICK/DEEP timeouts, selective transient retry with abortable backoff, provider-isolated CLOSED/OPEN/HALF_OPEN circuit breaker, blocking and streaming cancellation/iterator cleanup, and default API composition around both Mock and Dify adapters.
- Files changed: `packages/core/src/reliability/**`, Core public export/tests, API composition integration test, reliability documentation.
- Tests: fake-clock timeout/retry/circuit/abort/stream cases and a composed Dify 503-then-success retry test passed. The integrated gate is lint 0, typecheck 0, 18 files / 220 tests, build 0.
- Design decisions: reliability is a `BusinessOrchestrator` decorator; circuit identity is canonical provider plus provider key, while persistence retains the original binding identity; retry count means additional attempts.
- Known issues: circuit state is process/runtime-instance local in V1; cross-process breaker coordination is intentionally out of scope.
- Next step: Milestone 8 guard pipeline.

## Milestone 8 — Guard

- Status: completed
- Completed: provider-neutral Guard primitives and validated pipeline; deterministic credential, prompt-injection, output-leak and unsafe-URL stages; provider-free PII/content-safety/enterprise extension points; Runtime input/output composition; fixed leak-safe guard errors; structured-output traversal; guarded stream buffering, redaction and abort/commit boundary.
- Files changed: `packages/core/src/guard/**`, Guard port/export/runtime composition, `packages/core/src/runtime/chat-runtime.ts`, `packages/core/src/runtime/turn-runner.ts`, focused Guard/runtime tests, `docs/security.md` and lifecycle documentation.
- Tests: Guard primitives passed 85/85 after two independent-review fix rounds; Runtime guard integration passed 26/26 after one fix round. The fresh integrated M8 gate passed: lint 0, typecheck 0, 20 test files / 331 tests, build 0.
- Design decisions: defaults are offline and provider-neutral; injected guards are untrusted and revalidated; enabled output guarding buffers every content-bearing stream event; D-007 compaction remains independent maintenance; `RuntimeStore.commitTurn` invocation is the irreversible cancellation boundary.
- Known issues: redacted multi-delta streams intentionally collapse to one approved sanitized delta; PII/content-safety/enterprise stages require an injected deployment implementation; a stop received after store commit begins cannot roll back or reclassify the committed turn.
- Next step: Milestone 9 DeepSeek Dev UI decision and canonical Demo/API replacement validation.

## Milestone 9 — Dev UI / Demo Validation

- Status: completed
- Completed: inspected official DeepSeek Harness Web UI at fixed commit `47f943859bef60e4160492346772ded9b24f765a`; documented why direct reuse would import Cordis/session/projection/slot/RPC assumptions; retained the independent React/Vite Demo as canonical; added a bounded non-frontend dependency verifier with mutation-oriented fixtures and future-only thin-gateway guidance.
- Files changed: `docs/deepseek-dev-ui.md`, `scripts/frontend-boundary.ts`, `scripts/frontend-boundary.test.ts` and M9 task evidence. Demo, Runtime, API and the DeepSeek source checkout remained unchanged.
- Tests: focused verifier plus Demo API contract passed 10/10 after one independent-review fix round. With `apps/demo-web` temporarily outside the repository, packages/API/scripts passed 20 files / 329 tests; the Demo was restored with exact hashes. The fresh M9 gate passed lint 0, typecheck 0, 21 files / 335 tests and build 0. A built Mock API smoke returned health, canonical blocking `ANSWER`, and ordered SSE completion on the same two endpoints documented for curl and used by the Demo.
- Design decisions: no DeepSeek dependency/fork/gateway in V1; any future compatibility layer is temporary, non-production, replaceable, transport-only and cannot key Skein state by DeepSeek session IDs.
- Known issues: the richer DeepSeek shell is not available as a V1 development UI; this is intentional because a clean direct compatibility layer was not practical at the inspected commit.
- Next step: Milestone 10 observability, E2E hardening, README and open-source scrub.

## Milestone 10 — Observability / Hardening

- Status: completed and independently accepted within the locally verifiable scope.
- Completed: provider-neutral Core telemetry/audit/metrics ports and no-op defaults; content-free Runtime instrumentation; safe Pino/Fastify allowlisting; fixed-channel audit/metrics records; OpenTelemetry-compatible sanitized callbacks; validated `LOG_LEVEL`; production composition through one shared logger/port set; complete Mock public acceptance journey; README and acceptance matrix; executable repository scrub; and the concentrated final XL fixes for `XL-01` through `XL-04` plus `XL-O1` documentation.
- Files changed: Core observability ports/observer and Runtime wiring; `packages/observability`; API config/composition/logger wiring and tests; README and acceptance docs; repository scrub and tests; maintained public-suffix dependency; shared durable provider-key contract; public timeout route evidence; architecture clarification.
- Tests: Task 10A passed physical independent review after two scoped fix rounds. Task 10B completed five bounded fix rounds and a full XL audit. A fresh independent Acceptance Owner scoped to the concentrated fix verified `XL-01`, `XL-02`, `XL-03`, `XL-04` and `XL-O1` as 5/5 addressed with 0 new Critical/Important findings and returned `ACCEPT`. The Main Agent then passed a built `dist` Mock blocking/SSE smoke, Demo client loopback 2 files / 7 tests, frontend-absent Runtime/API boundary 22 files / 364 tests with exact 28-file Demo restoration, and a fresh lint 0 / typecheck 0 / 25 files and 392 tests / full build / scrub clean / diff-check clean gate.
- Design decisions: Core owns only narrow synchronous observability ports; public URL exemptions require maintained ICANN/public-suffix classification and reject private/special-use authorities; Core/API/PostgreSQL share a 191-character durable provider-key maximum; timeout acceptance requires a composed public HTTP 504 regression; D-007 maintenance compaction and D-010 commit semantics remain unchanged.
- Known issues: real Dify smoke is `NOT RUN` without separately authorized credentials; real PostgreSQL migration/restart/persistence is `NOT RUN` without an authorized dedicated database; browser-rendered Demo visual validation is `PARTIAL / NOT RUN`. No credential from the external Dify reference tree was used.
- Next step: local delivery is complete. Real Dify, real PostgreSQL and browser-rendered visual checks remain optional, separately authorized external follow-ups and stay explicitly unclaimed.
