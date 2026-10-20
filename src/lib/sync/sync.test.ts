import { createCipheriv, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveKeys, formatCode, newCode, normaliseCode, open, seal } from "./crypto";
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
    await push(transport, "https://relay.test/", keys, "aaaaaaaaaaaaaaaa", parcel({ at: 1, list: { "film:1": [1, true] } }));
    await push(transport, "https://relay.test", keys, "bbbbbbbbbbbbbbbb", parcel({ at: 2 }));
    stored.set("cccccccccccccccc", new Uint8Array([1, 2, 3])); // junk is skipped
    const others = await pull(transport, "https://relay.test", keys, "bbbbbbbbbbbbbbbb");
    expect(others).toEqual([parcel({ at: 1, list: { "film:1": [1, true] } })]);
    expect(requests[0].url).toBe(`https://relay.test/v1/${keys.mailbox}/aaaaaaaaaaaaaaaa`);
    expect(requests[0].auth).toBe(keys.auth);
    // Nothing readable leaves the device.
    expect(Buffer.from(stored.get("aaaaaaaaaaaaaaaa")!).toString("latin1")).not.toContain("film");
  });
});
