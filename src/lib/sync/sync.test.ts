import { createCipheriv, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveKeys, formatCode, newCode, normaliseCode, open, openLogins, providerTag, seal, sealLogins } from "./crypto";
import { bundleJson, mergeBundles, parseBundle, parseLogins } from "./bundle";
import { normaliseServer, syncIdentity, type Provider } from "../model";
import { merge, parse, trim, TOMBSTONE_MS, type Parcel } from "./parcel";
import { pull, push, type RelayRequest, type Transport } from "./client";

/** Shared with the Fire TV and iPad tests: every client must produce exactly these. */
export const VECTOR = {
  code: "0123456789ABCDEF",
  mailbox: "",
  auth: "",
  key: "",
  device: "00112233aabbccdd",
  nonce: "000102030405060708090a0b",
  plaintext: '{"v":1}',
  sealed: "",
};

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

describe("codes", () => {
  it("makes 16-character codes from the unambiguous alphabet", () => {
    const code = newCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(normaliseCode(code)).toBe(code);
  });

  it("forgives dashes, spaces, lowercase and look-alike letters", () => {
    expect(normaliseCode("abcd-efgh jkmn-pqrs")).toBe("ABCDEFGHJKMNPQRS");
    expect(normaliseCode("OIL0-0000-0000-0000")).toBe("0110000000000000");
    expect(normaliseCode("ABCD")).toBeNull();
    expect(normaliseCode("ABCD-EFGH-JKMN-PQRU")).toBeNull(); // U isn't in the alphabet
  });

  it("formats in groups of four", () => {
    expect(formatCode("ABCDEFGHJKMNPQRS")).toBe("ABCD-EFGH-JKMN-PQRS");
  });
});

describe("keys and sealing", () => {
  const keys = deriveKeys(VECTOR.code);

  it("derive with HKDF-SHA256 exactly as the protocol says", () => {
    const node = (info: string) => new Uint8Array(hkdfSync("sha256", VECTOR.code, "telly-sync v1", info, 32));
    expect(keys.mailbox).toBe(hex(node("mailbox").subarray(0, 16)));
    expect(hex(keys.key)).toBe(hex(node("key")));
    expect(keys.auth).toBe(Buffer.from(node("auth")).toString("base64url"));
  });

  it("seal to the protocol's envelope, matching an independent AES-GCM", () => {
    const sealed = seal(keys, VECTOR.device, VECTOR.plaintext, fromHex(VECTOR.nonce));
    const cipher = createCipheriv("aes-256-gcm", keys.key, fromHex(VECTOR.nonce));
    cipher.setAAD(Buffer.from(`telly-sync v1|${keys.mailbox}|${VECTOR.device}`));
    const expected = Buffer.concat([Buffer.from([1]), fromHex(VECTOR.nonce), cipher.update(VECTOR.plaintext), cipher.final(), cipher.getAuthTag()]);
    expect(hex(sealed)).toBe(expected.toString("hex"));
  });

  it("open only with the right key and device", () => {
    const sealed = seal(keys, VECTOR.device, VECTOR.plaintext);
    expect(open(keys, VECTOR.device, sealed)).toBe(VECTOR.plaintext);
    expect(open(keys, "ffffffffffffffff", sealed)).toBeNull();
    expect(open(deriveKeys("1123456789ABCDEF"), VECTOR.device, sealed)).toBeNull();
    const tampered = sealed.slice();
    tampered[20] ^= 1;
    expect(open(keys, VECTOR.device, tampered)).toBeNull();
  });

  it("matches the shared test vector", () => {
    // Printed so the Kotlin and Swift tests can pin the same values.
    const sealed = hex(seal(keys, VECTOR.device, VECTOR.plaintext, fromHex(VECTOR.nonce)));
    expect({ mailbox: keys.mailbox, auth: keys.auth, key: hex(keys.key), sealed }).toMatchSnapshot();
  });
});

const parcel = (p: Partial<Parcel>): Parcel => ({ v: 1, at: 0, progress: {}, history: [], list: {}, cleared: 0, ...p });

describe("parcels", () => {
  it("drop anything that could carry a login", () => {
    const p = parse(JSON.stringify({
      v: 1, at: 5,
      progress: { "series/12.mkv": [1, 2, 3], "http://host/user/pass/12.ts": [1, 2, 3], "movie/5.mp4": [1, 0, 3] },
      history: [
        { kind: "film", id: "5", at: 1 },
        { kind: "live", id: "http://host/user/pass/1.ts", at: 1 },
        { kind: "series", id: "9", at: 1 },
        { kind: "series", id: "9", series: "4", at: 2, removed: true, extra: "x" },
      ],
      list: { "film:5": [1, true], "live:http://x": [1, true], "series:4": [1, "yes"] },
    }))!;
    expect(Object.keys(p.progress)).toEqual(["series/12.mkv"]);
    expect(p.history).toEqual([{ kind: "film", id: "5", at: 1 }, { kind: "series", id: "9", series: "4", at: 2, removed: true }]);
    expect(p.list).toEqual({ "film:5": [1, true] });
  });

  it("reject other versions and junk", () => {
    expect(parse('{"v":2}')).toBeNull();
    expect(parse("not json")).toBeNull();
  });

  it("merge newest-wins per key, with removals winning when newer", () => {
    const own = parcel({
      progress: { "series/1.mkv": [100, 1000, 10], "series/2.mkv": [500, 1000, 50] },
      history: [{ kind: "film", id: "7", at: 20 }, { kind: "live", id: "3", at: 5 }],
      list: { "film:7": [10, true] },
    });
    const other = parcel({
      progress: { "series/1.mkv": [900, 1000, 30], "series/2.mkv": [10, 1000, 40], "series/3.mkv": [5, 9, 1] },
      history: [{ kind: "film", id: "7", at: 30, removed: true }, { kind: "live", id: "4", at: 6 }],
      list: { "film:7": [20, false], "series:8": [5, true] },
    });
    const m = merge(own, [other], 100);
    expect(m.progress).toEqual({ "series/1.mkv": [900, 1000, 30], "series/2.mkv": [500, 1000, 50], "series/3.mkv": [5, 9, 1] });
    expect(m.history).toEqual([{ kind: "film", id: "7", at: 30, removed: true }, { kind: "live", id: "4", at: 6 }]);
    expect(m.list).toEqual({ "film:7": [20, false], "series:8": [5, true] });
    expect(m.at).toBe(100);
  });

  it("keep their own entry on a tie", () => {
    const own = parcel({ progress: { "series/1.mkv": [1, 9, 10] } });
    const other = parcel({ progress: { "series/1.mkv": [2, 9, 10] } });
    expect(merge(own, [other], 0).progress["series/1.mkv"]).toEqual([1, 9, 10]);
  });

  it("forget removals after 90 days, but never things still watched or listed", () => {
    const now = TOMBSTONE_MS + 1000;
    const t = trim(parcel({
      history: [{ kind: "film", id: "1", at: 0, removed: true }, { kind: "film", id: "2", at: 0 }],
      list: { "film:1": [0, false], "film:2": [0, true] },
    }), now);
    expect(t.history).toEqual([{ kind: "film", id: "2", at: 0 }]);
    expect(t.list).toEqual({ "film:2": [0, true] });
  });
});

describe("relay round trip", () => {
  it("pushes sealed parcels and pulls only other devices' that open", async () => {
    const stored = new Map<string, Uint8Array>();
    const requests: RelayRequest[] = [];
    const transport: Transport = async (r) => {
      requests.push(r);
      const device = r.url.split("/").pop()!;
      if (r.method === "PUT") { stored.set(device, r.body!); return { status: 204, text: "" }; }
      const parcels = [...stored].map(([d, b]) => ({ device: d, body: Buffer.from(b).toString("base64") }));
      return { status: 200, text: JSON.stringify({ parcels }) };
    };
    const keys = deriveKeys(VECTOR.code);
    const tag = "aaaaaaaaaaaaaaaa";
    await push(transport, "https://relay.test/", keys, "aaaaaaaaaaaaaaaa", { at: 1, sections: { [tag]: parcel({ at: 1, list: { "film:1": [1, true] } }) } });
    await push(transport, "https://relay.test", keys, "bbbbbbbbbbbbbbbb", { at: 2, sections: {} });
    stored.set("cccccccccccccccc", new Uint8Array([1, 2, 3])); // junk is skipped
    const others = await pull(transport, "https://relay.test", keys, "bbbbbbbbbbbbbbbb", null);
    expect(others).toEqual([{ at: 1, sections: { [tag]: parcel({ at: 1, list: { "film:1": [1, true] } }) } }]);
    expect(requests[0].url).toBe(`https://relay.test/v1/${keys.mailbox}/aaaaaaaaaaaaaaaa`);
    expect(requests[0].auth).toBe(keys.auth);
    // Nothing readable leaves the device.
    expect(Buffer.from(stored.get("aaaaaaaaaaaaaaaa")!).toString("latin1")).not.toContain("film");
  });
});

describe("link", () => {
  it("carries the code, and the relay only when it isn't telly's", async () => {
    const { syncLink, parseSyncLink } = await import("./link");
    const def = "https://telly-sync.tellyteam.workers.dev";
    expect(syncLink("ABCDEFGHJKMNPQRS", def, def)).toBe("telly://sync?code=ABCDEFGHJKMNPQRS");
    const own = syncLink("ABCDEFGHJKMNPQRS", "https://relay.example/", def);
    expect(own).toBe("telly://sync?code=ABCDEFGHJKMNPQRS&relay=https%3A%2F%2Frelay.example%2F");
    expect(parseSyncLink(own, def)).toEqual({ code: "ABCDEFGHJKMNPQRS", relay: "https://relay.example/" });
    expect(parseSyncLink("telly://sync?code=abcd-efgh-jkmn-pqrs", def)).toEqual({ code: "ABCDEFGHJKMNPQRS", relay: def });
    expect(parseSyncLink("https://evil.example/?code=ABCDEFGHJKMNPQRS", def)).toBeNull();
    expect(parseSyncLink("telly://sync?code=ABCDEFGHJKMNPQRS&relay=http%3A%2F%2Fplain", def)).toBeNull();
  });
});

describe("version 2", () => {
  const keys = deriveKeys("0123456789ABCDEF");

  it("makes the shared provider tags", () => {
    expect(normaliseServer(" Example.com:8080/ ")).toBe("http://example.com:8080");
    expect(normaliseServer("https://tv.example:443/")).toBe("https://tv.example");
    expect(normaliseServer("HTTP://tv.example:80")).toBe("http://tv.example");
    const xtream: Provider = { kind: "xtream", name: "A", server: " Example.com:8080/ ", username: "me", password: "secret", allowCleartext: true };
    const m3u: Provider = { kind: "m3u", name: "B", url: " https://example.com/list.m3u ", allowCleartext: false };
    expect(providerTag(keys, syncIdentity(xtream))).toBe("7a6c86b8dde4ea72");
    expect(providerTag(keys, syncIdentity(m3u))).toBe("ff2163ea5d23fc01");
    expect(syncIdentity(xtream)).not.toContain("secret");
    expect(providerTag(deriveKeys("1123456789ABCDEF"), syncIdentity(xtream))).not.toBe("7a6c86b8dde4ea72");
  });

  it("keeps each provider apart, and reads version 1 only as the only provider", () => {
    const a = parcel({ at: 10, progress: { "movie/1.mkv": [5, 10, 10] } });
    const b = parcel({ at: 10, progress: { "movie/1.mkv": [7, 10, 20] } });
    const back = parseBundle(bundleJson({ at: 30, sections: { aaaaaaaaaaaaaaaa: a, bbbbbbbbbbbbbbbb: b } }), "cccccccccccccccc")!;
    expect(back.sections.aaaaaaaaaaaaaaaa.progress["movie/1.mkv"][0]).toBe(5);
    expect(back.sections.bbbbbbbbbbbbbbbb.progress["movie/1.mkv"][0]).toBe(7);
    expect(back.sections.cccccccccccccccc).toBeUndefined();
    expect(Object.keys(parseBundle('{"v":2,"at":1,"providers":{"http://x":{"progress":{}}}}', null)!.sections)).toEqual([]);
    const v1 = '{"v":1,"at":5,"progress":{"movie/9.mp4":[1,2,5]},"history":[],"list":{},"cleared":0}';
    expect(Object.keys(parseBundle(v1, "dddddddddddddddd")!.sections)).toEqual(["dddddddddddddddd"]);
    expect(parseBundle(v1, null)!.sections).toEqual({});
    expect(parseBundle('{"v":3}', "dddddddddddddddd")).toBeNull();
  });

  it("merges only the providers this device has", () => {
    const theirs = parcel({ at: 2, progress: { "movie/1.mkv": [6, 10, 2] } });
    const m = mergeBundles({ at: 1, sections: { aaaaaaaaaaaaaaaa: parcel({ at: 1, progress: { "movie/1.mkv": [1, 10, 1] } }) } },
      [{ at: 2, sections: { aaaaaaaaaaaaaaaa: theirs, eeeeeeeeeeeeeeee: theirs } }], 3);
    expect(Object.keys(m.sections)).toEqual(["aaaaaaaaaaaaaaaa"]);
    expect(m.sections.aaaaaaaaaaaaaaaa.progress["movie/1.mkv"][0]).toBe(6);
  });

  it("seals the logins box as the shared vector says", () => {
    expect(hex(keys.logins)).toBe("8bef4c523a4e523d49d504c587836e5b804b7fc42d498a2bd59c8a2ecb7dd49f");
    const sealed = sealLogins(keys, "00112233aabbccdd", "{}", fromHex("000102030405060708090a0b"));
    expect(hex(sealed)).toBe("01000102030405060708090a0bb8e5248c11cad1416ea6d5dfb19164d7d67c");
    expect(openLogins(keys, "00112233aabbccdd", sealed)).toBe("{}");
    expect(open(keys, "00112233aabbccdd", sealed)).toBeNull();
    expect(openLogins(keys, "aabbccddeeff0011", sealed)).toBeNull();
  });

  it("carries logins sealed, checks their tags, and keeps the newest", () => {
    const home: Provider = { kind: "xtream", name: "Home", server: " Example.com:8080/ ", username: "me", password: "pw1", allowCleartext: true };
    const tag = providerTag(keys, syncIdentity(home));
    const text = bundleJson({ at: 50, sections: {}, logins: { [tag]: { at: 40, provider: home }, "0123456789abcdef": { at: 30 } } }, keys, "00112233aabbccdd");
    expect(text).not.toContain("pw1");
    const back = parseBundle(text, tag, keys, "00112233aabbccdd")!;
    expect(back.logins?.[tag]).toEqual({ at: 40, provider: home });
    expect(back.logins?.["0123456789abcdef"]).toEqual({ at: 30 });
    expect(parseBundle(text, tag)!.logins).toBeUndefined();
    expect(parseLogins('{"aaaaaaaaaaaaaaaa":{"at":1,"kind":"m3u","name":"x","url":"https://example.com/list.m3u","allowCleartext":false}}', keys)).toEqual({});
    expect(Object.keys(parseLogins('{"ff2163ea5d23fc01":{"at":1,"kind":"m3u","name":"x","url":"https://example.com/list.m3u","allowCleartext":false}}', keys))).toEqual(["ff2163ea5d23fc01"]);
    const a: Provider = { kind: "m3u", name: "A", url: "https://a.example/1.m3u", allowCleartext: false };
    const b: Provider = { ...a, name: "A renamed" };
    const m = mergeBundles({ at: 10, sections: {}, logins: { "1111111111111111": { at: 5, provider: a } } },
      [{ at: 10, sections: {}, logins: { "1111111111111111": { at: 9, provider: b }, "2222222222222222": { at: 1 } } }], 1 + TOMBSTONE_MS + 1);
    expect(m.logins?.["1111111111111111"].provider).toEqual(b);
    expect(m.logins?.["2222222222222222"]).toBeUndefined();
    expect(mergeBundles({ at: 10, sections: {} }, [{ at: 10, sections: {}, logins: { x: { at: 1 } } }], 20).logins).toBeUndefined();
  });
});
