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

## Session resume lifecycle

```text
strict body-only opaque token
-> authenticate/decrypt bounded provider-neutral claims
-> validate user + configured provider + providerKey
-> return an already-compatible aggregate when present
-> otherwise load bounded chronological provider history
-> create deterministic canonical USER/ASSISTANT messages
-> reconstruct default Skein context at revision 0
-> atomically restore session + context + messages + private binding
-> refresh the opaque token
```

Decode, history retrieval, validation or cancellation failure produces no restored rows. Concurrent identical resumes share one in-flight operation; a storage race can return only a fully matching winning aggregate. `restoreSession` rejects an existing or conflicting session rather than rebinding it. A later normal turn uses the restored private binding through the standard turn lifecycle and continues by the public Skein `sessionId`.
