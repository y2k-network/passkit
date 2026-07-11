import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Barcode from "../src/Barcode.ts"
import * as Field from "../src/Field.ts"
import * as Pass from "../src/Pass.ts"
import * as Template from "../src/Template.ts"

class Attendee extends Schema.Class<Attendee>("Attendee")({
  name: Schema.NonEmptyString,
  ticketId: Schema.String,
  tier: Schema.Literals(["ga", "vip"])
}) {}

const EffectDays = Template.make({
  id: Template.Id("effect-days-2026"),
  data: Attendee,
  render: (a) =>
    Pass.eventTicket({
      serial: Pass.Serial(a.ticketId),
      description: `Effect Days 2026 — ${a.tier === "vip" ? "VIP" : "GA"}`
    }).pipe(
      Pass.primary(Field.text({ key: "name", label: "ATTENDEE", value: a.name })),
      Pass.barcode(Barcode.Qr({ content: a.ticketId }))
    )
})

describe("Template.issue", () => {
  test("happy path decodes, renders, and validates", async () => {
    const pass = await Effect.runPromise(
      Template.issue(EffectDays, { name: "Ada Lovelace", ticketId: "TKT-0001", tier: "vip" })
    )
    expect(pass._tag).toBe("EventTicket")
    expect(String(pass.serial)).toBe("TKT-0001")
    expect(pass.description).toContain("VIP")
    expect(pass.slots.primary[0]?.value).toEqual({ _tag: "Text", text: "Ada Lovelace" })
    expect(pass.barcodes[0]).toEqual(Barcode.Qr({ content: "TKT-0001" }))
  })

  test("bad input fails with a readable IssueError", async () => {
    const exit = await Effect.runPromiseExit(
      Template.issue(EffectDays, { name: "", ticketId: "TKT-0002", tier: "vip" })
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = exit.cause
      const err = Effect.runSync(Effect.flip(Effect.failCause(failure) as Effect.Effect<never, Template.IssueError>))
      expect(err._tag).toBe("TemplateIssueError")
      expect(err.templateId).toBe("effect-days-2026")
      expect(err.message).toContain("effect-days-2026")
    }
  })

  test("render producing a duplicate field key surfaces Pass.ValidationError", async () => {
    const Dup = Template.make({
      id: Template.Id("dup-template"),
      data: Attendee,
      render: (a) =>
        Pass.eventTicket({
          serial: Pass.Serial(a.ticketId),
          description: "Duplicate keys"
        }).pipe(
          Pass.primary(Field.text({ key: "name", label: "A", value: a.name })),
          Pass.secondary(Field.text({ key: "name", label: "B", value: a.name }))
        )
    })

    const exit = await Effect.runPromiseExit(
      Template.issue(Dup, { name: "Ada", ticketId: "TKT-0003", tier: "ga" })
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const err = Effect.runSync(
        Effect.flip(Effect.failCause(exit.cause) as Effect.Effect<never, Pass.ValidationError>)
      )
      expect(err._tag).toBe("PassValidationError")
      expect(err.reason).toBe("DuplicateKey")
    }
  })

  test("issueAll renders many, failing fast on the first bad input", async () => {
    const passes = await Effect.runPromise(
      Template.issueAll(EffectDays, [
        { name: "Ada Lovelace", ticketId: "TKT-1", tier: "vip" },
        { name: "Alan Turing", ticketId: "TKT-2", tier: "ga" }
      ])
    )
    expect(passes).toHaveLength(2)
    expect(String(passes[0]!.serial)).toBe("TKT-1")
    expect(String(passes[1]!.serial)).toBe("TKT-2")

    const exit = await Effect.runPromiseExit(
      Template.issueAll(EffectDays, [
        { name: "Ada Lovelace", ticketId: "TKT-3", tier: "vip" },
        { name: "", ticketId: "TKT-4", tier: "ga" }
      ])
    )
    expect(exit._tag).toBe("Failure")
  })
})
