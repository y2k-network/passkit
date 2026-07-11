import { describe, expect, test } from "bun:test"
import * as Schema from "effect/Schema"
import * as Color from "../src/Color.ts"

describe("Color", () => {
  test("hex validates and brands", () => {
    const c = Color.hex("#1e1b4b")
    expect(String(c)).toBe("#1e1b4b")
  })

  test("hex rejects invalid strings", () => {
    expect(() => Color.hex("blue")).toThrow()
    expect(() => Color.hex("#fff")).toThrow()
  })

  test("rgb builds a hex color", () => {
    expect(String(Color.rgb(30, 27, 75))).toBe("#1e1b4b")
    expect(String(Color.rgb(255, 255, 255))).toBe("#ffffff")
  })

  test("schema round-trips", () => {
    const encoded = Schema.encodeSync(Color.ColorSchema)(Color.hex("#a5b4fc"))
    const decoded = Schema.decodeUnknownSync(Color.ColorSchema)(encoded)
    expect(String(decoded)).toBe("#a5b4fc")
  })
})
