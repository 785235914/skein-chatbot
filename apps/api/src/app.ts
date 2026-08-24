import cors from "@fastify/cors";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";

import type { ApiRuntime } from "./api-runtime.js";
import { createDefaultApiRuntime } from "./composition.js";
import { loadApiConfig, type ApiConfig } from "./config.js";
import { sendPublicError } from "./public-errors.js";
import {
  publicErrorForUnhandledFailure,
  registerPublicRoutes,
} from "./routes.js";

export interface ApiAppOptions {
  config?: ApiConfig;
  logger?: boolean | FastifyBaseLogger;
  readiness?: () => Promise<boolean> | boolean;
  runtime?: ApiRuntime;
}

const onceAsync = (
  operation: () => Promise<void>,
): (() => Promise<void>) => {
  let result: Promise<void> | undefined;
  return () => {
    result ??= Promise.resolve().then(operation);
    return result;
  };
};

export const createApiApp = async (
  options: ApiAppOptions = {},
): Promise<FastifyInstance> => {
  const readiness = options.readiness ?? (() => true);
  const runtime =
    options.runtime ??
    (await createDefaultApiRuntime(options.config ?? loadApiConfig()));
  const logger = options.logger ?? false;
  const app: FastifyInstance =
    typeof logger === "boolean"
      ? Fastify({ logger })
      : Fastify({ loggerInstance: logger });
  const closeRuntime = onceAsync(async () => {
    await runtime.close?.();
  });

  app.addHook("onClose", async () => {
    await closeRuntime();
  });

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) {
      return;
    }
    const response = publicErrorForUnhandledFailure(
      error,
      String(request.id),
    );
    return sendPublicError(reply, response);
  });

  await app.register(cors, {
    origin: false,
  });

  app.get("/api/v1/health", async () => ({ status: "ok" as const }));

  app.get("/api/v1/ready", async (_request, reply) => {
    const ready = await readiness();
    const body = {
      status: ready ? ("ready" as const) : ("not_ready" as const),
      checks: { runtime: ready },
    };

    return ready ? body : reply.code(503).send(body);
  });

  registerPublicRoutes(app, runtime);

  return app;
};
