import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Asset from "../src/Asset.ts"
import * as Barcode from "../src/Barcode.ts"
import * as Color from "../src/Color.ts"
import * as BigDecimal from "effect/BigDecimal"
import * as Field from "../src/Field.ts"
import * as Pass from "../src/Pass.ts"

describe("Pass construction", () => {
  test("eventTicket", () => {
    const p = Pass.eventTicket({ serial: Pass.Serial("TKT-1"), description: "Effect Days" })
    expect(String(p._tag)).toBe("EventTicket")
    expect(String(p.serial)).toBe("TKT-1")
    expect(p.slots.header).toEqual([])
  })

  test("boardingPass requires a transit mode", () => {
    const p = Pass.boardingPass({ serial: Pass.Serial("BP-1"), description: "SFO -> JFK", transit: "air" })
    expect(String(p._tag)).toBe("BoardingPass")
    expect(String(p.transit)).toBe("air")
  })

  test("coupon / storeCard / generic", () => {
    expect(Pass.coupon({ serial: Pass.Serial("C-1"), description: "10% off" })._tag).toBe("Coupon")
    expect(Pass.storeCard({ serial: Pass.Serial("S-1"), description: "Loyalty" })._tag).toBe("StoreCard")
    expect(Pass.generic({ serial: Pass.Serial("G-1"), description: "Misc" })._tag).toBe("Generic")
  })
})

describe("Pass pipe composition (dual combinators)", () => {
  test("data-last (pipe) style", () => {
    const p = Pass.eventTicket({ serial: Pass.Serial("TKT-2"), description: "Effect Days" }).pipe(
      Pass.header(Field.text({ key: "gate", label: "GATE", value: "B42" })),
      Pass.primary(Field.text({ key: "event", label: "EVENT", value: "Effect Days 2026" })),
      Pass.secondary(
        Field.text({ key: "doors", label: "DOORS", value: "7:00 PM" }),
        Field.text({ key: "section", label: "SECTION", value: "GA" })
      ),
      Pass.back(Field.text({ key: "terms", label: "Terms", value: "Non-transferable." })),
      Pass.barcode(Barcode.Qr({ content: "TKT-2", altText: "TKT-2" })),
      Pass.colors({
        background: Color.hex("#1e1b4b"),
        foreground: Color.hex("#ffffff"),
        label: Color.hex("#a5b4fc")
      }),
      Pass.logo(Asset.file("assets/logo.png")),
      Pass.icon(Asset.file("assets/icon.png"), { "2x": Asset.file("assets/icon@2x.png") }),
      Pass.venue({ name: "Kraftwerk Berlin" }),
      Pass.seat({ section: "GA" })
    )

    expect(p.slots.header).toHaveLength(1)
    expect(p.slots.primary).toHaveLength(1)
    expect(p.slots.secondary).toHaveLength(2)
    expect(p.slots.back).toHaveLength(1)
    expect(p.barcodes).toHaveLength(1)
    expect(String(p.colors?.background)).toBe("#1e1b4b")
    expect(p.assets.logo?.["1x"]).toBeDefined()
    expect(p.assets.icon?.["2x"]).toBeDefined()
    expect(String(p.semantics.venue?.name)).toBe("Kraftwerk Berlin")
    expect(String(p.semantics.seat?.section)).toBe("GA")
  })

  test("data-first style produces the same result as data-last", () => {
    const base = Pass.eventTicket({ serial: Pass.Serial("TKT-3"), description: "Effect Days" })
    const field = Field.text({ key: "gate", value: "B42" })

    const viaPipe = base.pipe(Pass.header(field))
    const viaDataFirst = Pass.header(base, field)

    expect(viaPipe.slots.header).toEqual(viaDataFirst.slots.header)
  })

  test("storeCard balance and boardingPass origin/destination", () => {
    const card = Pass.storeCard({ serial: Pass.Serial("S-2"), description: "Loyalty" }).pipe(
      Pass.balance(Field.currency({ key: "balance", value: BigDecimal.make(2450n, 2), currency: "USD" }))
    )
    expect(card.slots.primary).toHaveLength(1)

    const bp = Pass.boardingPass({ serial: Pass.Serial("BP-2"), description: "SFO -> JFK", transit: "air" }).pipe(
      Pass.origin(Field.text({ key: "origin", value: "SFO" })),
      Pass.destination(Field.text({ key: "destination", value: "JFK" }))
    )
    expect(bp.slots.primary).toHaveLength(2)
    expect(String(bp.slots.primary[0]!.key)).toBe("origin")
    expect(String(bp.slots.primary[1]!.key)).toBe("destination")
  })
})

describe("Pass.validate", () => {
  test("passes valid pass", async () => {
    const p = Pass.eventTicket({ serial: Pass.Serial("TKT-4"), description: "Effect Days" }).pipe(
      Pass.header(Field.text({ key: "gate", value: "B42" }))
    )
    const result = await Effect.runPromise(Pass.validate(p))
    expect(result).toBe(p)
  })

  test("fails on duplicate keys", async () => {
    const p = Pass.eventTicket({ serial: Pass.Serial("TKT-5"), description: "Effect Days" }).pipe(
      Pass.header(Field.text({ key: "gate", value: "B42" })),
      Pass.secondary(Field.text({ key: "gate", value: "duplicate" }))
    )
    const exit = await Effect.runPromiseExit(Pass.validate(p))
    expect(String(exit._tag)).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = exit.cause
      expect(String(failure)).toContain("gate")
    }
  })

  test("fails on header slot overflow (limit 3)", async () => {
    const p = Pass.eventTicket({ serial: Pass.Serial("TKT-6"), description: "Effect Days" }).pipe(
      Pass.header(
        Field.text({ key: "a", value: "1" }),
        Field.text({ key: "b", value: "2" }),
        Field.text({ key: "c", value: "3" }),
        Field.text({ key: "d", value: "4" })
      )
    )
    const exit = await Effect.runPromiseExit(Pass.validate(p))
    expect(String(exit._tag)).toBe("Failure")
  })

  test("fails on eventTicket primary overflow (limit 1) but boardingPass allows 2", async () => {
    const ticket = Pass.eventTicket({ serial: Pass.Serial("TKT-7"), description: "Effect Days" }).pipe(
      Pass.primary(Field.text({ key: "a", value: "1" }), Field.text({ key: "b", value: "2" }))
    )
    const ticketExit = await Effect.runPromiseExit(Pass.validate(ticket))
    expect(String(ticketExit._tag)).toBe("Failure")

    const boarding = Pass.boardingPass({ serial: Pass.Serial("BP-3"), description: "x", transit: "air" }).pipe(
      Pass.primary(Field.text({ key: "a", value: "1" }), Field.text({ key: "b", value: "2" }))
    )
    const boardingResult = await Effect.runPromise(Pass.validate(boarding))
    expect(boardingResult.slots.primary).toHaveLength(2)
  })
})
