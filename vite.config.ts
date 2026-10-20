import { svelte } from "@sveltejs/vite-plugin-svelte";
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import { devRelay } from "./dev/relay";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

/**
 * LG TVs load the app from local files, where module scripts don't run: the TV build is one
 * classic script, with relative paths.
 */
function classicScript(): Plugin {
  return {
    name: "telly-classic-script",
    enforce: "post",
    transformIndexHtml: (html) => html.replace(/<script type="module" crossorigin/g, "<script defer").replace(/ crossorigin/g, ""),
  };
}

export default defineConfig(({ mode }) => mode === "webos" ? {
  plugins: [svelte(), classicScript()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  base: "./",
  build: {
    outDir: "dist-webos",
    // webOS 6 (2021 TVs) runs Chromium 79.
    target: ["chrome79"],
    modulePreload: false,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: { output: { format: "iife", inlineDynamicImports: true } },
  },
} : {
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
