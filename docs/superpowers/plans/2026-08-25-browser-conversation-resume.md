# Browser Conversation Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browser-persisted conversation sidebar that can rebuild an in-memory Skein session from Dify history after an API restart and continue the original provider conversation without exposing Dify identifiers.

**Architecture:** Demo Web stores canonical cached messages plus an opaque encrypted resume token in versioned localStorage. Core owns provider-neutral resume claims, history and restore ports; the API supplies AES-256-GCM token crypto; the Dify adapter retrieves bounded history; Runtime restores messages and binding atomically before the normal chat path continues by Skein session ID.

**Tech Stack:** Node.js 22+, TypeScript 5, Fastify, Zod, React 19, Vite, Vitest, Web Crypto/Node `crypto`, Prisma/PostgreSQL adapter, Dify App API.

**Spec:** `docs/superpowers/specs/2026-08-25-browser-conversation-resume-design.md`

## Global Constraints

- `packages/core` and public contracts remain provider-neutral.
- Raw Dify URL, API key, conversation ID, payload metadata, and business fields never cross the public API or browser-cache boundary.
- `SESSION_RESUME_SECRET` is a Base64-encoded 32-byte local secret and is never logged or committed.
- The public session identity remains the Skein `sessionId`.
- Restore is atomic and must never overwrite a conflicting existing session.
- Dify history retrieval is bounded to 200 rows and 8 MiB of response data per page/validated cumulative limits.
- Demo cache parsing treats localStorage as untrusted input and never silently deletes or prunes history.
- Existing Mock chat remains functional when resume capability is absent.
- Every production change follows RED -> GREEN -> REFACTOR and the complete gate is `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm scrub && git diff --check`.
- `.env.local`, Dify address, Dify API key, live conversation IDs, and live response bodies remain untracked.

---

### Task 1: Freeze resume public contracts and Core ports

**Files:**
- Modify: `packages/contracts/src/public.ts`
- Modify: `packages/core/src/ports/runtime-store.ts`
- Create: `packages/core/src/ports/conversation-history.ts`
- Create: `packages/core/src/ports/resume-token.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/contracts/test/public.test.ts`
- Test: `packages/core/test/core-contracts.test.ts`

**Interfaces:**
- Produces: `resumeToken?: string` on `ChatResponse`.
- Produces: `ResumeSessionRequest`, `ResumeSessionResponse`, and their strict Zod schemas.
- Produces: `SessionResumeClaims`, `ResumeTokenCodec`, `ConversationHistorySource`, `ConversationHistoryEntry`, `RestoreSessionCommand`, and `RuntimeStore.restoreSession`.

- [ ] **Step 1: Write failing public-contract tests**

```ts
expect(ChatResponseSchema.parse({ ...validResponse, resumeToken: "token" }))
  .toMatchObject({ resumeToken: "token" });

expect(ResumeSessionRequestSchema.parse({ resumeToken: "opaque" }))
  .toEqual({ resumeToken: "opaque" });

expect(ResumeSessionResponseSchema.parse({
  session: validSession,
  messages: [],
  resumeToken: "refreshed",
})).toMatchObject({ resumeToken: "refreshed" });
```

- [ ] **Step 2: Run the contract tests and confirm RED**

Run: `pnpm exec vitest run packages/contracts/test/public.test.ts packages/core/test/core-contracts.test.ts`

Expected: FAIL because the new schemas and ports do not exist.

- [ ] **Step 3: Add exact provider-neutral types**

```ts
export interface SessionResumeClaims {
  version: 1;
  sessionId: string;
  userId: string;
  provider: string;
  providerKey: string;
  externalConversationId: string;
  issuedAt: string;
}

export interface ResumeTokenCodec {
  encode(claims: SessionResumeClaims): string;
  decode(token: string): SessionResumeClaims;
}

export interface ConversationHistoryEntry {
  id: string;
  userContent: string;
  assistantContent: string;
  createdAt: string;
}

export interface ConversationHistorySource {
  loadHistory(input: {
    externalConversationId: string;
    userId: string;
    maximumEntries: number;
  }, signal?: AbortSignal): Promise<readonly ConversationHistoryEntry[]>;
}
```

Add `RuntimeStore.restoreSession(command: RestoreSessionCommand): Promise<RuntimeSession>` where the command contains session, default context, canonical messages, and one provider binding.

- [ ] **Step 4: Implement strict schemas and exports, then confirm GREEN**

Run: `pnpm exec vitest run packages/contracts/test/public.test.ts packages/core/test/core-contracts.test.ts && pnpm typecheck`

- [ ] **Step 5: Commit the contract slice**

```text
git add packages/contracts packages/core
git commit -m feat:define-session-resume-contracts
```

---

### Task 2: Implement authenticated resume-token crypto and configuration

**Files:**
- Create: `apps/api/src/session-resume-token.ts`
- Create: `apps/api/test/session-resume-token.test.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/test/config.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `ResumeTokenCodec`, `SessionResumeClaims`.
- Produces: `createEncryptedResumeTokenCodec(secret: Uint8Array): ResumeTokenCodec`.
- Produces: `ApiConfig.sessionResumeSecret?: Uint8Array`; required for Dify composition, absent for Mock unless explicitly configured.

- [ ] **Step 1: Write failing codec tests**

```ts
const first = createEncryptedResumeTokenCodec(keyA);
const second = createEncryptedResumeTokenCodec(keyA);
const token = first.encode(validClaims);

expect(token).not.toContain(validClaims.externalConversationId);
expect(second.decode(token)).toEqual(validClaims);
expect(() => second.decode(`${token}x`)).toThrow();
expect(() => createEncryptedResumeTokenCodec(keyB).decode(token)).toThrow();
```

Also assert invalid Base64, a decoded key not exactly 32 bytes, and missing Dify secret fail with credential-safe configuration errors.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm exec vitest run apps/api/test/session-resume-token.test.ts apps/api/test/config.test.ts`

- [ ] **Step 3: Implement AES-256-GCM framing**

Use `node:crypto` `randomBytes(12)`, `createCipheriv("aes-256-gcm", key, iv)`, a fixed authenticated header `skein.resume.v1`, JSON UTF-8 payload, a 16-byte tag, and Base64URL segments. Validate claims after decrypt; expose one generic validation error for every decode failure.

- [ ] **Step 4: Parse local configuration safely**

Decode `SESSION_RESUME_SECRET` as strict Base64 and require 32 bytes for Dify. Add only this placeholder to `.env.example`:

```dotenv
# Generate a local 32-byte key and store only in .env.local.
SESSION_RESUME_SECRET=replace-with-base64-32-byte-key
```

- [ ] **Step 5: Confirm GREEN and run scrub**

Run: `pnpm exec vitest run apps/api/test/session-resume-token.test.ts apps/api/test/config.test.ts && pnpm typecheck && pnpm scrub`

- [ ] **Step 6: Commit the crypto slice**

```text
git add apps/api/src/session-resume-token.ts apps/api/test/session-resume-token.test.ts apps/api/src/config.ts apps/api/test/config.test.ts .env.example
git commit -m feat:add-encrypted-resume-tokens
```

---

### Task 3: Implement bounded Dify history retrieval

**Files:**
- Create: `packages/adapters/dify/src/dify-conversation-history.ts`
- Create: `packages/adapters/dify/test/dify-conversation-history.test.ts`
- Modify: `packages/adapters/dify/src/types.ts`
- Modify: `packages/adapters/dify/src/index.ts`

**Interfaces:**
- Consumes: `ConversationHistorySource`.
- Produces: `DifyConversationHistorySource` and `createDifyConversationHistorySource({ baseUrl, apiKey, fetch?, pageSize?, maximumResponseBytes? })`.

- [ ] **Step 1: Write failing HTTP and normalization tests**

Create a local HTTP server fixture and assert the first request is equivalent to:

```text
GET /v1/messages?conversation_id=conversation-1&user=demo-user&limit=100
Authorization: Bearer test-key
Accept: application/json
```

Return two newest-first pages. Assert the second uses `first_id` equal to `data[0].id` from the prior page, stops at 200 entries, rejects a repeated cursor, and returns chronological `ConversationHistoryEntry[]`.

- [ ] **Step 2: Run focused test and confirm RED**

Run: `pnpm exec vitest run packages/adapters/dify/test/dify-conversation-history.test.ts`

- [ ] **Step 3: Implement the minimal bounded client**

Validate JSON objects with Zod or explicit unknown-value guards. Require UUID/non-empty message IDs, matching conversation IDs, string query/answer, finite Unix timestamps, JSON media type, progress on every page, at most 100 rows per request, 200 rows cumulatively, and bounded UTF-8 bytes. Map failures through existing Dify provider-neutral error helpers.

- [ ] **Step 4: Add failure-path cases**

Cover abort, 401, 404, 429, 500, invalid content type, invalid JSON, oversize body, duplicate IDs, changed conversation ID, empty cursor progress, and ensure error messages never contain key/base URL/conversation ID.

- [ ] **Step 5: Confirm GREEN and package build**

Run: `pnpm exec vitest run packages/adapters/dify/test/dify-conversation-history.test.ts packages/adapters/dify/test/dify-business-orchestrator.test.ts && pnpm --filter @skein-chatbot/adapter-dify build`

- [ ] **Step 6: Commit the adapter slice**

```text
git add packages/adapters/dify
git commit -m feat:add-dify-conversation-history
```

---

### Task 4: Add atomic store restoration

**Files:**
- Modify: `packages/test-utils/src/in-memory-runtime-store.ts`
- Modify: `packages/test-utils/test/runtime-validation.test.ts`
- Modify: `packages/persistence/postgres/src/prisma-client-protocol.ts`
- Modify: `packages/persistence/postgres/src/prisma-runtime-store.ts`
- Modify: `packages/persistence/postgres/test/fake-prisma-client.ts`
- Modify: `packages/persistence/postgres/test/prisma-runtime-store.test.ts`

**Interfaces:**
- Consumes: `RestoreSessionCommand`.
- Produces: equivalent atomic restore behavior for in-memory and PostgreSQL RuntimeStore implementations.

- [ ] **Step 1: Write failing store-conformance tests**

```ts
await store.restoreSession(validRestoreCommand);
expect(await store.getMessages("session-1")).toEqual(historyMessages);
expect((await store.loadSessionAggregate("session-1"))?.providerBindings)
  .toEqual([binding]);
```

Add rejection cases for duplicate message IDs, wrong message session IDs, nonchronological messages, nonzero/default-context mismatch, conflicting owner, conflicting binding, and a second restore over an existing session.

- [ ] **Step 2: Confirm RED in both adapters**

Run: `pnpm exec vitest run packages/test-utils/test/runtime-validation.test.ts packages/persistence/postgres/test/prisma-runtime-store.test.ts`

- [ ] **Step 3: Implement in-memory restore**

Validate the whole command before one `Map.set`. Clone every input and create an ACTIVE session without turns, summaries, compacted markers, or failed-turn changes.

- [ ] **Step 4: Implement PostgreSQL restore transaction**

Extend the session delegate with `findMany` only if required later; restore itself performs one transaction that creates Session, ContextState, Message rows, and ProviderBinding. A unique conflict maps to `SESSION_CONFLICT`; no partial rows survive.

- [ ] **Step 5: Confirm GREEN and run persistence build**

Run: `pnpm exec vitest run packages/test-utils/test/runtime-validation.test.ts packages/persistence/postgres/test/prisma-runtime-store.test.ts && pnpm --filter @skein-chatbot/postgres build`

- [ ] **Step 6: Commit the store slice**

```text
git add packages/test-utils packages/persistence/postgres packages/core/src/ports/runtime-store.ts
git commit -m feat:add-atomic-session-restore
```

---

### Task 5: Integrate Runtime resume and public API

**Files:**
- Modify: `packages/core/src/runtime/chat-runtime.ts`
- Modify: `packages/core/src/runtime/turn-runner.ts`
- Modify: `packages/core/test/chat-runtime.test.ts`
- Modify: `apps/api/src/api-runtime.ts`
- Modify: `apps/api/src/routes.ts`
- Modify: `apps/api/src/composition.ts`
- Modify: `apps/api/test/app.test.ts`
- Modify: `apps/api/test/composition.test.ts`
- Modify: `scripts/mock-public-e2e.test.ts`

**Interfaces:**
- Consumes: codec, history source, restore-capable store.
- Produces: `ChatRuntime.resumeSession(resumeToken, user, signal?)` and `POST /api/v1/sessions/resume`.
- Produces: optional `resumeToken` on blocking and terminal-stream chat results.

- [ ] **Step 1: Write failing Runtime tests**

Test successful chat token issuance after binding, no token when codec capability is absent, no commit when token creation fails before commit, existing-session idempotent resume, fresh-store history restore, user/provider/providerKey mismatch, history-source failure with zero store mutation, and concurrent identical resume.

- [ ] **Step 2: Confirm Runtime RED**

Run: `pnpm exec vitest run packages/core/test/chat-runtime.test.ts`

- [ ] **Step 3: Implement token issuance and resume**

Before committing a successful turn, encode claims only when both codec and a provider conversation ID exist. During resume, decode and validate current provider identity/user; return existing history when the aggregate already matches; otherwise load provider history, deterministically create `history:<entry-id>:user` and `history:<entry-id>:assistant` messages, restore default context revision 0, and refresh the token.

- [ ] **Step 4: Write and run failing API tests**

Assert strict POST body parsing, token never accepted in a URL, canonical success payload, credential-safe errors, abort propagation, and no route in Mock composition when no token is issued.

Run: `pnpm exec vitest run apps/api/test/app.test.ts apps/api/test/composition.test.ts`

- [ ] **Step 5: Wire Dify composition**

Create one codec from `SESSION_RESUME_SECRET` and one Dify history source from the same base URL/key/fetch boundary as the orchestrator. Inject both into ChatRuntime. Keep Mock composition optional and provider-free.

- [ ] **Step 6: Add restart E2E**

Use two fresh API runtime instances with different in-memory stores, one stable test secret, and one mock Dify HTTP server. Assert first chat token -> second runtime resume -> chronological history -> next chat request carries exactly the original private conversation ID.

- [ ] **Step 7: Run the backend integration gate**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm scrub && git diff --check`

- [ ] **Step 8: Commit the backend slice**

```text
git add packages apps/api scripts/mock-public-e2e.test.ts .env.example pnpm-lock.yaml
git commit -m feat:resume-provider-conversations
```

---

### Task 6: Add Demo API resume support and safe browser cache

**Files:**
- Modify: `apps/demo-web/src/api.ts`
- Modify: `apps/demo-web/src/api.test.ts`
- Create: `apps/demo-web/src/conversation-cache.ts`
- Create: `apps/demo-web/src/conversation-cache.test.ts`

**Interfaces:**
- Consumes: public resume request/response schemas.
- Produces: `SkeinApiClient.resumeSession(resumeToken, signal?)`.
- Produces: `loadConversationCache(storage)`, `saveConversationCache(storage, cache)`, `upsertCachedConversation`, and versioned cache types.

- [ ] **Step 1: Write failing API-client tests**

Assert POST `/api/v1/sessions/resume`, JSON body-only token transport, response validation, public-error mapping, and abort propagation.

- [ ] **Step 2: Write failing cache tests**

Use an in-memory `Storage` fake. Cover missing cache, valid round-trip, schema version mismatch, invalid JSON, oversized title/token/message counts/content, quota exception, stable newest-first ordering, and active-session updates. Assert malformed persisted data is not overwritten.

- [ ] **Step 3: Confirm RED**

Run: `pnpm exec vitest run apps/demo-web/src/api.test.ts apps/demo-web/src/conversation-cache.test.ts`

- [ ] **Step 4: Implement minimal client and cache modules**

Parse every network and localStorage value with strict schemas. Return a typed load warning instead of throwing during application startup. Let save failures return a display-safe result; never remove other storage keys or prune conversations.

- [ ] **Step 5: Confirm GREEN**

Run: `pnpm exec vitest run apps/demo-web/src/api.test.ts apps/demo-web/src/conversation-cache.test.ts && pnpm --filter @skein-chatbot/demo-web typecheck`

- [ ] **Step 6: Commit the client/cache slice**

```text
git add apps/demo-web/src/api.ts apps/demo-web/src/api.test.ts apps/demo-web/src/conversation-cache.ts apps/demo-web/src/conversation-cache.test.ts
git commit -m feat:add-browser-conversation-cache
```

---

### Task 7: Implement accessible sidebar and switching workflow

**Files:**
- Create: `apps/demo-web/src/conversation-sidebar.tsx`
- Create: `apps/demo-web/src/conversation-sidebar.test.ts`
- Modify: `apps/demo-web/src/App.tsx`
- Modify: `apps/demo-web/src/styles.css`
- Modify: `apps/demo-web/src/message-markdown.test.ts`

**Interfaces:**
- Consumes: cache helpers and `client.resumeSession`.
- Produces: responsive conversation navigation and active-conversation recovery state.

- [ ] **Step 1: Write failing semantic sidebar tests**

Render to static markup and assert a labelled navigation, New Conversation action, newest-first buttons, active `aria-current`, truncated plain-text title, recovery status, and disabled switching while a turn is active.

- [ ] **Step 2: Confirm RED**

Run: `pnpm exec vitest run apps/demo-web/src/conversation-sidebar.test.ts`

- [ ] **Step 3: Implement the presentational sidebar**

Keep it stateless: receive conversations, active session, drawer state, running/recovering state, and callbacks. Use real buttons, `aria-expanded`, `aria-controls`, `aria-current`, and visible focus styles.

- [ ] **Step 4: Integrate App state and recovery flow**

On startup, load cache once. On selection, display cached messages immediately, call resume when a token exists, replace messages with canonical restored history on success, and mark the conversation read-only with Retry on failure. Persist terminal chat/stop state and active selection. Never persist pending flags, trace IDs, or errors.

- [ ] **Step 5: Add responsive CSS**

Use a two-column shell at desktop width and an overlay drawer below 800px. Preserve the existing chat card, Markdown styles, reduced-motion behavior, and keyboard focus order. Wide tables/code remain contained inside the message column.

- [ ] **Step 6: Run frontend gate**

Run: `pnpm exec vitest run apps/demo-web/src && pnpm --filter @skein-chatbot/demo-web typecheck && pnpm --filter @skein-chatbot/demo-web build && pnpm lint`

- [ ] **Step 7: Commit the UI slice**

```text
git add apps/demo-web
git commit -m feat:add-conversation-sidebar
```

---

### Task 8: Documentation, live local acceptance, and delivery

**Files:**
- Modify: `docs/public-api.md`
- Modify: `docs/architecture.md`
- Modify: `docs/runtime-lifecycle.md`
- Modify: `docs/dify-contract.md`
- Modify: `docs/dify-adapter.md`
- Modify: `docs/persistence.md`
- Modify: `docs/security.md`
- Modify: `docs/e2e-acceptance.md`
- Modify: `docs/implementation-status.md`
- Modify: `README.md`
- Modify: `scripts/smoke-dify.ts` only if a sanitized resume mode is required

**Interfaces:**
- Consumes: completed feature and frozen acceptance matrix.
- Produces: accurate setup, security, limitation, recovery, and validation instructions.

- [ ] **Step 1: Document local setup and limitations**

Document generation of a local Base64 32-byte resume secret, localStorage privacy, restart restoration, 200-row recovery bound, Dify-only live recovery capability, default-context reconstruction, and the later PostgreSQL durability path. Do not include a real secret, URL, key, conversation ID, or response.

- [ ] **Step 2: Run sanitized live Dify restart smoke**

With ignored local configuration, send one harmless prompt, capture only booleans/counts internally, stop and recreate the API runtime, resume using the opaque token, and send a harmless continuation. Console output may contain only PASS/FAIL, HTTP status classes, message counts, and timing; it must not contain provider URL, key, token, conversation ID, query, or answer.

- [ ] **Step 3: Perform role-separated acceptance review**

Re-read the original request and spec, inspect the complete diff, then falsify each acceptance item: raw-ID leak, token tamper, API restart, history order, continuation binding, cache corruption, sidebar keyboard semantics, Mock regression, and secret scan. Record any defect before fixing it and rerun the smallest failing check plus affected regressions.

- [ ] **Step 4: Inspect the real browser UI at desktop and mobile widths**

Run the local Demo/API, capture the sidebar closed/open and active-history states at a desktop viewport and a narrow mobile viewport, inspect keyboard focus, overflow, Markdown containment, recovery status, and composer availability, and retain only sanitized local screenshots outside the tracked repository.

- [ ] **Step 5: Run final complete gate**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm scrub && git diff --check`

Expected: zero lint/type errors, all tests pass, every workspace build succeeds, scrub reports clean, and diff check emits no output.

- [ ] **Step 6: Verify ignored secrets and staged scope**

Run: `git check-ignore -v apps/api/.env.local` and inspect `git diff --cached --name-only`. Confirm `.env.local`, live outputs, generated screenshots, `dist`, and node_modules are absent.

- [ ] **Step 7: Commit and push**

```text
git add README.md docs scripts apps packages prisma .env.example pnpm-lock.yaml
git diff --cached --check
git commit -m feat:complete-browser-conversation-resume
git push origin develop
```

- [ ] **Step 8: Verify remote equality**

Run: `git status --short --branch`, `git rev-parse HEAD`, and `git ls-remote origin refs/heads/develop`. The local and remote hashes must match and the worktree must be clean.
