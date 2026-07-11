import { describe, expect, test } from "bun:test"
import { unzipSync } from "fflate"
import { makeZip } from "../../../src/internal/apple/zip.ts"

describe("makeZip", () => {
  test("round-trips through fflate's unzipSync with all entries intact", () => {
    const files = new Map<string, Uint8Array>([
      ["pass.json", new TextEncoder().encode('{"formatVersion":1}')],
      ["manifest.json", new TextEncoder().encode('{"pass.json":"abc"}')],
      ["signature", new Uint8Array([1, 2, 3, 4, 5])],
      ["icon.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47])]
    ])

    const zipped = makeZip(files)
    const unzipped = unzipSync(zipped)

    expect(Object.keys(unzipped).sort()).toEqual([...files.keys()].sort())
    for (const [name, bytes] of files) {
      expect(new Uint8Array(unzipped[name]!)).toEqual(new Uint8Array(bytes))
    }
  })

  test("produces a non-empty archive for an empty file map", () => {
    const zipped = makeZip(new Map())
    expect(zipped.length).toBeGreaterThan(0)
    expect(Object.keys(unzipSync(zipped))).toEqual([])
  })
})
