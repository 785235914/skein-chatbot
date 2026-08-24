# PostgreSQL setup

The repository never creates or drops a database automatically.

1. An authorized PostgreSQL administrator may run
   `bootstrap/create-database.sql` while connected to a maintenance database.
2. Set `DATABASE_URL` to the dedicated `skein_chatbot` database.
3. Set `SKEIN_DATABASE_MIGRATION_CONFIRM=skein_chatbot` and run
   `pnpm db:migrate` from the repository root.

The migration wrapper rejects missing confirmation, non-PostgreSQL URLs, and
database names other than `skein_chatbot` before invoking Prisma.

The opt-in restart smoke uses a separate pre-provisioned
`skein_chatbot_test` database and an independent confirmation variable. It
never creates or drops that database.
