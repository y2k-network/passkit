import { describe, expect, test } from "bun:test"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as NodeCrypto from "node:crypto"

import * as Asset from "../src/Asset.ts"
import * as Barcode from "../src/Barcode.ts"
import * as Color from "../src/Color.ts"
import * as Field from "../src/Field.ts"
import * as Google from "../src/Google.ts"
import * as Pass from "../src/Pass.ts"

const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
})

const serviceAccount: Google.ServiceAccount = {
  type: "service_account",
  project_id: "test-project",
  private_key_id: "key-id-1",
  private_key: Redacted.make(privateKey),
  client_email: "wallet@test-project.iam.gserviceaccount.com"
}

const issuerLayer = Layer.succeed(Google.Issuer, { issuerId: "3388000000012345678", serviceAccount })

const decodeJwt = (jwt: string) => {
  const [headerSegment, claimsSegment, signatureSegment] = jwt.split(".") as [string, string, string]
  const claims = JSON.parse(Buffer.from(claimsSegment, "base64url").toString("utf8"))
  const verifier = NodeCrypto.createVerify("RSA-SHA256")
  verifier.update(`${headerSegment}.${claimsSegment}`)
  verifier.end()
  const verified = verifier.verify(publicKey, Buffer.from(signatureSegment, "base64url"))
  return { claims, verified }
}

const eventTicket = () =>
  Pass.eventTicket({ serial: Pass.Serial("evt-12345"), description: "Concert Ticket" }).pipe(
    Pass.header(
      Field.date({ key: "doors", label: "DOORS", value: DateTime.makeUnsafe("2026-08-01T19:00:00Z"), date: "medium", time: "short" })
    ),
    Pass.secondary(
      Field.currency({ key: "price", label: "PRICE", value: BigDecimal.fromStringUnsafe("42.50"), currency: "USD" })
    ),
    Pass.barcode(Barcode.Qr({ content: "ticket-payload", altText: "TICKET-1" })),
    Pass.colors({ background: Color.hex("#1e1b4b") }),
    Pass.logo(Asset.url("https://cdn.example.com/logo.png")),
    Pass.venue({ name: "The Fillmore", address: "1805 Geary Blvd" }),
    Pass.seat({ section: "GA", row: "1", seat: "14" })
  )

describe("Google.saveLink", () => {
  test("compiles an event ticket to a signed save link", async () => {
    const program = Google.saveLink(eventTicket()).pipe(
      Effect.provide(issuerLayer),
      Effect.provide(Google.AssetHost.layerNoop)
    )

    const link = await Effect.runPromise(program)
    expect(link.url).toBe(`https://pay.google.com/gp/v/save/${link.jwt}`)

    const { claims, verified } = decodeJwt(link.jwt)
    expect(verified).toBe(true)
    expect(claims.iss).toBe(serviceAccount.client_email)
    expect(claims.aud).toBe("google")
    expect(claims.typ).toBe("savetowallet")

    const cls = claims.payload.eventTicketClasses[0]
    const obj = claims.payload.eventTicketObjects[0]

    expect(cls.id).toBe("3388000000012345678.evt")
    expect(obj.id).toBe("3388000000012345678.evt-12345")
    expect(obj.classId).toBe(cls.id)
    expect(obj.state).toBe("ACTIVE")
    expect(cls.hexBackgroundColor).toBe("#1e1b4b")
    expect(cls.logo).toEqual({ sourceUri: { uri: "https://cdn.example.com/logo.png" } })
    expect(cls.eventName.defaultValue.value).toBe("Concert Ticket")
    expect(cls.venue.name.defaultValue.value).toBe("The Fillmore")

    expect(obj.barcode).toEqual({ type: "QR_CODE", value: "ticket-payload", alternateText: "TICKET-1" })

    expect(obj.seatInfo.section.defaultValue.value).toBe("GA")
    expect(obj.seatInfo.row.defaultValue.value).toBe("1")
    expect(obj.seatInfo.seat.defaultValue.value).toBe("14")

    const priceModule = obj.textModulesData.find((m: any) => m.id === "price")
    expect(priceModule.header).toBe("PRICE")
    expect(priceModule.body).toBe(new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(42.5))

    const doorsModule = obj.textModulesData.find((m: any) => m.id === "doors")
    expect(doorsModule.header).toBe("DOORS")
    expect(typeof doorsModule.body).toBe("string")
    expect(doorsModule.body.length).toBeGreaterThan(0)
  })

  test("respects a custom classSuffix and origins", async () => {
    const program = Google.saveLink(eventTicket(), { classSuffix: "vip", origins: ["https://example.com"] }).pipe(
      Effect.provide(issuerLayer),
      Effect.provide(Google.AssetHost.layerNoop)
    )
    const link = await Effect.runPromise(program)
    const { claims } = decodeJwt(link.jwt)
    expect(claims.origins).toEqual(["https://example.com"])
    expect(claims.payload.eventTicketClasses[0].id).toBe("3388000000012345678.vip")
  })

  test("fails with a named MissingAssetHostError when a Bytes asset needs a host under layerNoop", async () => {
    const pass = eventTicket().pipe(Pass.hero(Asset.bytes(new Uint8Array([1, 2, 3]))))
    const program = Google.saveLink(pass).pipe(
      Effect.provide(issuerLayer),
      Effect.provide(Google.AssetHost.layerNoop)
    )

    const exit = await Effect.runPromiseExit(program)
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const asString = JSON.stringify(exit.cause)
      expect(asString).toContain("GoogleMissingAssetHostError")
      expect(asString).toContain("hero")
    }
  })

  test("a real AssetHost layer produces sourceUri for Bytes assets", async () => {
    const fakeHost = Layer.succeed(Google.AssetHost, {
      upload: () => Effect.succeed("https://cdn.test/x.png")
    })

    const pass = eventTicket().pipe(Pass.logo(Asset.bytes(new Uint8Array([1, 2, 3]))))
    const program = Google.saveLink(pass).pipe(
      Effect.provide(issuerLayer),
      Effect.provide(fakeHost)
    )

    const link = await Effect.runPromise(program)
    const { claims } = decodeJwt(link.jwt)
    const cls = claims.payload.eventTicketClasses[0]
    expect(cls.logo).toEqual({ sourceUri: { uri: "https://cdn.test/x.png" } })
  })

  test("icon/thumbnail assets are never uploaded — Google Wallet has no field for them", async () => {
    const calls: Array<{ role: string; density: string }> = []
    const fakeHost = Layer.succeed(Google.AssetHost, {
      upload: (_bytes, hint) => {
        calls.push({ role: hint.role, density: hint.density })
        return Effect.succeed("https://cdn.test/should-not-be-used.png")
      }
    })

    const pass = eventTicket().pipe(
      Pass.icon(Asset.bytes(new Uint8Array([1, 2, 3]))),
      Pass.thumbnail(Asset.bytes(new Uint8Array([4, 5, 6]))),
      Pass.hero(Asset.url("https://cdn.example.com/hero.png"))
    )
    const program = Google.saveLink(pass).pipe(
      Effect.provide(issuerLayer),
      Effect.provide(fakeHost)
    )

    const link = await Effect.runPromise(program)
    const { claims } = decodeJwt(link.jwt)
    const cls = claims.payload.eventTicketClasses[0]

    // Only the hero URL asset was compiled; icon/thumbnail never triggered
    // an AssetHost.upload call — no wasted uploads for a field Google
    // Wallet doesn't have.
    expect(calls).toEqual([])
    expect(cls.logo).toEqual({ sourceUri: { uri: "https://cdn.example.com/logo.png" } })
    expect(cls.heroImage).toEqual({ sourceUri: { uri: "https://cdn.example.com/hero.png" } })
    expect(cls.icon).toBeUndefined()
    expect(cls.thumbnail).toBeUndefined()
  })
})
