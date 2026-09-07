import dotenv from "dotenv";

/** Same precedence for the server and its read-only configuration doctor. */
export const loadLocalApiEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  dotenv.config({
    path: [".env.local", ".env"],
    processEnv: environment,
    override: false,
    quiet: true,
  });
  return environment;
};
