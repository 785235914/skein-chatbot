# PostgreSQL Persistence

The PostgreSQL adapter implements the provider-neutral `RuntimeStore` with Prisma. It owns `Session`, `Message`, `Turn`, `ContextState`, `ConversationSummary`, `ProviderBinding`, `RuntimeEvent` and `AuditLog` persistence; Core never imports Prisma.

## Selection and lifecycle

The API uses the in-memory store when `DATABASE_URL` is absent or blank. A non-empty value selects PostgreSQL, and the composition root closes its client exactly once when Fastify closes. Startup failures are replaced with a credential-safe message.

## Safe commits

Turn commit creates or compare-and-swaps `ContextState.revision`, then writes canonical messages, turn data, provider binding and session timestamps in one transaction. Revision mismatch maps to `SESSION_CONFLICT`. Reset and compaction also run transactionally. Compaction updates only messages whose `compactedAt` remains null; a count mismatch rolls back the summary and timestamp updates.

`restoreSession` validates the complete command before writing and then creates the session, default context revision `0`, chronological canonical messages and provider binding in one transaction. Unique/conflict failures map to `SESSION_CONFLICT`; no partial restore rows survive. The in-memory store follows the same atomic contract with one validated state insertion.

## Browser cache versus durable storage

The Demo localStorage cache is a client convenience, not the authoritative Runtime store. It contains up to 500 conversations and 400 canonical USER/ASSISTANT messages per conversation plus an opaque resume token. Cached content is shown immediately after reload; a successful resume replaces it with server-canonical history. Invalid, oversized or quota-failing data produces a visible warning and is not silently deleted, pruned or used to restore Runtime state.

With in-memory API storage, only Dify recovery can rebuild a session after process restart, and it can recover only provider-visible message pairs plus the private binding. It reconstructs default context revision `0`; Skein-only turns, summaries, compacted markers, audit rows and workflow/context state are not recreated. PostgreSQL is the full durability path for those records and remains recommended for production.

## Database setup

The repository never creates or drops a database automatically. An administrator can adapt the minimal statement in `prisma/bootstrap/create-database.sql`, then configure a dedicated `skein_chatbot` database. Migration requires both `DATABASE_URL` and exact confirmation:

```powershell
$env:SKEIN_DATABASE_MIGRATION_CONFIRM = 'skein_chatbot'
pnpm db:migrate
```

The restart smoke is opt-in and accepts only a separately provisioned `skein_chatbot_test` target:

```powershell
$env:SKEIN_POSTGRES_TEST_URL = '<authorized dedicated test URL>'
$env:SKEIN_POSTGRES_TEST_CONFIRM = 'skein_chatbot_test'
pnpm --filter @skein-chatbot/postgres test:postgres
```

Do not reuse an existing application or administrator database. Neither command prints the connection URL.
