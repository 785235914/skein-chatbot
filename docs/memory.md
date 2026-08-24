# Memory and Compaction

Runtime memory is semantic conversation context, not authoritative workflow state. Each turn receives the current query separately from a bounded memory value containing the most recent canonical messages and an optional older-message summary.

## Recent window

`MEMORY_RECENT_MESSAGES` defaults to 8. `MemoryContextBuilder` takes the newest active messages in chronological order, clones them into immutable values and validates any stored summary before orchestration.

## Summary

`ConversationSummary` retains a bounded topic, user goals, confirmed facts, unresolved issues, string entities, prior actions and free-form summary text. It has per-field and total-character limits, canonical timestamps and credential-like material redaction. It cannot carry or mutate `SkeinContext.workflow.state`.

## Compaction

Compaction is triggered when active message count reaches `COMPACTION_MESSAGE_THRESHOLD` (default 20), estimated semantic tokens reach `COMPACTION_TOKEN_THRESHOLD` (default 12000), or a caller explicitly requests a manual compaction. The newest configured recent window is never selected as a candidate.

The V1 deterministic provider is cloud-free. It preserves a redacted transcript and prior validated structured summary fields without inventing facts or workflow state. Applications may inject another `CompactionProvider` through `ChatRuntime`.

Compaction runs before business orchestration. A successful commit stores the summary and marks only still-active candidate messages as compacted; it does not change context revision. Two same-revision commits targeting the same IDs have exactly one winner, and the loser receives `SESSION_CONFLICT`. `loadSessionAggregate()` returns active messages for runtime memory, while `getMessages()` preserves complete canonical history.

## Failure behavior

Invalid stored summaries fail as `CONTEXT_INVALID`; invalid provider summaries fail as `PROVIDER_INVALID_RESPONSE`; abort is propagated before summarization and commit. A failed or conflicting compaction does not invoke the business orchestrator and cannot partially commit a chat turn.
