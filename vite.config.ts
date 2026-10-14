import { svelte } from "@sveltejs/vite-plugin-svelte";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { devRelay } from "./dev/relay";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

export default defineConfig({
  plugins: [svelte(), devRelay()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  clearScreen: false,
  server: { port: 5173, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: ["es2022", "safari15", "chrome105"],
    chunkSizeWarningLimit: 1200,
  },
});
