# Skein Chatbot Implementation Plan

## Outcome

Deliver a modular, headless TypeScript backend whose stable REST/SSE API owns session, context, memory, guard, reliability, persistence, and observability concerns while calling business orchestrators only through `BusinessOrchestrator`.

## Frozen boundaries

```text
apps/api -> composition root only
apps/demo-web -> public REST/SSE contract only
packages/core -> contracts and injected ports only
packages/adapters/* -> provider transports and normalization
packages/persistence/postgres -> repository implementations
packages/observability -> injected telemetry implementations
```

Runtime Core has no provider package import. Provider adapters have no database ownership. Frontends receive no provider URL, API key, node name, workflow structure, or external conversation ID.

## Interface freeze

The master contract is adopted with one provider-neutral completion field needed for atomic binding persistence:

```ts
providerConversationId?: string;
```

It may appear on internal `OrchestrationResult` and the terminal orchestration event. It is not part of the public chat response. Without this field, Core would have to parse provider metadata or an adapter would have to mutate storage before the safe commit.

API-key-only provider switching is tested with new Skein sessions. Existing sessions retain their binding namespace (`provider`, `providerKey`) and are never silently rebound.

## Milestone task graph

| Milestone | Deliverable | Principal checks | Depends on |
|---|---|---|---|
| 0 | Sanitized source analysis, environment evidence, this plan | source hashes unchanged; no private values in repo | none |
| 1 | pnpm workspace, strict TS, contracts, core ports, mock adapter, Fastify health/readiness, demo shell | unit contract tests; lint/typecheck/test/build | 0 |
| 2 | chat, stream, session lifecycle, canonical runtime events | API injection tests and SSE parsing | 1 |
| 3 | Dify profile loader, transport, blocking/stream parsing, normalization, provider errors, sanitized smoke command | mock Dify integration matrix; switching tests | 2 |
| 4 | Prisma schema/migration and PostgreSQL repositories | generated client; repository contract tests; real restart test when credentials exist | 2 |
| 5 | immutable turn snapshot, context validation/patch, optimistic safe commit | patch/security/conflict/atomicity tests | 4 |
| 6 | recent window, summary, deterministic compaction, memory builder | threshold/window/state-integrity tests | 5 |
| 7 | timeout, transient retry, circuit breaker, abort propagation | fake-clock and abort integration tests | 3, 5 |
| 8 | input/output guard pipeline, secrets, injection, safety ports | redact/block/discussion/leak tests | 2, 7 |
| 9 | replaceable React/Vite demo; DeepSeek UI decision document | UI build; public API smoke; deletion-boundary check | 2, 7, 8 |
| 10 | Pino wiring, audit, metrics/telemetry ports, E2E, docs and scrub | E2E matrix; secret/business-string scan | all |

## Incremental execution rules

1. Freeze contracts before delegating path-isolated packages.
2. Keep root configuration and `.agent-work` under the Main Agent.
3. Integrate shared contracts serially.
4. After every milestone run, from the repository root:

   ```text
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm build
   ```

5. Do not proceed while any of the four commands is red.
6. Update `docs/implementation-status.md` with evidence after every gate.
7. Use Mock orchestration and in-memory repositories for provider-free development; PostgreSQL and Dify are runtime-selectable adapters.
8. Never use secret-bearing local exports as configuration.

## Environment

- Node 24.18.0 satisfies Node 22+.
- pnpm 11.9.0 is available and will be pinned in `packageManager`.
- PostgreSQL 17.10 is accepting connections at `127.0.0.1:5432`; credentials and the dedicated database are currently unknown.
- Docker is unavailable and is not required.
- Ports 3000 and 5173 were free during reconnaissance.
- The inspected DeepSeek Harness web shell is coupled to its host bootstrap/RPC/session model. V1 therefore keeps the required independent demo and documents a compatibility gateway instead of importing UI internals.

## Required acceptance scenarios

- Stable blocking and streaming API with Mock.
- New/multi-turn/reload/reset/abort session flows.
- Quick/deep mode normalization.
- Sources/follow-up/error rendering.
- Input redact/block and output leak prevention.
- Timeout, retry, circuit breaker and abort.
- Revision conflict and failed-provider atomicity.
- Long-chat compaction without workflow-state mutation.
- Provider switch by configuration.
- Two mock Dify apps switched by API key only with fresh sessions.
- Two Dify profiles switched without Core changes.
- curl and demo client use identical public endpoints.
- Removing frontend directories does not affect runtime tests.
- Repository scrub contains no company content, private host, credential, or confidential prompt.

## External verification limits

The code and mock integrations can be completed without external access. A real Dify smoke run and real PostgreSQL restart run require authorized `.env.local` credentials. If unavailable, the commands and sanitized reporting remain implemented and those two environment checks are reported as unperformed, not passed.
