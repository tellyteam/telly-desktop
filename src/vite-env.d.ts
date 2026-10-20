/// <reference types="svelte" />
/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** "webos" when built for LG TVs. */
  readonly VITE_TARGET?: string;
}
