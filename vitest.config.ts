import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@skein-chatbot/contracts": fromRoot("./packages/contracts/src/index.ts"),
      "@skein-chatbot/core": fromRoot("./packages/core/src/index.ts"),
      "@skein-chatbot/adapter-mock": fromRoot(
        "./packages/adapters/mock/src/index.ts",
      ),
      "@skein-chatbot/adapter-dify": fromRoot(
        "./packages/adapters/dify/src/index.ts",
      ),
      "@skein-chatbot/postgres": fromRoot(
        "./packages/persistence/postgres/src/index.ts",
      ),
      "@skein-chatbot/observability": fromRoot(
        "./packages/observability/src/index.ts",
      ),
      "@skein-chatbot/test-utils": fromRoot(
        "./packages/test-utils/src/index.ts",
      )
    }
  },
  test: {
    include: ["{apps,packages,scripts}/**/*.test.{ts,tsx}"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    coverage: {
      reporter: ["text", "json-summary"]
    }
  }
});
