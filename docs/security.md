# Security

Skein treats public input, orchestrator output and injected guard
implementations as untrusted. The Runtime Core remains provider-neutral and
ships cloud-free default guards; external PII and content-safety services can
be supplied only through the `GuardPort` boundary.

## Turn guard boundary

```text
canonical turn identity + AbortSignal
-> input Guard
-> session load / optional maintenance compaction
-> reliability-wrapped BusinessOrchestrator
-> provider-neutral result normalization
-> output Guard
-> context validation and atomic turn commit
-> public response or safe buffered stream release
```

Input guarding happens before session loading, compaction and provider
execution. NFC and line-ending normalization always become the effective
query when input guarding is enabled. A REDACT result replaces the query used
by the immutable snapshot, orchestrator and stored USER message without
mutating the caller's request. REVIEW and BLOCK both stop the turn.

Output guarding covers the answer, follow-up fields, deterministic source
serialization, proposed context patches, concatenated stream deltas, buffered
stream sources and the terminal result. Plain text can be replaced only by a
validated `sanitizedText`. A structured value that would require redaction is
blocked rather than partially rewritten.

## Streaming disclosure control

With output guarding enabled, status events may be emitted immediately, but
assistant deltas and sources remain buffered until the complete delta text,
buffered sources and terminal result pass output guarding and the atomic turn
commit succeeds. This detects credentials split across provider chunks. A
redacted multi-chunk answer is released as one approved sanitized delta at the
first delta position; unsafe original fragments are never released.

With output guarding disabled, the established real-time delta/source behavior
is preserved. Input and output guards can be enabled independently.

## Fixed failure surfaces

Injected guards are composed through the same validated pipeline as default
guards. Guard-supplied messages, causes, reasons, risk labels and stack details
are never trusted. Runtime reconstructs fixed cause-free errors:

- input REVIEW/BLOCK or other unusable input: `INPUT_BLOCKED`;
- output REVIEW/BLOCK, size failure or unusable output: `OUTPUT_BLOCKED`;
- malformed guard result: `PROVIDER_INVALID_RESPONSE`;
- cancellation: `ABORTED`.

No guard error may expose its input, result, secret value or backend detail in
a blocking response, stream event, stored message or context.

## Commit and cancellation semantics

`RuntimeStore.commitTurn` invocation is the irreversible turn commit point.
Cancellation is checked immediately before entry. An abort before entry
creates no successful turn-specific message, context or provider binding. The
store port deliberately has no cancellation or rollback contract, so an abort
arriving after commit starts does not reclassify an already-started atomic
commit; only already-approved buffered output can then be released.

Compaction is separate pre-orchestration maintenance under decision D-007. If
maintenance compaction completed before a later provider, guard or abort
failure, its semantic summary and compacted-message markers remain committed.
They are not part of the failed business turn and never mutate workflow state.

## V1 limits

- Static credential, prompt-injection, output-leak and unsafe-URL protection is
  deterministic and provider-free; it is not a substitute for deployment-
  specific security policy.
- PII, content-safety and enterprise-policy stages are provider-neutral no-op
  extension points until an operator injects an implementation.
- Default guards perform no network, filesystem or logging side effect.
