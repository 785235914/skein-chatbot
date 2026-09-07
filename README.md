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
pnpm build
pnpm dev:mock
```

`pnpm dev:mock` needs no Dify key, cloud account or PostgreSQL credentials. When `DATABASE_URL` is empty, the API uses the in-memory store. The React/Vite Demo is the canonical client at its displayed local URL.

Use Node 24 and the pinned pnpm version. Development runs API and Demo together; `pnpm dev` starts only the API. Default ports are API 3000 and Demo 5173. Stop with Ctrl+C. If a port is occupied, stop the process you own or configure an alternate API `PORT` and matching Demo `VITE_DEV_API_TARGET` in its own ignored local environment file.

For Dify, copy `.env.example` to `apps/api/.env.local`, fill `DIFY_BASE_URL` (the API base ending in `/v1`, without `/chat-messages`), `DIFY_API_KEY`, `DIFY_PROFILE=default`, and a generated `SESSION_RESUME_SECRET`. Keep the same secret across restarts. Run `pnpm doctor:dify` before `pnpm dev:dify`. The doctor validates configuration without connecting to Dify or a database and prints only invalid field names. `pnpm doctor` uses the configured provider (Mock when unset).

`ENABLE_MEMORY`, `ENABLE_COMPACTION`, `ENABLE_STREAMING`, and `ENABLE_DEEP_MODE` in `.env.example` are reserved, no-op V1 compatibility entries. V1 currently keeps those capabilities available; setting any of these entries to `false` does not disable or otherwise change Runtime behavior.

## Public API

`POST /api/v1/chat` is the blocking endpoint and `POST /api/v1/chat/stream` returns SSE. Sessions are available through `GET /api/v1/sessions/:sessionId`, ordered messages through `GET /api/v1/sessions/:sessionId/messages`, opaque-token recovery through `POST /api/v1/sessions/resume`, reset through `POST /api/v1/sessions/:sessionId/reset`, and active-turn abort through `POST /api/v1/sessions/:sessionId/abort`. Liveness and readiness are `GET /api/v1/health` and `GET /api/v1/ready`. Contract details are in [public API](docs/public-api.md).

## Dify Adapter

Dify is the first `BusinessOrchestrator` adapter, not a Core dependency. Configure ignored local values and start `pnpm dev:dify`; see [Dify adapter](docs/dify-adapter.md).

## Switching Dify Apps

For API-key-only switching, set `DIFY_API_KEY` to the newly authorized app key, restart the API composition, and begin a fresh Skein session. Do not reuse an existing session: its external conversation binding is intentionally never rebound. No Core code changes are needed.

## Dify Profiles

When app field names differ, create an ignored local profile from the documented example, set `DIFY_PROFILE` to that profile name, and restart `pnpm dev:dify`. Profiles translate adapter schema names at the edge; `packages/core` and the public contract stay unchanged.

## Session

The public `sessionId` is the Skein identity. External provider conversation IDs remain private bindings and are never public session fields.

When Dify recovery is configured, a completed chat returns an optional opaque `resumeToken`. The Demo stores that token with canonical messages and the Skein `sessionId`, then posts it in a JSON body after a browser or API restart. A fresh in-memory Runtime can retrieve bounded provider history, atomically rebuild the same Skein session and continue the private provider conversation. Tokens never belong in URLs or logs.

Generate the required local 32-byte key with Node, and copy only the output into the ignored `apps/api/.env.local` used by `pnpm dev:dify`:

```text
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

```text
SESSION_RESUME_SECRET=replace-with-generated-base64-value
```

Changing this secret invalidates existing browser resume tokens. Mock mode intentionally issues no token; tokenless Mock conversations remain usable from the browser cache while the same API process still owns their in-memory sessions.

Find saved conversations with the sidebar search (title or public Skein session ID). Selecting one shows cached messages immediately and reconciles them with server history when a token exists. **Refresh history** repeats this reconciliation. Recovery times out after 30 seconds with retry available; you can choose another conversation or start a new one while it is pending. Unsent drafts stay with each selected conversation for the current page lifetime.

This browser index contains only conversations saved through Skein on the same browser origin. It does not import arbitrary existing Dify web-app conversations from a pasted ID. Dify requires the original app and `user` identity to read its history; the backend preserves that association inside the encrypted token. Changing the browser origin/port creates a separate local cache. Clearing browser data removes this local index; keep PostgreSQL for complete durable Skein state when needed.

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

PostgreSQL is selected only by a non-empty `DATABASE_URL`; otherwise persistence is in memory. Dify token recovery can reconstruct an in-memory session after restart, but it restores provider-visible message pairs with default context revision `0`, not Skein-only workflow/context state. PostgreSQL remains the full durability path. Setup and opt-in restart verification are documented in [persistence](docs/persistence.md).

## Frontend Integration

The React/Vite Demo speaks only the public API and is canonical. Its responsive conversation sidebar persists a versioned `skein.chat.history.v1` cache in browser localStorage, displays cached messages immediately, then replaces them with canonical recovered history when a resume token is available. Each conversation is capped at 400 cached messages; malformed, oversized or quota-failing cache data produces a warning and is not silently deleted or pruned. Browser storage contains message content and an opaque bearer-like token, so production deployments must account for device privacy and XSS risk. The client remains replaceable because it depends only on REST and SSE contracts.

## DeepSeek Dev UI

DeepSeek UI is not imported. A future compatibility gateway, if separately built, is transport-only, replaceable and cannot become a business or persistence boundary. See [DeepSeek Dev UI boundary](docs/deepseek-dev-ui.md).

## Safe Observability

Set `LOG_LEVEL` to one of the supported Pino levels; `.env.example` uses `info`. Observability records bounded operational fields and redacts request secrets, authorization, cookies, provider payloads and connection strings. It does not change public API serialization.

## Testing

Run the complete provider-free gate with `pnpm check`. It generates the Prisma client, then runs lint, typecheck, tests, build and the public-candidate scrub. GitHub Actions runs the same command on Linux and Windows with Node 24 and no external service credentials.

```text
pnpm scrub
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The provider-free HTTP journey is `pnpm exec vitest run scripts/mock-public-e2e.test.ts`. The sanitized Dify restart/resume journey is `pnpm smoke:dify`; it reports `NOT RUN` when ignored local configuration is incomplete. The acceptance mapping is [e2e acceptance](docs/e2e-acceptance.md).

## Extension Points

Add provider behavior through a `BusinessOrchestrator`, persistence through `RuntimeStore`, compaction through `CompactionProvider`, and operational integrations through observability ports.

## Roadmap

Future work may add independently replaceable adapters and transport gateways without changing Core or the public contract.

## Open-source Security Notes

This repository is a starter framework and single-user local demo. The sample routes use a fixed demo identity. Before shared Internet deployment, supply authentication and session ownership checks, rate limits, HTTPS and an appropriate persistence/retention policy. Encrypted resume tokens alone are not a multi-user authorization system.

Run `pnpm scrub` before publishing. It scans only Git cached and unignored public candidates and reports rule, repository-relative path and line number without printing matched values. Keep credentials in ignored local configuration; never commit provider keys, connection strings, private keys, private network addresses or machine paths.

Real Dify restart/resume smoke and real PostgreSQL restart verification are **NOT RUN** without complete ignored local Dify configuration and a separately authorized dedicated database. Their commands are implemented, but no external compatibility claim is implied by provider-free tests.
