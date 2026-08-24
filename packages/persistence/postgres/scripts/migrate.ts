import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assertDedicatedDatabaseUrl } from "../src/postgres-client.js";

const expectedDatabase = "skein_chatbot";
const confirmation = process.env["SKEIN_DATABASE_MIGRATION_CONFIRM"];

const fail = (message: string): never => {
  throw new Error(
    `${message} See ../../../prisma/bootstrap/create-database.sql for the minimal administrator SQL.`,
  );
};

const databaseUrl =
  process.env["DATABASE_URL"] ??
  fail("DATABASE_URL is required; no database operation was attempted.");
if (databaseUrl.length === 0) {
  fail("DATABASE_URL is required; no database operation was attempted.");
}
if (confirmation !== expectedDatabase) {
  fail(
    `Set SKEIN_DATABASE_MIGRATION_CONFIRM=${expectedDatabase} to confirm the exact dedicated target; no database operation was attempted.`,
  );
}
assertDedicatedDatabaseUrl(databaseUrl, [expectedDatabase]);

const packageManagerEntry =
  process.env["npm_execpath"] ??
  fail("The pnpm executable could not be resolved; no database operation was attempted.");
if (packageManagerEntry.length === 0) {
  fail("The pnpm executable could not be resolved; no database operation was attempted.");
}

const result = spawnSync(
  process.execPath,
  [
    packageManagerEntry,
    "exec",
    "prisma",
    "migrate",
    "deploy",
    "--config",
    "prisma.config.ts",
  ],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: process.env,
    stdio: "inherit",
  },
);

if (result.error !== undefined) {
  console.error("Prisma migration could not start; the database URL was not logged.");
  console.error(result.error.message);
  process.exitCode = 1;
} else if (result.signal !== null) {
  console.error(`Prisma migration stopped by signal ${result.signal}.`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
