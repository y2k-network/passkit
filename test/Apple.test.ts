import { afterEach, describe, expect, test } from "bun:test"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { unzipSync } from "fflate"
import forge from "node-forge"
import { rm } from "node:fs/promises"

import * as Apple from "../src/Apple.ts"
import * as Asset from "../src/Asset.ts"
import * as Barcode from "../src/Barcode.ts"
import * as Color from "../src/Color.ts"
import * as Field from "../src/Field.ts"
import * as Pass from "../src/Pass.ts"
import { makeManifestJson } from "../src/internal/apple/manifest.ts"
import { makeTestChain, type TestChain } from "./internal/apple/testCerts.ts"

// A minimal valid 1x1 transparent PNG.
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
])

let chain: TestChain | undefined

afterEach(async () => {
  if (chain !== undefined) {
    await rm(chain.dir, { recursive: true, force: true })
    chain = undefined
  }
})

const buildPass = () =>
  Pass.eventTicket({ serial: Pass.Serial("TICKET-001"), description: "EFFECT DAYS", organization: "Effect Days" })
    .pipe(
      Pass.header(Field.text({ key: "event", label: "EVENT", value: "Effect Days" })),
      Pass.primary(Field.text({ key: "name", label: "ATTENDEE", value: "Ada Lovelace" })),
      Pass.secondary(
        Field.date({ key: "date", label: "DATE", value: DateTime.makeUnsafe("2026-09-01T18:00:00Z"), date: "medium" })
      ),
      Pass.auxiliary(
        Field.currency({ key: "price", label: "PRICE", value: BigDecimal.fromNumberUnsafe(42.5), currency: "USD" })
      ),
      Pass.barcode(Barcode.Qr({ content: "TICKET-001", altText: "TICKET-001" })),
      Pass.colors({ background: Color.hex("#1e1b4b"), foreground: Color.hex("#ffffff"), label: Color.hex("#a5b4fc") }),
      Pass.icon(Asset.bytes(TINY_PNG))
    )

describe("Apple.pkpass", () => {
  test("compiles, signs, and zips a full eventTicket bundle", async () => {
    chain = await makeTestChain()

    const pass = buildPass()

    const signerLayer = Apple.layer({
      teamId: "TEAM123456",
      passTypeId: "pass.com.acme.tickets",
      certificate: Apple.Certificate.pem({ cert: chain.leafPem, key: chain.leafKeyPem }),
      wwdr: chain.wwdrPem
    })

    const pkpass = await Effect.runPromise(
      Apple.pkpass(pass).pipe(Effect.provide(signerLayer))
    )

    expect(pkpass.contentType).toBe("application/vnd.apple.pkpass")

    const unzipped = unzipSync(pkpass.bytes)
    expect(Object.keys(unzipped).sort()).toEqual(["icon.png", "manifest.json", "pass.json", "signature"].sort())

    const passJson = JSON.parse(new TextDecoder().decode(unzipped["pass.json"]))
    expect(passJson).toMatchObject({
      formatVersion: 1,
      serialNumber: "TICKET-001",
      description: "EFFECT DAYS",
      organizationName: "Effect Days",
      teamIdentifier: "TEAM123456",
      passTypeIdentifier: "pass.com.acme.tickets",
      backgroundColor: "rgb(30, 27, 75)",
      foregroundColor: "rgb(255, 255, 255)",
      labelColor: "rgb(165, 180, 252)",
      barcodes: [
        { format: "PKBarcodeFormatQR", message: "TICKET-001", messageEncoding: "iso-8859-1", altText: "TICKET-001" }
      ],
      eventTicket: {
        headerFields: [{ key: "event", label: "EVENT", value: "Effect Days" }],
        primaryFields: [{ key: "name", label: "ATTENDEE", value: "Ada Lovelace" }]
      }
    })
    expect(passJson.eventTicket.secondaryFields[0].key).toBe("date")
    expect(passJson.eventTicket.secondaryFields[0].dateStyle).toBe("PKDateStyleMedium")
    expect(passJson.eventTicket.auxiliaryFields[0]).toMatchObject({ key: "price", value: 42.5, currencyCode: "USD" })

    // manifest digests correct for every file
    const files = new Map<string, Uint8Array>([
      ["pass.json", new Uint8Array(unzipped["pass.json"]!)],
      ["icon.png", new Uint8Array(unzipped["icon.png"]!)]
    ])
    const expectedManifest = makeManifestJson(files)
    const actualManifest = JSON.parse(new TextDecoder().decode(unzipped["manifest.json"]))
    expect(actualManifest).toEqual(expectedManifest)

    // signature verifies against manifest via forge (mirrors sign.test.ts's openssl check)
    const p7Der = forge.util.createBuffer(Buffer.from(unzipped["signature"]!).toString("binary"))
    const p7Asn1 = forge.asn1.fromDer(p7Der)
    const p7 = forge.pkcs7.messageFromAsn1(p7Asn1) as forge.pkcs7.PkcsSignedData
    expect(p7.certificates.length).toBe(2)
    const subjects = p7.certificates.map((c) => c.subject.getField("CN")?.value)
    expect(subjects).toContain("Test Pass Type")
    expect(subjects).toContain("Test WWDR")

    // icon present
    expect(unzipped["icon.png"]).toBeDefined()
    expect(new Uint8Array(unzipped["icon.png"]!)).toEqual(TINY_PNG)
  })

  test("boardingPass compiles transitType per mode", async () => {
    chain = await makeTestChain()

    const signerLayer = Apple.layer({
      teamId: "TEAM123456",
      passTypeId: "pass.com.acme.boarding",
      certificate: Apple.Certificate.pem({ cert: chain.leafPem, key: chain.leafKeyPem }),
      wwdr: chain.wwdrPem
    })

    for (const [transit, expected] of [
      ["air", "PKTransitTypeAir"],
      ["train", "PKTransitTypeTrain"],
      ["bus", "PKTransitTypeBus"],
      ["boat", "PKTransitTypeBoat"]
    ] as const) {
      const pass = Pass.boardingPass({ serial: Pass.Serial(`BP-${transit}`), description: "Boarding Pass", transit })

      const pkpass = await Effect.runPromise(Apple.pkpass(pass).pipe(Effect.provide(signerLayer)))
      const unzipped = unzipSync(pkpass.bytes)
      const passJson = JSON.parse(new TextDecoder().decode(unzipped["pass.json"]))
      expect(passJson.boardingPass.transitType).toBe(expected)
    }
  })

  test("resolves an Asset.url from a local server", async () => {
    chain = await makeTestChain()

    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(TINY_PNG, { headers: { "content-type": "image/png" } })
    })

    try {
      const pass = Pass.generic({ serial: Pass.Serial("URL-ASSET"), description: "Generic" }).pipe(
        Pass.icon(Asset.url(`http://localhost:${server.port}/icon.png`))
      )

      const signerLayer = Apple.layer({
        teamId: "TEAM123456",
        passTypeId: "pass.com.acme.generic",
        certificate: Apple.Certificate.pem({ cert: chain.leafPem, key: chain.leafKeyPem }),
        wwdr: chain.wwdrPem
      })

      const pkpass = await Effect.runPromise(Apple.pkpass(pass).pipe(Effect.provide(signerLayer)))
      const unzipped = unzipSync(pkpass.bytes)
      expect(new Uint8Array(unzipped["icon.png"]!)).toEqual(TINY_PNG)
    } finally {
      server.stop(true)
    }
  })

  test("layerUnsigned produces a structurally complete but unsigned bundle", async () => {
    const pass = Pass.generic({ serial: Pass.Serial("NOOP-1"), description: "Generic" })

    const pkpass = await Effect.runPromise(Apple.pkpass(pass).pipe(Effect.provide(Apple.layerUnsigned)))
    const unzipped = unzipSync(pkpass.bytes)
    expect(unzipped["signature"]!.length).toBe(0)
    expect(unzipped["pass.json"]).toBeDefined()
    expect(unzipped["manifest.json"]).toBeDefined()
  })

  test("Apple.layer fails when the signing certificate has already expired", async () => {
    chain = await makeTestChain()

    // Build an already-expired leaf cert.
    const keys = forge.pki.rsa.generateKeyPair(2048)
    const cert = forge.pki.createCertificate()
    cert.publicKey = keys.publicKey
    cert.serialNumber = "01"
    cert.validity.notBefore = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    cert.validity.notAfter = new Date(Date.now() - 24 * 3600 * 1000)
    const attrs = [{ name: "commonName", value: "Expired Pass Type" }]
    cert.setSubject(attrs)
    cert.setIssuer(attrs)
    cert.sign(keys.privateKey, forge.md.sha256.create())

    const certPem = forge.pki.certificateToPem(cert)
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey)

    const signerLayer = Apple.layer({
      teamId: "TEAM123456",
      passTypeId: "pass.com.acme.expired",
      certificate: Apple.Certificate.pem({ cert: certPem, key: keyPem }),
      wwdr: chain.wwdrPem
    })

    const pass = Pass.generic({ serial: Pass.Serial("EXP-1"), description: "Generic" })
    const exit = await Effect.runPromiseExit(Apple.pkpass(pass).pipe(Effect.provide(signerLayer)))
    expect(exit._tag).toBe("Failure")
  })

  test("barcode messageEncoding reflects the barcode's encoding, defaulting to iso-8859-1", async () => {
    const { toPassJson } = await import("../src/internal/apple/compile.ts")

    const config = { teamId: "TEAM123456", passTypeId: "pass.com.acme.tickets" }

    const withUtf8 = Pass.generic({ serial: Pass.Serial("ENC-1"), description: "Generic" }).pipe(
      Pass.barcode(Barcode.Qr({ content: "hello", encoding: "utf-8" }))
    )
    expect(toPassJson(withUtf8, config).barcodes).toEqual([
      { format: "PKBarcodeFormatQR", message: "hello", messageEncoding: "utf-8" }
    ])

    const withDefault = Pass.generic({ serial: Pass.Serial("ENC-2"), description: "Generic" }).pipe(
      Pass.barcode(Barcode.Qr({ content: "hello" }))
    )
    expect(toPassJson(withDefault, config).barcodes).toEqual([
      { format: "PKBarcodeFormatQR", message: "hello", messageEncoding: "iso-8859-1" }
    ])
  })
})
