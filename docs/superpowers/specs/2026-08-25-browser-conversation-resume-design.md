# Browser Conversation Resume Design

## Goal

Add a conversation sidebar that survives browser and API-process restarts without introducing a database dependency. The browser keeps a local conversation index and an opaque Skein resume token. After an API restart, Skein uses the token to recover the internal provider conversation binding, fetch canonical history through a provider history port, rebuild the in-memory session, and continue the original provider conversation.

The first provider implementation is Dify. The public API and Demo Web remain provider-neutral.

## Scope

In scope:

- browser `localStorage` persistence for the Demo Web conversation index and cached messages;
- desktop sidebar and responsive mobile drawer;
- opaque encrypted session-resume tokens;
- a provider-neutral conversation-history port;
- Dify `/messages` history retrieval with bounded pagination;
- rebuilding an in-memory Skein session and provider binding after restart;
- switching between cached conversations and continuing the selected session;
- Mock/provider-free behavior that remains usable when resume capability is absent;
- unit, integration, API, frontend, restart, security, and sanitized live-Dify checks.

Out of scope:

- listing Dify conversations that were not created through Skein;
- exposing Dify conversation IDs, URLs, keys, workflow fields, or provider types to the frontend;
- renaming or deleting remote conversations;
- reconstructing historical Skein context revisions, summaries, turns, audit records, or runtime events from Dify;
- replacing the planned PostgreSQL persistence layer;
- authentication, multi-user identity, or enterprise SSO.

## Architecture boundaries

The public identity remains the Skein `sessionId`. A Dify `conversation_id` is never a public session identifier and never appears in browser storage or a public JSON field.

```text
Demo Web localStorage
  -> sessionId + encrypted resumeToken + cached canonical messages
  -> POST /api/v1/sessions/resume
  -> ChatRuntime resume service
  -> ResumeTokenCodec decrypts internal binding claims
  -> ConversationHistorySource loads provider history
  -> RuntimeStore restores session/messages/binding atomically
  -> existing POST /api/v1/chat/stream continues by sessionId
  -> TurnRunner supplies the restored provider conversation ID internally
  -> Dify /chat-messages
```

`packages/core` defines only provider-neutral ports and restore semantics. `packages/adapters/dify` owns Dify paths, authentication, pagination, and payload normalization. `apps/api` owns HTTP routing, environment configuration, and the Node crypto implementation. `apps/demo-web` consumes only public Skein contracts.

## Public contracts

Successful chat results and terminal stream results gain an optional opaque field:

```ts
resumeToken?: string;
```

It is present only when the composed runtime supports restart recovery and a successful provider conversation binding was committed. It contains no readable provider value.

Add:

```text
POST /api/v1/sessions/resume
```

Request:

```json
{ "resumeToken": "opaque-skein-token" }
```

Response:

```json
{
  "session": { "id": "...", "userId": "...", "status": "ACTIVE", "revision": 0, "createdAt": "...", "updatedAt": "...", "lastActiveAt": "..." },
  "messages": [],
  "resumeToken": "refreshed-opaque-skein-token"
}
```

The endpoint is a POST so the token is not placed in URLs, access logs, or browser history. The request and response are strictly validated and size bounded.

## Resume token

`ResumeTokenCodec` is a Core port. The API implementation uses AES-256-GCM with a random 96-bit IV and Base64URL encoding. Versioned encrypted claims contain only the values required to restore one binding:

```ts
interface SessionResumeClaims {
  version: 1;
  sessionId: string;
  userId: string;
  provider: string;
  providerKey: string;
  externalConversationId: string;
  issuedAt: string;
}
```

`SESSION_RESUME_SECRET` is a Base64-encoded 32-byte key. It is required for Dify restart recovery, read only from local environment configuration, and never logged. `.env.example` contains only generation guidance and a placeholder. Changing the secret intentionally invalidates existing browser resume tokens.

Decode fails closed for malformed framing, unknown versions, authentication failure, invalid claims, wrong user, wrong provider, or wrong provider key. Tokens are never placed in telemetry or audit metadata.

## Provider history port

Core defines a `ConversationHistorySource` that accepts the configured provider identity, external conversation ID, and runtime user identity and returns bounded provider-neutral history messages in chronological order.

The Dify implementation:

- calls `GET <baseUrl>/messages` with Bearer app-key authentication;
- sends `conversation_id`, the same opaque `user`, `limit`, and pagination cursor;
- handles Dify's newest-first pages and returns chronological messages;
- maps each Dify row's query and answer to deterministic USER and ASSISTANT canonical messages;
- validates IDs, timestamps, content, response media type, pagination progress, total records, and total bytes;
- maps transport, HTTP, abort, and malformed-response failures to provider-neutral Runtime errors;
- never returns retriever internals, agent thoughts, raw metadata, provider errors, or provider identifiers to the browser.

The default recovery bound is 200 Dify rows per resume. The most recent bounded history is restored. Dify retains the authoritative remote conversation context, so subsequent messages still continue the full provider conversation even when very old messages exceed the local recovery bound.

## Runtime restore semantics

`RuntimeStore` gains an atomic `restoreSession` operation. It creates a missing session with:

- the original Skein session ID from the authenticated token;
- the authenticated runtime user;
- default Skein context at revision `0`;
- chronological canonical history messages;
- the provider binding from the authenticated token;
- timestamps derived from validated history or token issue time.

Restore never overwrites an existing session. If the session already exists for the same user and binding, resume returns the existing canonical history without contacting Dify. An ownership mismatch, binding mismatch, duplicate message ID, or invalid context fails without partial mutation. A concurrent identical restore has one winner; the loser reloads and verifies the committed identity.

After restore, the existing TurnRunner path loads the binding and supplies its external conversation ID to the orchestrator. No special continuation path is added to the frontend or public chat request.

Only messages and the provider binding are reconstructable without PostgreSQL. Structured context, summary, turn history, audit records, runtime events, compaction markers, and prior source metadata restart from their safe defaults. This limitation is visible in documentation and removed later by durable PostgreSQL use.

## Browser persistence and sidebar

Use one versioned localStorage document under `skein.chat.history.v1`:

```ts
interface BrowserConversationCache {
  version: 1;
  activeSessionId?: string;
  conversations: CachedConversation[];
}

interface CachedConversation {
  sessionId: string;
  resumeToken?: string;
  title: string;
  updatedAt: string;
  messages: CachedMessage[];
}
```

Cached messages contain only ID, role, content, and creation time. Pending state, errors, abort controllers, trace IDs, and transient streaming status are never persisted. The first user message becomes a bounded plain-text title.

Startup loads and validates the cache before use. Invalid cache data is ignored with a visible warning and is not silently rewritten or deleted. Storage quota failures preserve current UI state and show a warning. Writes occur after terminal success, explicit stop, restored history, and active-conversation changes rather than on every stream delta.

The sidebar:

- lists newest activity first;
- highlights the active session;
- creates no remote conversation until the first message is sent;
- switches only when no turn is running;
- restores cached content immediately, then reconciles through the resume endpoint when a token exists;
- leaves cached content visible but read-only when remote resume fails;
- provides a retry action for recovery failures;
- keeps New Conversation non-destructive;
- uses a fixed desktop column and an accessible mobile drawer.

No delete, rename, remote conversation list, or automatic history pruning is added.

## Error handling

- Corrupt cache: visible local warning; start a new conversation remains available.
- Missing token: cached history is viewable; continuation is unavailable after backend state loss.
- Invalid or expired-by-key-change token: canonical validation error; cached history remains read-only.
- Provider history not found: session-not-found response; no local restore commit.
- Provider unavailable or malformed response: provider-neutral error; retry remains available.
- Cache and restored history disagreement: authenticated provider history replaces cached canonical messages after successful resume.
- Active streaming turn: sidebar switching is disabled; Stop completes before switching.

## Security

- Raw provider conversation IDs never cross the public API boundary.
- Dify base URL and API key remain server-side local environment values.
- Resume tokens use authenticated encryption and are treated as bearer capabilities.
- Token bodies, message bodies, API keys, URLs, and raw provider errors are absent from logs, metrics, audit metadata, test snapshots, and Git.
- Browser messages are plaintext local user data and therefore accessible to scripts running on the same origin; this limitation is documented.
- Existing input/output guards still apply to new turns. Imported historical messages are validated and size bounded but are not re-emitted as trusted workflow state.

## Verification and acceptance

Tests must prove:

1. Common chat and stream responses carry a valid opaque token only after a binding commit.
2. Token round-trip works across codec instances sharing one secret.
3. Tampering, wrong key, wrong user, provider switch, profile switch, malformed token, and oversize token fail closed.
4. Dify history requests use the configured URL/key internally, stable user identity, correct conversation ID, bounded pagination, and chronological normalization.
5. Dify HTTP, transport, abort, pagination-loop, media-type, size, and schema failures are normalized without secret leakage.
6. A fresh API runtime with an empty in-memory store resumes from a token, imports history, and continues the next Dify request with the same conversation ID.
7. Restore is atomic, ownership-safe, binding-safe, and concurrency-safe in both in-memory and PostgreSQL store contracts.
8. Browser cache parsing rejects malformed or oversized data without deleting it.
9. Sidebar reload, selection, active highlighting, New Conversation, recovery retry, read-only failure, and streaming-switch lock behave as specified.
10. Mock/provider-free chat remains operational without a resume capability.
11. No public response or browser storage fixture contains a raw Dify URL, key, or conversation ID.
12. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm scrub`, and `git diff --check` pass.
13. A sanitized local Dify smoke creates a harmless conversation, restarts the local API runtime, restores its history, and continues it without printing credentials, private URLs, conversation IDs, or response content.

## Delivery sequencing

1. Freeze contracts and token/history/restore ports.
2. Implement and test token codec.
3. Implement and test Dify history retrieval.
4. Implement and test atomic store restore in memory and PostgreSQL adapters.
5. Integrate Runtime response-token issuance and resume flow.
6. Add public API and Demo API-client support.
7. Add browser cache and sidebar behavior.
8. Run focused and full quality gates after each integrated slice.
9. Run sanitized local Dify acceptance.
10. Update public, adapter, persistence, security, status, acceptance, README, and environment documentation; scrub, commit, and push.
