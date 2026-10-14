import { readFileSync, existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Plugin } from "vite";
import { rewritePlaylist } from "../src/lib/hls";
import { fakeProvider } from "./fake";

/**
 * `npm run dev` in a plain browser: a stand-in for the app's Rust relay, so the UI can be worked on
 * without building the app. Only ever part of the dev server; never in a build.
 */
export function devRelay(): Plugin {
  const prefix = "/__relay/dev/";
  const decode = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

  async function relay(req: IncomingMessage, res: ServerResponse) {
    const rest = (req.url ?? "").slice(prefix.length);
    const [flags = "-", encoded = ""] = rest.split("/");
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Range", "Access-Control-Expose-Headers": "Content-Length, Content-Range" };
    let target: URL;
    try {
      target = new URL(decode(encoded));
      if (!/^https?:$/.test(target.protocol)) throw new Error();
    } catch {
      res.writeHead(400, cors).end("Bad relay address");
      return;
    }
    if (target.protocol === "http:" && !flags.includes("c")) {
      res.writeHead(403, cors).end("Plain HTTP is turned off for this provider");
      return;
    }
    const get = (range?: string) => fetch(target, { headers: { "User-Agent": "telly/dev", ...(range ? { Range: range } : {}) }, redirect: "follow" });
    let up: Response;
    try {
      up = await get(req.headers.range);
    } catch {
      res.writeHead(502, cors).end(`${target.host} couldn't be reached`);
      return;
    }
    const type = up.headers.get("content-type") ?? "";
    if (flags.includes("h") && up.ok && (/mpegurl/i.test(type) || /\.m3u8$/i.test(new URL(up.url).pathname))) {
      // A playlist is rewritten whole, so a byte range from the player can't apply to it.
      if (up.status === 206) up = await get();
      const wrap = (u: string) => `${prefix}${flags}/${Buffer.from(u).toString("base64url")}/${new URL(u).pathname.split("/").pop() || "x"}`;
      const text = rewritePlaylist(await up.text(), up.url, wrap);
      res.writeHead(200, { ...cors, "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" }).end(text);
      return;
    }
    const headers: Record<string, string> = { ...cors };
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"]) {
      const v = up.headers.get(h);
      if (v) headers[h] = v;
    }
    res.writeHead(up.status, headers);
    if (!up.body) return res.end();
    const body = Readable.fromWeb(up.body as never);
    req.on("close", () => body.destroy());
    body.on("error", () => res.end());
    body.pipe(res);
  }

  /** A git-ignored provider.local.properties pre-fills the setup screen, like the TV app's debug builds. */
  function provider(res: ServerResponse) {
    const file = "provider.local.properties";
    const props: Record<string, string> = {};
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z]+)\s*[=:]\s*(.*?)\s*$/);
        if (m && !line.trim().startsWith("#")) props[m[1]] = m[2];
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(props));
  }

  return {
    name: "telly-dev-relay",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith(prefix)) return void relay(req, res);
        if (req.url === "/__dev/provider") return provider(res);
        if (req.url?.startsWith("/__dev/fake/")) {
          const u = new URL(req.url, "http://localhost");
          return fakeProvider(u.pathname.slice("/__dev/fake".length), u.searchParams, res, `http://${req.headers.host}/__dev/fake`);
        }
        next();
      });
    },
  };
}
