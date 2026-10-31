import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const API_TARGET = "http://127.0.0.1:3000";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/dashboard/",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist-web", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/health": API_TARGET,
      "/worlds": API_TARGET,
      "/sessions": API_TARGET,
      "/evaluator": API_TARGET,
    },
  },
});
