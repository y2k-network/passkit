import { describe, expect, test } from "bun:test"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Asset from "../src/Asset.ts"
import * as Barcode from "../src/Barcode.ts"
import * as Color from "../src/Color.ts"
import * as Field from "../src/Field.ts"
import * as Pass from "../src/Pass.ts"
import * as Relevance from "../src/Relevance.ts"

const doors = DateTime.makeUnsafe("2026-07-11T19:00:00Z")
const ends = DateTime.makeUnsafe("2026-07-11T23:00:00Z")

// `Field.date`/`Field.currency`/`Relevance.during` carry `DateTime.Utc` and
// `BigDecimal` values; `FieldSchema`/`RelevanceSchema` encode those to
// JSON-primitive ISO-8601 strings and decimal strings (`DateTimeUtcFromString`,
// `BigDecimalFromString`), so the whole pass — including these variants —
// round-trips through a literal `JSON.stringify`/`JSON.parse` hop below.
const buildRichTicket = (): Pass.Pass =>
  Pass.eventTicket({
    serial: Pass.Serial("TKT-8675309"),
    description: "Effect Days 2026 — General Admission",
    organization: "Effectful Technologies"
  }).pipe(
    Pass.header(Field.text({ key: "gate", label: "GATE", value: "B42" })),
    Pass.primary(Field.text({ key: "event", label: "EVENT", value: "Effect Days 2026" })),
    Pass.secondary(
      Field.date({ key: "doors", label: "DOORS", value: doors, date: "medium", time: "short" }),
      Field.text({ key: "section", label: "SECTION", value: "GA" })
    ),
    Pass.auxiliary(
      Field.number({ key: "points", label: "POINTS", value: 8250, style: "decimal" }),
      Field.currency({ key: "balance", label: "BALANCE", value: BigDecimal.make(2450n, 2), currency: "USD" })
    ),
    Pass.back(Field.text({ key: "terms", label: "Terms", value: "Non-transferable." })),
    Pass.barcode(Barcode.Qr({ content: "TKT-8675309", altText: "TKT-8675309" })),
    Pass.colors({
      background: Color.hex("#1e1b4b"),
      foreground: Color.hex("#ffffff"),
      label: Color.hex("#a5b4fc")
    }),
    Pass.logo(Asset.file("assets/logo.png")),
    Pass.icon(Asset.file("assets/icon.png"), { "2x": Asset.file("assets/icon@2x.png") }),
    Pass.relevant(
      Relevance.near({ lat: 52.52, lng: 13.405, note: "Walk to Gate B42" }),
      Relevance.during({ start: doors, end: ends })
    ),
    Pass.venue({ name: "Kraftwerk Berlin", address: "Köpenicker Str. 70" }),
    Pass.seat({ section: "GA" })
  )

describe("Pass.Schema round-trip", () => {
  test("rich pass survives encode -> JSON -> decode", () => {
    const pass = buildRichTicket()

    const encoded = Schema.encodeSync(Pass.Schema)(pass)
    const json = JSON.parse(JSON.stringify(encoded))
    const decoded = Schema.decodeUnknownSync(Pass.Schema)(json)

    expect(decoded._tag).toBe("EventTicket")
    expect(String(decoded.serial)).toBe("TKT-8675309")
    expect(decoded.slots.header).toHaveLength(1)
    expect(decoded.slots.primary).toHaveLength(1)
    expect(decoded.slots.secondary).toHaveLength(2)
    expect(decoded.slots.auxiliary).toHaveLength(2)
    expect(decoded.slots.back).toHaveLength(1)
    expect(decoded.barcodes).toHaveLength(1)
    expect(decoded.relevance).toHaveLength(2)
    expect(decoded.semantics.venue?.name).toBe("Kraftwerk Berlin")
    expect(decoded.semantics.seat?.section).toBe("GA")
    expect(decoded.assets.logo?.["1x"]).toBeDefined()
    expect(decoded.assets.icon?.["2x"]).toBeDefined()

    // Date/Currency/During variants decoded from plain JSON strings back
    // into real DateTime.Utc / BigDecimal runtime values.
    const doorsField = decoded.slots.secondary[0]!
    expect(Field.isDate(doorsField.value) && DateTime.isDateTime(doorsField.value.value)).toBe(true)
    expect(Field.isDate(doorsField.value) && DateTime.Equivalence(doorsField.value.value, doors)).toBe(true)

    const balanceField = decoded.slots.auxiliary[1]!
    expect(
      Field.isCurrency(balanceField.value) &&
        BigDecimal.equals(balanceField.value.value, BigDecimal.make(2450n, 2))
    ).toBe(true)

    const during = decoded.relevance.find(Relevance.isDuring)!
    expect(Relevance.isDuring(during) && DateTime.Equivalence(during.start, doors)).toBe(true)
    expect(Relevance.isDuring(during) && DateTime.Equivalence(during.end, ends)).toBe(true)

    // re-encoding the decoded pass produces the same structural JSON,
    // including a plain JSON round-trip (stringify -> parse -> decode -> re-encode).
    const reEncoded = Schema.encodeSync(Pass.Schema)(decoded)
    expect(JSON.parse(JSON.stringify(reEncoded))).toEqual(json)

    const reJson = JSON.parse(JSON.stringify(reEncoded))
    const reDecoded = Schema.decodeUnknownSync(Pass.Schema)(reJson)
    const reReEncoded = Schema.encodeSync(Pass.Schema)(reDecoded)
    expect(JSON.parse(JSON.stringify(reReEncoded))).toEqual(json)
  })

  test("decoded pass still works with combinators", () => {
    const pass = buildRichTicket()
    const encoded = Schema.encodeSync(Pass.Schema)(pass)
    const decoded = Schema.decodeUnknownSync(Pass.Schema)(encoded)

    const updated = decoded.pipe(Pass.header(Field.text({ key: "extra", label: "EXTRA", value: "1" })))
    expect(updated.slots.header).toHaveLength(2)
  })

  test("decoded pass still validates", async () => {
    const pass = buildRichTicket()
    const encoded = Schema.encodeSync(Pass.Schema)(pass)
    const decoded = Schema.decodeUnknownSync(Pass.Schema)(encoded)

    const result = await Effect.runPromise(Pass.validate(decoded))
    expect(result).toBe(decoded)
  })

  test("Field.date and Relevance.during round-trip through Schema (no JSON hop)", () => {
    const pass = Pass.eventTicket({ serial: Pass.Serial("TKT-DATE"), description: "Effect Days" }).pipe(
      Pass.secondary(Field.date({ key: "doors", label: "DOORS", value: doors, date: "medium", time: "short" })),
      Pass.relevant(Relevance.during({ start: doors, end: ends }))
    )

    const encoded = Schema.encodeSync(Pass.Schema)(pass)
    const decoded = Schema.decodeUnknownSync(Pass.Schema)(encoded)

    expect(Field.isDate(decoded.slots.secondary[0]!.value)).toBe(true)
    expect(Relevance.isDuring(decoded.relevance[0]!)).toBe(true)
  })

  test("boardingPass round-trips with transit", () => {
    const bp = Pass.boardingPass({
      serial: Pass.Serial("BP-1"),
      description: "SFO -> JFK",
      transit: "air"
    }).pipe(
      Pass.origin(Field.text({ key: "origin", value: "SFO" })),
      Pass.destination(Field.text({ key: "destination", value: "JFK" }))
    )

    const encoded = Schema.encodeSync(Pass.Schema)(bp)
    const decoded = Schema.decodeUnknownSync(Pass.Schema)(encoded)

    expect(decoded._tag).toBe("BoardingPass")
    expect(decoded.transit).toBe("air")
    expect(decoded.slots.primary).toHaveLength(2)
  })
})

describe("Pass.Schema rejection cases", () => {
  test("rejects an unknown kind tag", () => {
    const bogus = {
      _tag: "NotAKind",
      serial: "X-1",
      description: "x",
      slots: { header: [], primary: [], secondary: [], auxiliary: [], back: [] },
      barcodes: [],
      assets: {},
      relevance: [],
      semantics: {}
    }
    expect(() => Schema.decodeUnknownSync(Pass.Schema)(bogus)).toThrow()
  })

  test("rejects a boardingPass missing transit", () => {
    const bogus = {
      _tag: "BoardingPass",
      serial: "BP-9",
      description: "x",
      slots: { header: [], primary: [], secondary: [], auxiliary: [], back: [] },
      barcodes: [],
      assets: {},
      relevance: [],
      semantics: {}
    }
    expect(() => Schema.decodeUnknownSync(Pass.Schema)(bogus)).toThrow()
  })

  test("rejects a malformed field", () => {
    const bogus = {
      _tag: "EventTicket",
      serial: "TKT-9",
      description: "x",
      slots: {
        header: [{ key: "gate", value: { _tag: "NotAFieldValue", whatever: 1 } }],
        primary: [],
        secondary: [],
        auxiliary: [],
        back: []
      },
      barcodes: [],
      assets: {},
      relevance: [],
      semantics: {}
    }
    expect(() => Schema.decodeUnknownSync(Pass.Schema)(bogus)).toThrow()
  })
})
