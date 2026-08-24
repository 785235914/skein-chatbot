# Runtime Lifecycle

Each blocking or streaming turn follows the same safe lifecycle:

```text
validate request and create canonical identity / abort scope
-> normalize and guard input
-> load session aggregate
-> run optional pre-orchestration maintenance compaction
-> validate context and revision
-> build semantic memory
-> clone and deep-freeze TurnSnapshot
-> run reliability-wrapped BusinessOrchestrator
-> normalize provider result
-> guard answer, follow-ups, sources, ContextPatch and stream content
-> validate merged context
-> atomically commit turn, messages, context and provider binding
-> return canonical response or completion event
```

The snapshot never aliases mutable storage state. Provider failure, abort, invalid output, invalid context and optimistic-concurrency conflict cannot commit an assistant message, context patch, summary or conversation binding.

The previous statement applies to turn-specific state. Accepted D-007
maintenance compaction is intentionally independent: a summary and
compacted-message markers committed before orchestration can remain when the
later business turn fails. Compaction does not mutate workflow context or its
revision.

With output guarding enabled, streaming deltas and sources are buffered until
the complete output passes guarding and the same atomic commit succeeds. Safe
status events may remain real time. With output guarding disabled, validated
deltas and sources preserve the established real-time behavior. Every stream
ends with exactly one canonical completion or failure event.

Cancellation is honored through the final check immediately before
`RuntimeStore.commitTurn`. Entry into that call is the irreversible boundary;
an abort that arrives during storage latency does not turn an already-started
atomic commit into an `ABORTED` failure.
