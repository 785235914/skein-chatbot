# Public API

The V1 contract is provider-neutral. JSON bodies are strict: unknown top-level fields are rejected. Provider URLs, keys, workflow fields, raw metadata and external conversation IDs never appear.

## Chat

### `POST /api/v1/chat`

Request:

```json
{
  "sessionId": "optional-existing-session",
  "message": "Hello",
  "mode": "quick",
  "metadata": {}
}
```

`mode` is optional and uses the configured default. Public values are `quick` and `deep`; Runtime converts them to `QUICK` and `DEEP`.

Successful response:

```json
{
  "sessionId": "session-id",
  "turnId": "turn-id",
  "answer": "Hello",
  "status": "ANSWER",
  "sources": [],
  "followUpQuestion": "",
  "followUpGuidance": "",
  "metadata": {}
}
```

When the selected composition supports provider-history recovery, the response also contains an opaque `resumeToken`. The token is optional so provider-free and adapters without a history source retain the same chat contract. It contains no public provider field and must be treated as sensitive client state.

### `POST /api/v1/chat/stream`

The request is identical. The response is `text/event-stream` and exposes only:

- `turn.started`
- `status.changed`
- `assistant.delta`
- `source.added`
- `turn.completed`
- `turn.failed`

A stream ending without `turn.completed` is a provider failure. Once any assistant delta has been emitted, a broken stream is not retried.

## Sessions

### `POST /api/v1/sessions/resume`

The token is accepted only in a strict JSON body, never in a URL or query string:

```json
{
  "resumeToken": "opaque-token"
}
```

The response replaces any browser-cached history with canonical Runtime history and refreshes the token:

```json
{
  "session": {
    "id": "skein-session-id",
    "userId": "demo-user",
    "status": "ACTIVE",
    "revision": 0,
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z",
    "lastActiveAt": "2026-01-01T00:00:00.000Z"
  },
  "messages": [],
  "resumeToken": "refreshed-opaque-token"
}
```

If the Skein aggregate still exists and its owner/provider binding matches, the endpoint returns its complete canonical history. Otherwise a recovery-capable adapter retrieves external history and Runtime atomically restores the original Skein `sessionId`, owner, private binding, messages and a default context at revision `0`. Token tampering is rejected as `VALIDATION_ERROR`; owner/provider/profile mismatches are indistinguishable from `SESSION_NOT_FOUND`. V1 composes live restart recovery only for Dify.

### `GET /api/v1/sessions/:sessionId`

Returns canonical session timestamps, status and context revision. It does not return provider bindings.

### `GET /api/v1/sessions/:sessionId/messages`

Returns `{ "messages": MessageView[] }` in ascending creation order. Only canonical USER, ASSISTANT and safe SYSTEM_EVENT content is returned.

### `POST /api/v1/sessions/:sessionId/reset`

Returns:

```json
{ "sessionId": "session-id", "status": "RESET", "revision": 3 }
```

Reset clears active context, summary and provider bindings while retaining audit-safe history according to the store implementation. It never deletes a Skein session.

### `POST /api/v1/sessions/:sessionId/abort`

Returns:

```json
{ "sessionId": "session-id", "aborted": true }
```

`aborted` is false when no active turn exists. Abort propagates to the provider and does not commit a partial turn.

## Health

- `GET /api/v1/health` returns liveness `{ "status": "ok" }`.
- `GET /api/v1/ready` returns readiness and safe boolean checks; HTTP 503 when not ready.

## Errors

HTTP failures use a canonical public error, never stack traces or raw provider responses:

```json
{
  "code": "PROVIDER_TIMEOUT",
  "message": "The AI service took too long to respond.",
  "retryable": true,
  "traceId": "trace-id"
}
```

`ChatResponse.status = ERROR` is reserved for future success-envelope compatibility and is not used to hide ordinary HTTP failures.
