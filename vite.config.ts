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

/**
 * Chromium 79 (webOS 6) ignores `gap` in flex layouts, which arrived in Chromium 84. For the TV
 * build, each flex rule's gap also becomes a margin between its children. (Grid gaps work.)
 */
interface CssRule {
  selectors: string[];
  nodes: { type: string; prop?: string; value?: string }[];
  cloneAfter(overrides: { selectors: string[]; nodes: [] }): CssRule;
  append(decl: { prop: string; value: string }): CssRule;
}

const flexGap = {
  postcssPlugin: "telly-flex-gap",
  Rule(rule: CssRule) {
    const decl = (prop: string) => rule.nodes.find((n) => n.type === "decl" && n.prop === prop)?.value;
    const gap = decl("gap");
    if (!gap || decl("display")?.includes("grid")) return;
    const [row, col = row] = gap.split(/\s+/);
    const add = (children: string, prop: string, value: string) =>
      rule.cloneAfter({ selectors: rule.selectors.map((s) => `${s} > ${children}`), nodes: [] }).append({ prop, value });
    if (decl("flex-direction")?.startsWith("column")) return void add("* + *", "margin-top", row);
    if (decl("flex-wrap") === "wrap") add("*", "margin-bottom", row);
    add("* + *", "margin-left", col);
  },
};

export default defineConfig(({ mode }) => mode === "webos" ? {
  plugins: [svelte(), classicScript()],
  css: { postcss: { plugins: [flexGap] } },
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
