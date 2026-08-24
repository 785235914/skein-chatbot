# Dify Contract

Skein uses Dify's chat-message API only at the adapter boundary. The public Skein API, Runtime Core, storage model and demo do not expose or import Dify protocol types.

## Transport envelope

The adapter sends `POST <DIFY_BASE_URL>/chat-messages` with `Authorization: Bearer <DIFY_API_KEY>` and a JSON body containing:

```json
{
  "inputs": {},
  "query": "...",
  "response_mode": "blocking",
  "user": "opaque-user-id",
  "conversation_id": "optional-existing-binding"
}
```

`query`, `response_mode`, `user`, `conversation_id` and optional `files` are transport-owned. Profile request mappings populate only `inputs`.

## Blocking response

The default profile reads:

- answer from `answer`;
- external conversation binding from `conversation_id`;
- sources from `metadata.retriever_resources`.

Alternative field paths, statuses, sources, follow-up fields and context patches belong in a profile. Missing or type-invalid required fields fail with `PROVIDER_INVALID_RESPONSE`.

## Streaming response

The adapter incrementally parses UTF-8 SSE `data:` fields. A profile selects the event, text and conversation-ID paths plus text, terminal, error and public-status mappings. It accepts only bounded frames and a bounded cumulative answer, rejects malformed UTF-8/JSON and requires a terminal normalized result.

Skein V1 events are additive. Provider events that require retracting emitted text (`message_replace`) are rejected. Paused/human-input workflows are also unsupported in V1. Chatflow completion waits for a successful workflow terminal; provider error events map to canonical Runtime errors.

## Conversation identity

The external `conversation_id` is never a Skein session ID. Runtime stores it as a binding keyed by Skein session, provider and profile-aware `providerKey`, and commits it only after a successful turn.

## Error mapping

HTTP status, safe bounded provider codes and transport failures map to provider-neutral errors such as `PROVIDER_TIMEOUT`, `PROVIDER_RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_INVALID_RESPONSE`, `ABORTED` or `ORCHESTRATION_FAILED`. Provider payloads, stack traces and credentials are not public.
