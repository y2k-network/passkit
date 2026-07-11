import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Asset from "../src/Asset.ts"
import * as Color from "../src/Color.ts"
import * as Field from "../src/Field.ts"
import * as Fidelity from "../src/Fidelity.ts"
import * as Pass from "../src/Pass.ts"
import * as Relevance from "../src/Relevance.ts"

const lossyPass = () =>
  Pass.eventTicket({ serial: Pass.Serial("TKT-1"), description: "Effect Days" }).pipe(
    Pass.relevant(Relevance.beacon({ proximityUUID: "uuid-1" })),
    Pass.secondary(Field.changed(Field.text({ key: "gate", label: "GATE", value: "B42" }), "Gate changed to %@")),
    Pass.strip(Asset.file("strip.png"), { "2x": Asset.file("strip@2x.png"), "3x": Asset.file("strip@3x.png") }),
    Pass.hero(Asset.file("hero.png")),
    Pass.colors({ label: Color.hex("#ff0000") })
  )

describe("Fidelity.audit", () => {
  test("beacon + strip/hero + changeMessage + density variants + label color", () => {
    const report = Fidelity.audit(lossyPass())

    expect(report.google).toEqual([
      Fidelity.dropped({
        target: "google",
        path: "relevance[0]",
        feature: "Beacon relevance",
        reason: "Google Wallet has no iBeacon-region relevance equivalent"
      }),
      Fidelity.approximated({
        target: "google",
        path: "slots.secondary[0].changeMessage",
        feature: "Field changeMessage",
        reason: "Google Wallet has no per-field update template",
        approximation: "rendered as a generic push-notification message"
      }),
      Fidelity.dropped({
        target: "google",
        path: "assets.strip",
        feature: "Strip asset",
        reason: "Google Wallet has one hero-image slot and hero is also set; hero wins"
      }),
      Fidelity.dropped({
        target: "google",
        path: "assets.strip.2x",
        feature: "2x density variant",
        reason: "Google Wallet takes a single image per role"
      }),
      Fidelity.dropped({
        target: "google",
        path: "assets.strip.3x",
        feature: "3x density variant",
        reason: "Google Wallet takes a single image per role"
      }),
      Fidelity.dropped({
        target: "google",
        path: "colors.label",
        feature: "Label color",
        reason: "Google Wallet has no labelColor equivalent"
      })
    ])

    expect(report.apple).toEqual([
      Fidelity.dropped({
        target: "apple",
        path: "assets.hero",
        feature: "Hero asset",
        reason: "Apple Wallet has one strip/background image slot and strip is also set; strip wins"
      })
    ])
  })

  test("strip is approximated as hero when hero is absent", () => {
    const p = Pass.eventTicket({ serial: Pass.Serial("TKT-3"), description: "Strip only" }).pipe(
      Pass.strip(Asset.file("strip.png"))
    )
    const report = Fidelity.audit(p)
    expect(report.google).toEqual([
      Fidelity.approximated({
        target: "google",
        path: "assets.strip",
        feature: "Strip asset",
        reason: "Google Wallet has a single hero image, not a distinct strip",
        approximation: "mapped to hero image"
      })
    ])
  })

  test("icon and thumbnail are dropped for google — no field exists for either", () => {
    const p = Pass.eventTicket({ serial: Pass.Serial("TKT-4"), description: "Icon+Thumb" }).pipe(
      Pass.icon(Asset.file("icon.png")),
      Pass.thumbnail(Asset.file("thumb.png"))
    )
    const report = Fidelity.audit(p)
    expect(report.google).toEqual([
      Fidelity.dropped({
        target: "google",
        path: "assets.icon",
        feature: "Icon asset",
        reason: "Google Wallet has no icon image field"
      }),
      Fidelity.dropped({
        target: "google",
        path: "assets.thumbnail",
        feature: "Thumbnail asset",
        reason: "Google Wallet has no thumbnail image field"
      })
    ])
  })

  test("a clean pass yields no findings", () => {
    const p = Pass.eventTicket({ serial: Pass.Serial("TKT-2"), description: "Clean" })
    const report = Fidelity.audit(p)
    expect(report.apple).toEqual([])
    expect(report.google).toEqual([])
  })
})

describe("Fidelity.enforce", () => {
  test("ignore succeeds regardless of findings", async () => {
    const findings = Fidelity.audit(lossyPass()).google
    const result = await Effect.runPromise(Fidelity.enforce(findings, "ignore"))
    expect(result).toBeUndefined()
  })

  test("error fails with an UnsupportedError carrying the findings", async () => {
    const findings = Fidelity.audit(lossyPass()).google
    const error = await Effect.runPromise(Effect.flip(Fidelity.enforce(findings, "error")))
    expect(error).toBeInstanceOf(Fidelity.UnsupportedError)
    expect(error.findings).toEqual(findings)
  })

  test("error succeeds when there are no findings", async () => {
    const result = await Effect.runPromise(Fidelity.enforce([], "error"))
    expect(result).toBeUndefined()
  })

  test("warn logs one line per finding and succeeds", async () => {
    const findings = Fidelity.audit(lossyPass()).google
    const result = await Effect.runPromise(Fidelity.enforce(findings, "warn"))
    expect(result).toBeUndefined()
  })
})

describe("Fidelity.format", () => {
  test("renders a readable line per finding kind", () => {
    expect(
      Fidelity.format(
        Fidelity.dropped({ target: "google", path: "relevance[0]", feature: "Beacon relevance", reason: "nope" })
      )
    ).toBe("[google] dropped Beacon relevance at relevance[0]: nope")

    expect(
      Fidelity.format(
        Fidelity.approximated({
          target: "google",
          path: "assets.strip",
          feature: "Strip asset",
          reason: "no distinct strip",
          approximation: "mapped to hero"
        })
      )
    ).toBe("[google] approximated Strip asset at assets.strip: no distinct strip (mapped to hero)")

    expect(
      Fidelity.format(
        Fidelity.resized({ target: "apple", path: "assets.icon", feature: "Icon", reason: "too big" })
      )
    ).toBe("[apple] resized Icon at assets.icon: too big")
  })
})
