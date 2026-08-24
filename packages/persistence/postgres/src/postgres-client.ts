import type { RuntimeStore } from "@skein-chatbot/core";

import { PrismaRuntimeStore } from "./prisma-runtime-store.js";
import {
  assertPrismaRuntimeClient,
  type PrismaRuntimeClient,
} from "./prisma-client-protocol.js";

export interface PostgresRuntimeStoreOptions {
  databaseUrl: string;
  /** Exact database names accepted by this process. Defaults to skein_chatbot. */
  allowedDatabaseNames?: readonly string[];
}

export interface PostgresRuntimeStoreHandle {
  store: RuntimeStore;
  disconnect(): Promise<void>;
}

const databaseNameFromUrl = (databaseUrl: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch (error) {
    throw new TypeError("DATABASE_URL must be a valid PostgreSQL URL.", {
      cause: error,
    });
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new TypeError("DATABASE_URL must use the PostgreSQL protocol.");
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  if (name.length === 0 || name.includes("/")) {
    throw new TypeError("DATABASE_URL must name exactly one database.");
  }
  return name;
};

export const assertDedicatedDatabaseUrl = (
  databaseUrl: string,
  allowedDatabaseNames: readonly string[] = ["skein_chatbot"],
): void => {
  if (
    allowedDatabaseNames.length === 0 ||
    allowedDatabaseNames.some((name) => name.length === 0)
  ) {
    throw new TypeError("At least one allowed database name is required.");
  }
  const databaseName = databaseNameFromUrl(databaseUrl);
  if (!allowedDatabaseNames.includes(databaseName)) {
    throw new TypeError(
      `Refusing PostgreSQL database '${databaseName}'; expected an explicitly allowed dedicated database.`,
    );
  }
};

type RuntimeConstructor = new (...arguments_: never[]) => unknown;

const constructorFrom = (
  moduleValue: unknown,
  exportName: string,
): RuntimeConstructor => {
  if (
    typeof moduleValue !== "object" ||
    moduleValue === null ||
    !(exportName in moduleValue)
  ) {
    throw new TypeError(`The ${exportName} export is unavailable.`);
  }
  const constructor = (moduleValue as Record<string, unknown>)[exportName];
  if (typeof constructor !== "function") {
    throw new TypeError(`The ${exportName} export is not constructable.`);
  }
  return constructor as RuntimeConstructor;
};

/**
 * Loads the generated Prisma client lazily. Root typecheck therefore remains
 * runnable before generation, while package build always generates first.
 */
export const createPostgresRuntimeStore = async (
  options: PostgresRuntimeStoreOptions,
): Promise<PostgresRuntimeStoreHandle> => {
  const allowedDatabaseNames = options.allowedDatabaseNames ?? ["skein_chatbot"];
  assertDedicatedDatabaseUrl(options.databaseUrl, allowedDatabaseNames);

  const adapterModuleName: string = "@prisma/adapter-pg";
  const generatedClientPath: string = "./generated/prisma/client.js";
  const [adapterModule, clientModule] = await Promise.all([
    import(adapterModuleName) as Promise<unknown>,
    import(generatedClientPath) as Promise<unknown>,
  ]);
  const PrismaPg = constructorFrom(adapterModule, "PrismaPg");
  const PrismaClient = constructorFrom(clientModule, "PrismaClient");
  const adapter = Reflect.construct(PrismaPg, [
    { connectionString: options.databaseUrl },
  ]);
  const clientValue = Reflect.construct(PrismaClient, [{ adapter }]);
  assertPrismaRuntimeClient(clientValue);
  const client: PrismaRuntimeClient = clientValue;

  return {
    store: new PrismaRuntimeStore(client),
    disconnect: async () => {
      await client.$disconnect();
    },
  };
};
