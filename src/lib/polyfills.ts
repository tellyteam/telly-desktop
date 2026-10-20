/** Small fallbacks for older LG TVs (webOS 6 runs Chromium 79), for what telly and Svelte use. */

if (!Array.prototype.at) {
  Object.defineProperty(Array.prototype, "at", {
    configurable: true, writable: true,
    value(this: unknown[], i: number) { const n = Math.trunc(i) || 0; return this[n < 0 ? this.length + n : n]; },
  });
}
if (!String.prototype.replaceAll) {
  Object.defineProperty(String.prototype, "replaceAll", {
    configurable: true, writable: true,
    value(this: string, find: string | RegExp, by: string) {
      return find instanceof RegExp ? this.replace(find, by) : this.split(find).join(by);
    },
  });
}
if (!Object.hasOwn) {
  Object.defineProperty(Object, "hasOwn", {
    configurable: true, writable: true,
    value: (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k),
  });
}
for (const name of ["findLast", "findLastIndex"] as const) {
  if (!(Array.prototype as unknown as Record<string, unknown>)[name]) {
    Object.defineProperty(Array.prototype, name, {
      configurable: true, writable: true,
      value(this: unknown[], fn: (v: unknown, i: number, a: unknown[]) => boolean) {
        for (let i = this.length - 1; i >= 0; i--) if (fn(this[i], i, this)) return name === "findLast" ? this[i] : i;
        return name === "findLast" ? undefined : -1;
      },
    });
  }
}
if (typeof globalThis.structuredClone !== "function") {
  (globalThis as { structuredClone?: unknown }).structuredClone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
}
