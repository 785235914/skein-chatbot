# Architecture

Skein Chatbot is a headless, provider-agnostic modular monolith. Its public protocol and runtime lifecycle are authoritative; providers, storage, observability implementations and frontends are replaceable edges.

```text
Client
  -> Public REST/SSE contract
    -> Chat Runtime
      -> BusinessOrchestrator port
        -> selected provider adapter

Chat Runtime
  -> RuntimeStore port -> in-memory or PostgreSQL implementation
  -> ResumeTokenCodec port
  -> ConversationHistorySource port
  -> Guard ports
  -> CompactionProvider port
  -> Audit / Metrics / Telemetry ports
```

## Principles

- Core is headless and provider-agnostic.
- Business logic belongs to orchestrators.
- Providers are adapters selected at the composition root.
- The frontend contract is stable and contains no provider internals.
- State is durable and structured.
- Memory is semantic context, not authoritative workflow state.
- Each turn uses a deeply immutable snapshot.
- Provider output proposes a bounded context patch.
- Runtime validates and atomically commits the patch and canonical messages.
- Security and reliability surround every provider.

## Dependency rule

`contracts` has no framework dependency beyond validation. `core` depends on `contracts`. Adapter, persistence and observability packages depend inward on ports; Core never imports them. `apps/api` is the composition root. `apps/demo-web` uses only the public HTTP/SSE contract.

Architecture tests and the open-source scrub reject forbidden inward dependencies and provider/business strings in Core.

## Safe turn lifecycle

```text
validate request
-> input guard
-> load session aggregate
-> build memory
-> deep-freeze turn snapshot
-> reliability-wrapped orchestration
-> output guard
-> validate and sanitize context patch
-> optimistic atomic commit
-> public response or runtime events
```

A failed business execution commits no completed business turn, canonical user or assistant message, context change or provider binding. A bounded failed-turn lifecycle record may still be retained. D-007 maintenance compaction is a separate pre-orchestration commit, so an already committed summary and compacted-message markers may remain when the later business execution fails; that maintenance state never changes workflow context or its revision.

## Conversation identity

Skein `sessionId` is the public identity. A provider conversation ID is stored in a separate binding identified by `(sessionId, provider, providerKey)`. The adapter returns it through a provider-neutral internal result field; Runtime commits it with the turn. It is never a public session ID.

## Restart recovery boundary

```text
Browser versioned cache
  -> POST /api/v1/sessions/resume { resumeToken }
    -> provider-neutral token claims
      -> ConversationHistorySource
        -> RuntimeStore.restoreSession (atomic)
          -> normal chat continuation by Skein sessionId
```

The browser stores only the public Skein `sessionId`, canonical USER/ASSISTANT messages, a title and an authenticated opaque token. The API's AES-256-GCM codec is an edge implementation; Core sees only `ResumeTokenCodec` and provider-neutral claims. Dify owns its `/messages` protocol behind `ConversationHistorySource`. Neither the public contract nor Core imports Dify types.

Restore first checks for an existing compatible aggregate. A fresh store loads at most 200 provider history rows, maps each row to deterministic canonical user/assistant messages, reconstructs the default generic context at revision `0`, and inserts session, context, messages and binding atomically. A conflicting owner or binding is never overwritten. This path restores conversation continuity; it does not claim to recreate provider-invisible Skein summaries, turns or workflow context.

## Modular-monolith choice

V1 deliberately excludes a custom planner/RAG engine, vector database, multi-agent engine, Kafka, Kubernetes and microservices. The boundaries are package-level ports in one deployable API process, keeping failure recovery and transactions understandable while preserving future replacement points.
