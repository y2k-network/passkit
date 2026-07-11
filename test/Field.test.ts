import { describe, expect, test } from "bun:test"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import * as Field from "../src/Field.ts"

describe("Field", () => {
  test("text/date/number/currency construct with typed values", () => {
    const t = Field.text({ key: "seat", label: "SEAT", value: "14C" })
    expect(Field.isText(t.value)).toBe(true)

    const d = Field.date({ key: "departs", value: DateTime.makeUnsafe("2026-01-01T00:00:00Z") })
    expect(Field.isDate(d.value)).toBe(true)

    const n = Field.number({ key: "points", value: 8250 })
    expect(Field.isNumber(n.value)).toBe(true)

    const c = Field.currency({ key: "balance", value: BigDecimal.make(2450n, 2), currency: "USD" })
    expect(Field.isCurrency(c.value)).toBe(true)
  })

  test("key is branded and non-empty", () => {
    const k = Field.Key("gate")
    expect(String(k)).toBe("gate")
  })

  test("changed attaches a changeMessage", () => {
    const f = Field.text({ key: "gate", value: "B42" })
    const changed = Field.changed(f, "Gate changed to %@")
    expect(String(changed.changeMessage)).toBe("Gate changed to %@")
    expect(f.changeMessage).toBeUndefined()
  })

  test("schema round-trips a text field", () => {
    const f = Field.text({ key: "seat", label: "SEAT", value: "14C" })
    const encoded = Schema.encodeSync(Field.FieldSchema)(f as any)
    const decoded = Schema.decodeUnknownSync(Field.FieldSchema)(encoded)
    expect(String(decoded.key)).toBe("seat")
    expect(decoded.value).toEqual({ _tag: "Text", text: "14C" })
  })

  test("schema round-trips a currency field", () => {
    const f = Field.currency({ key: "balance", value: BigDecimal.make(2450n, 2), currency: "USD" })
    const encoded = Schema.encodeSync(Field.FieldSchema)(f as any)
    const decoded = Schema.decodeUnknownSync(Field.FieldSchema)(encoded)
    expect(String(decoded.key)).toBe("balance")
    expect(Field.isCurrency(decoded.value) && BigDecimal.equals(decoded.value.value, BigDecimal.make(2450n, 2))).toBe(
      true
    )
  })

  test("currency and date fields encode to JSON-primitive strings", () => {
    const c = Field.currency({ key: "balance", value: BigDecimal.make(2450n, 2), currency: "USD" })
    const cEncoded = Schema.encodeSync(Field.FieldSchema)(c as any) as any
    expect(typeof cEncoded.value.value).toBe("string")
    const cJson = JSON.parse(JSON.stringify(cEncoded))
    const cDecoded = Schema.decodeUnknownSync(Field.FieldSchema)(cJson)
    expect(Field.isCurrency(cDecoded.value) && BigDecimal.equals(cDecoded.value.value, BigDecimal.make(2450n, 2)))
      .toBe(true)

    const d = Field.date({ key: "departs", value: DateTime.makeUnsafe("2026-01-01T00:00:00Z") })
    const dEncoded = Schema.encodeSync(Field.FieldSchema)(d as any) as any
    expect(typeof dEncoded.value.value).toBe("string")
    const dJson = JSON.parse(JSON.stringify(dEncoded))
    const dDecoded = Schema.decodeUnknownSync(Field.FieldSchema)(dJson)
    expect(
      Field.isDate(dDecoded.value) &&
        DateTime.Equivalence(dDecoded.value.value, DateTime.makeUnsafe("2026-01-01T00:00:00Z"))
    ).toBe(true)
  })
})
