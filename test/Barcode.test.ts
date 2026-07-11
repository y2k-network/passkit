import { describe, expect, test } from "bun:test"
import * as Schema from "effect/Schema"
import * as Barcode from "../src/Barcode.ts"

describe("Barcode", () => {
  test("constructors produce tagged values", () => {
    const qr = Barcode.Qr({ content: "TKT-1", altText: "TKT-1" })
    expect(qr._tag).toBe("Qr")
    expect(qr.content).toBe("TKT-1")
    expect(Barcode.$is("Qr")(qr)).toBe(true)
    expect(Barcode.$is("Aztec")(qr)).toBe(false)
  })

  test("all four symbologies construct", () => {
    expect(Barcode.Aztec({ content: "a" })._tag).toBe("Aztec")
    expect(Barcode.Pdf417({ content: "a" })._tag).toBe("Pdf417")
    expect(Barcode.Code128({ content: "a" })._tag).toBe("Code128")
  })

  test("schema round-trip", () => {
    const encoded = Schema.encodeSync(Barcode.BarcodeSchema)(Barcode.Qr({ content: "x" }))
    const decoded = Schema.decodeUnknownSync(Barcode.BarcodeSchema)(encoded)
    expect(decoded).toEqual({ _tag: "Qr", content: "x" })
  })

  test("constructor round-trip with encoding", () => {
    const qr = Barcode.Qr({ content: "x", encoding: "utf-8" })
    expect(qr.encoding).toBe("utf-8")
    const encoded = Schema.encodeSync(Barcode.BarcodeSchema)(qr)
    expect(encoded.encoding).toBe("utf-8")
    const decoded = Schema.decodeUnknownSync(Barcode.BarcodeSchema)(encoded)
    expect(decoded).toEqual({ _tag: "Qr", content: "x", encoding: "utf-8" })
  })

  test("encoding is optional on all four symbologies", () => {
    expect(Barcode.Aztec({ content: "a", encoding: "iso-8859-1" }).encoding).toBe("iso-8859-1")
    expect(Barcode.Pdf417({ content: "a", encoding: "utf-8" }).encoding).toBe("utf-8")
    expect(Barcode.Code128({ content: "a", encoding: "utf-8" }).encoding).toBe("utf-8")
  })

  test("schema decode of legacy barcode JSON without encoding still works", () => {
    const legacy = { _tag: "Qr", content: "legacy" }
    const decoded = Schema.decodeUnknownSync(Barcode.BarcodeSchema)(legacy)
    expect(decoded).toEqual({ _tag: "Qr", content: "legacy" })
    expect(decoded.encoding).toBeUndefined()
  })
})
