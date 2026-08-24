import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const apiTarget =
    environment["VITE_DEV_API_TARGET"] ?? "http://127.0.0.1:3000";

  return {
    build: {
      emptyOutDir: true,
      outDir: "dist",
    },
    preview: {
      port: 4173,
      strictPort: true,
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          changeOrigin: true,
          target: apiTarget,
        },
      },
    },
  };
});
