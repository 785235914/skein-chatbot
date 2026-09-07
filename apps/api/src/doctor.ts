import { diagnoseApiConfig } from "./config.js";
import { loadLocalApiEnvironment } from "./environment.js";

try {
  const result = diagnoseApiConfig(loadLocalApiEnvironment());
  console.log(JSON.stringify({ check: "api-configuration", ...result }));
  process.exitCode = result.status === "PASS" ? 0 : 1;
} catch {
  console.error('Configuration files could not be read. Check local file access.');
  process.exitCode = 1;
}
