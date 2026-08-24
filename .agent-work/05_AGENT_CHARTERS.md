# Agent Charters

## M0-SA — Source analysis

- Objective: read all local exports, extract protocol structure, preserve hashes and expose no private values.
- Allowed: read-only reference directory.
- Output: sanitized findings to Main Agent.
- Status: accepted with a secret stop; Main Agent completed full structural parse through a non-outputting safe parser.

## M0-ENV — Environment reconnaissance

- Objective: inspect toolchain, PostgreSQL and external UI coupling without changes.
- Output: version/availability evidence and recommended local path.
- Status: accepted.

## M0-ARCH — Architecture and acceptance

- Objective: freeze dependency direction, milestone graph and negative acceptance checks.
- Output: architecture/QC handoff.
- Status: accepted. The provider-neutral binding result and negative acceptance matrix were incorporated.

Further implementation charters are added only after shared contracts are frozen. Each writer receives exclusive package paths; root configuration, plans and integration stay with the Main Agent.

## M2-RUNTIME — Public runtime and in-memory store

- Allowed: `packages/core/**`, `packages/test-utils/**`.
- Output: ChatRuntime/TurnRunner, active-turn registry, canonical event conversion, aggregate store and 18 focused runtime/store scenarios.
- Status: accepted after full root gate and live API smoke.

## M2-API — Fastify public routes

- Allowed: `apps/api/**`.
- Output: chat/stream/session/reset/abort routes, composition, validated config and public error mapping.
- Status: accepted after 73-test full gate and live blocking/SSE smoke.

## M3-DIFY — Dify reference adapter

- Allowed: `packages/adapters/dify/**`, `config/dify-profiles/**`, `scripts/smoke-dify.ts`.
- Output: validated profile loader, HTTP/SSE transport, normalization, binding, canonical errors and sanitized smoke command.
- Status: accepted after 115-test full gate and independent 44-test focused rerun; real-provider smoke remains unperformed because `.env.local` is absent.

## M3-API — Provider composition

- Allowed: `apps/api/**`.
- Output: conditional `mock|dify` composition, environment validation, profile-aware provider identity and secret-safe startup failure.
- Status: accepted after composition/config tests and the integrated M3 gate.

## M4-PG — PostgreSQL persistence

- Allowed: `packages/persistence/postgres/**`, `prisma/**`; existing PostgreSQL databases are read-only/protected.
- Output: Prisma schema/migration, atomic RuntimeStore adapter, repository conformance tests and an opt-in real restart check.
- Baseline: no M4 implementation files; current RuntimeStore interface is read-only to this workstream.
- Status: accepted after Prisma validation/client generation, 13 focused repository tests and the 171-test integrated gate. PostgreSQL 17.10 is accepting connections on `127.0.0.1:5432`, but noninteractive login is unavailable because no password was supplied; no database mutation occurred.

## M5-CTX — Context and immutable snapshot

- Allowed: bounded Core context/merge/result/snapshot/turn integration paths and Core tests; RuntimeStore and persistence paths are protected.
- Output: JSON structural limits, reserved-key ownership, optional extension validation, safe merge/commit and immutable snapshot regression tests.
- Status: accepted after 21 focused boundary/atomicity tests and the integrated 171-test gate.

## M4-API-PG — API persistence composition

- Allowed: `apps/api/**`; all database operations and external configuration are protected.
- Output: presence-based `DATABASE_URL` selection, injected Postgres factory, connection cleanup and secret-safe config/composition tests.
- Status: accepted after presence-based configuration, injected-factory lifecycle/error tests and the 220-test integrated gate; no real database access was performed.

## M6-MEM — Memory and compaction

- Allowed: isolated Core memory/compaction modules and new tests, followed by serialized runtime integration after M5.
- Output: recent window, validated summary, token/count/manual triggers, deterministic redacted fallback, compaction service and no-repeat active-message contract.
- Status: accepted after runtime integration, same-revision duplicate-compaction repair, independent task review and the 220-test integrated gate. Live PostgreSQL concurrency remains externally unperformed.

## M7-REL — Reliability decorator

- Allowed: new `packages/core/src/reliability/**` and a new focused test only.
- Output: provider-neutral timeout, selective retry, isolated circuit breaker and abort for blocking/streaming calls.
- Status: accepted after API composition wiring, independent task review and the 220-test integrated gate. One non-blocking final-review item remains: make the composed retry test's provider-detail non-leak assertion explicit.

## M8A-GUARD — Provider-neutral Guard primitives

- Allowed: `packages/core/src/guard/**`, the Guard port/export and focused Guard tests; Runtime integration and provider adapters were protected.
- Output: normalized Guard contract, static credential and prompt-injection controls, output leak/unsafe-URL protection, discussion handling, validated composition and provider-free extension stages.
- Status: accepted after two TDD fix rounds and independent scoped review; 85/85 focused Guard tests passed with no open Critical/Important finding.

## M8B-RUNTIME-GUARD — Runtime guard composition

- Allowed: `ChatRuntime`, `TurnRunner`, a focused runtime-integration test and the task report; Guard primitives, config, contracts, adapters, persistence and API were protected.
- Output: input-before-prepare and output-before-commit guarding, leak-safe fixed errors, complete structured traversal, guarded-stream buffering/redaction and explicit abort/commit semantics.
- Status: accepted after one TDD fix round and independent scoped review; 26/26 focused tests and the fresh 331-test/lint/typecheck/build integrated gate passed.

## M9-DEMO — Replaceable frontend validation

- Allowed: DeepSeek compatibility decision documentation and a bounded frontend-dependency verifier/test; Demo, Runtime, API, root configuration and the fixed upstream checkout were protected.
- Output: evidence-backed direct-reuse decision, future-only thin-gateway boundary, exact curl/Demo REST/SSE mapping and mutation-oriented non-frontend dependency checks.
- Status: accepted after one TDD fix round and independent scoped review. Main Agent restored the temporarily removed Demo with exact hashes, passed the 329-test frontend-removal boundary, the 335-test/lint/typecheck/build M9 gate and a live built Mock REST/SSE smoke.

## M10A-OBS — Observability composition

- Allowed: provider-neutral Core telemetry/audit/metrics ports and Runtime observer paths; `packages/observability/**`; bounded API logger/composition/config paths and focused tests.
- Protected: provider adapters, persistence behavior, public contracts, external Dify references and Main-Agent control records.
- Output: content-free Runtime instrumentation, fixed-channel audit/metrics events, safe Pino wiring and OpenTelemetry-compatible callbacks.
- Status: accepted after two independent scoped fix rounds, 63/63 focused observability/API tests, 13/13 Core regression tests and the 23-file/364-test phase gate.

## M10B-HARDEN — Public acceptance and scrub

- Allowed: README/acceptance documentation, Mock public E2E, repository scrub and the explicitly required hygiene fixes; control records remained Main-Agent-owned.
- Protected: external Dify reference materials, credentials, real databases, task history and unrelated source.
- Output: complete 19-row acceptance matrix, provider-free public journey, executable fail-closed candidate scrub and public documentation.
- Status: implemented after five bounded fix rounds. The mandatory final XL audit carried one breaker finding forward and returned `FIX_REQUIRED` with 0 Critical, 3 Important, 1 Minor and 1 Observation.

## FINAL-XL-AUDIT — Physical independent acceptance

- Owner: independent Acceptance Owner `/root/final_xl_audit`.
- Allowed: read-only whole-repository inspection and one review report under the SDD workspace.
- Output: `final-xl-review.md` with specification and production-quality verdicts, exact findings and external-check limitations.
- Status: completed with `FIX_REQUIRED`; its findings are the frozen scope for the one concentrated final fix wave.

## FINAL-XL-FIX — Concentrated final implementation wave

- Owner: Implementation Owner `/root/final_xl_fix`.
- Allowed: the exact 18 implementation/test/public-document paths listed in `final-xl-fix-brief.md` plus its report; Main-Agent controls were protected.
- Output: maintained public-suffix classification, one shared 191-character provider-key contract, composed public timeout evidence, architecture clarification and reserved-switch documentation.
- Status: implemented with focused 6 files / 102 tests and full lint/typecheck/25 files/392 tests/build/scrub/diff-check evidence; awaiting the original XL auditor's single scoped re-review.

## FINAL-XL-REVIEW — Scoped fix verification

- Owner: original independent Acceptance Owner `/root/final_xl_audit`.
- Allowed: read-only inspection of the frozen re-review package and current artifacts; only `final-xl-fix-re-review.md` may be written.
- Acceptance: verdict every original finding `XL-01`, `XL-02`, `XL-03`, `XL-04`, `XL-O1` as addressed/not addressed, report any Critical/Important breakage introduced by the concentrated diff, and issue one final scoped verdict.
- Status: accepted by fresh physical independent reviewer: 5/5 original findings addressed, 0 new Critical/Important breakage, final scoped verdict `ACCEPT`. No second final fix wave was used.
