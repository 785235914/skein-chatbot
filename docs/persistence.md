# PostgreSQL Persistence

The PostgreSQL adapter implements the provider-neutral `RuntimeStore` with Prisma. It owns `Session`, `Message`, `Turn`, `ContextState`, `ConversationSummary`, `ProviderBinding`, `RuntimeEvent` and `AuditLog` persistence; Core never imports Prisma.

## Selection and lifecycle

The API uses the in-memory store when `DATABASE_URL` is absent or blank. A non-empty value selects PostgreSQL, and the composition root closes its client exactly once when Fastify closes. Startup failures are replaced with a credential-safe message.

## Safe commits

Turn commit creates or compare-and-swaps `ContextState.revision`, then writes canonical messages, turn data, provider binding and session timestamps in one transaction. Revision mismatch maps to `SESSION_CONFLICT`. Reset and compaction also run transactionally. Compaction updates only messages whose `compactedAt` remains null; a count mismatch rolls back the summary and timestamp updates.

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
