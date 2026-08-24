# Skein Chatbot

A headless, provider-agnostic backend framework for secure, stateful AI chat applications.

## Why Skein

Skein keeps the public REST/SSE contract, session lifecycle, memory, guards and persistence independent from an AI provider. Providers are composition-time adapters; the Core runtime carries no provider workflow, key, URL or business schema.

## Architecture

The API is a modular monolith: client -> public REST/SSE -> `ChatRuntime` -> `BusinessOrchestrator` and `RuntimeStore` ports. Guards, compaction, audit, metrics and telemetry are ports around the same turn lifecycle. Each turn validates input, builds a frozen snapshot, safely commits validated context and canonical messages, then serializes only public fields. See [architecture](docs/architecture.md).

## Quick Start

Use the provider-free Mock journey first:

```text
pnpm install
pnpm dev:mock
```

`pnpm dev:mock` needs no Dify key, cloud account or PostgreSQL credentials. When `DATABASE_URL` is empty, the API uses the in-memory store. The React/Vite Demo is the canonical client at its displayed local URL.

`ENABLE_MEMORY`, `ENABLE_COMPACTION`, `ENABLE_STREAMING`, and `ENABLE_DEEP_MODE` in `.env.example` are reserved, no-op V1 compatibility entries. V1 currently keeps those capabilities available; setting any of these entries to `false` does not disable or otherwise change Runtime behavior.

## Public API

`POST /api/v1/chat` is the blocking endpoint and `POST /api/v1/chat/stream` returns SSE. Sessions are available through `GET /api/v1/sessions/:sessionId`, ordered messages through `GET /api/v1/sessions/:sessionId/messages`, reset through `POST /api/v1/sessions/:sessionId/reset`, and active-turn abort through `POST /api/v1/sessions/:sessionId/abort`. Liveness and readiness are `GET /api/v1/health` and `GET /api/v1/ready`. Contract details are in [public API](docs/public-api.md).

## Dify Adapter

Dify is the first `BusinessOrchestrator` adapter, not a Core dependency. Configure ignored local values and start `pnpm dev:dify`; see [Dify adapter](docs/dify-adapter.md).

## Switching Dify Apps

For API-key-only switching, set `DIFY_API_KEY` to the newly authorized app key, restart the API composition, and begin a fresh Skein session. Do not reuse an existing session: its external conversation binding is intentionally never rebound. No Core code changes are needed.

## Dify Profiles

When app field names differ, create an ignored local profile from the documented example, set `DIFY_PROFILE` to that profile name, and restart `pnpm dev:dify`. Profiles translate adapter schema names at the edge; `packages/core` and the public contract stay unchanged.

## Session

The public `sessionId` is the Skein identity. External provider conversation IDs remain private bindings and are never public session fields.

## Context

Context is generic JSON with validated, bounded patches. Each turn uses an immutable snapshot, and a safe commit atomically records canonical messages, context revision, and permitted bindings.

## Memory

Semantic memory contains a recent-message window plus an optional redacted older-summary; it is never workflow authority. See [memory and compaction](docs/memory.md).

## Compaction

Compaction summarizes only older active messages before orchestration and safely commits only on success. It cannot partially mutate a business turn.

## Guards

Input and output guards can reject unsafe content before any public result. Guard decisions do not expose provider internals.

## Reliability

Reliability adds timeout, constrained retry and circuit-breaker policy around normalized adapter failures; it never reads provider payloads. See [reliability](docs/reliability.md).

## Streaming

SSE exposes canonical started, status, delta, source and terminal events only; it never exposes provider internals.

## Persistence

PostgreSQL is selected only by a non-empty `DATABASE_URL`; otherwise persistence is in memory. The PostgreSQL setup and opt-in restart verification are documented in [persistence](docs/persistence.md).

## Frontend Integration

The React/Vite Demo speaks only the public API and is canonical. It is replaceable because it depends only on REST and SSE contracts.

## DeepSeek Dev UI

DeepSeek UI is not imported. A future compatibility gateway, if separately built, is transport-only, replaceable and cannot become a business or persistence boundary. See [DeepSeek Dev UI boundary](docs/deepseek-dev-ui.md).

## Safe Observability

Set `LOG_LEVEL` to one of the supported Pino levels; `.env.example` uses `info`. Observability records bounded operational fields and redacts request secrets, authorization, cookies, provider payloads and connection strings. It does not change public API serialization.

## Testing

```text
pnpm scrub
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The provider-free HTTP journey is `pnpm exec vitest run scripts/mock-public-e2e.test.ts`. The acceptance mapping is [e2e acceptance](docs/e2e-acceptance.md).

## Extension Points

Add provider behavior through a `BusinessOrchestrator`, persistence through `RuntimeStore`, compaction through `CompactionProvider`, and operational integrations through observability ports.

## Roadmap

Future work may add independently replaceable adapters and transport gateways without changing Core or the public contract.

## Open-source Security Notes

Run `pnpm scrub` before publishing. It scans only Git cached and unignored public candidates and reports rule, repository-relative path and line number without printing matched values. Keep credentials in ignored local configuration; never commit provider keys, connection strings, private keys, private network addresses or machine paths.

Real Dify smoke and real PostgreSQL restart verification are **NOT RUN** without separately authorized local credentials and a dedicated database. Their commands are implemented, but no external compatibility claim is implied by provider-free tests.
