import { describe, expect, test } from "bun:test"
import * as Asset from "../src/Asset.ts"

describe("Asset", () => {
  test("file/url/bytes constructors", () => {
    expect(Asset.file("logo.png")).toEqual({ _tag: "File", path: "logo.png" })
    expect(Asset.url("https://cdn/logo.png")).toEqual({ _tag: "Url", url: "https://cdn/logo.png" })
    const bytes = new Uint8Array([1, 2, 3])
    expect(Asset.isBytes(Asset.bytes(bytes))).toBe(true)
  })

  test("set builds an AssetSet with density variants", () => {
    const base = Asset.file("icon.png")
    const s = Asset.set(base, { "2x": Asset.file("icon@2x.png") })
    expect(s["1x"]).toBe(base)
    expect(s["2x"]).toBeDefined()
    expect(s["3x"]).toBeUndefined()
  })
})
