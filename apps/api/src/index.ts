import dotenv from "dotenv";

import { createApiApp } from "./app.js";
import { createDefaultApiRuntime } from "./composition.js";
import { loadApiConfig } from "./config.js";
import { createPinoObservability } from "@skein-chatbot/observability";

dotenv.config({
  path: [".env.local", ".env"],
  override: false,
  quiet: true,
});

const start = async (): Promise<void> => {
  let app: Awaited<ReturnType<typeof createApiApp>> | undefined;

  try {
    const config = loadApiConfig();
    const observability = createPinoObservability({ level: config.logLevel });
    const runtime = await createDefaultApiRuntime(config, { observability });
    app = await createApiApp({
      config,
      runtime,
      logger: observability.logger,
    });
    await app.listen({ host: config.host, port: config.port });
  } catch {
    if (app === undefined) {
      process.stderr.write("API startup failed.\n");
    } else {
      app.log.error("API startup failed");
      try {
        await app.close();
      } catch {
        app.log.error("API cleanup after startup failure failed");
      }
    }
    process.exitCode = 1;
  }
};

await start();
