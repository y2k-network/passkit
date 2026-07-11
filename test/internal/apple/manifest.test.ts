import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { makeManifest, makeManifestJson } from "../../../src/internal/apple/manifest.ts"

describe("makeManifest", () => {
  test("computes SHA-1 hex digests matching node:crypto for each file", () => {
    const files = new Map<string, Uint8Array>([
      ["pass.json", new TextEncoder().encode('{"formatVersion":1}')],
      ["icon.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])]
    ])

    const json = makeManifestJson(files)

    for (const [name, bytes] of files) {
      const expected = createHash("sha1").update(bytes).digest("hex")
      expect(json[name]).toBe(expected)
    }
    expect(Object.keys(json).sort()).toEqual(["icon.png", "pass.json"])
  })

  test("matches a known SHA-1 digest for empty content", () => {
    const files = new Map<string, Uint8Array>([["empty.txt", new Uint8Array()]])
    const json = makeManifestJson(files)
    // SHA-1 of the empty string is a well-known constant.
    expect(json["empty.txt"]).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709")
  })

  test("makeManifest returns valid UTF-8 JSON bytes decoding to the same object", () => {
    const files = new Map<string, Uint8Array>([["a.txt", new TextEncoder().encode("hello")]])
    const bytes = makeManifest(files)
    const decoded = JSON.parse(new TextDecoder().decode(bytes))
    expect(decoded).toEqual(makeManifestJson(files))
  })

  test("is deterministic regardless of Map insertion order", () => {
    const a = new Map<string, Uint8Array>([
      ["z.txt", new TextEncoder().encode("z")],
      ["a.txt", new TextEncoder().encode("a")]
    ])
    const b = new Map<string, Uint8Array>([
      ["a.txt", new TextEncoder().encode("a")],
      ["z.txt", new TextEncoder().encode("z")]
    ])
    expect(makeManifest(a)).toEqual(makeManifest(b))
  })
})
