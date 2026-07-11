import { describe, expect, test } from "bun:test"
import * as DateTime from "effect/DateTime"
import * as Relevance from "../src/Relevance.ts"

describe("Relevance", () => {
  test("near/during/beacon constructors", () => {
    const near = Relevance.near({ lat: 52.52, lng: 13.405, note: "Walk to Gate B42" })
    expect(Relevance.isNear(near)).toBe(true)

    const during = Relevance.during({
      start: DateTime.makeUnsafe("2026-01-01T19:00:00Z"),
      end: DateTime.makeUnsafe("2026-01-01T23:00:00Z")
    })
    expect(Relevance.isDuring(during)).toBe(true)

    const beacon = Relevance.beacon({ proximityUUID: "uuid", major: 1, minor: 2 })
    expect(Relevance.isBeacon(beacon)).toBe(true)
  })
})
