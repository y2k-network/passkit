/**
 * End-to-end: one Template -> one Pass -> both Apple.pkpass and
 * Google.saveLink. This is the library's reason to exist.
 */
import { afterEach, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { unzipSync } from "fflate"
import * as NodeCrypto from "node:crypto"
import { rm } from "node:fs/promises"

import * as Apple from "../src/Apple.ts"
import * as Barcode from "../src/Barcode.ts"
import * as Color from "../src/Color.ts"
import * as Field from "../src/Field.ts"
import * as Google from "../src/Google.ts"
import * as Pass from "../src/Pass.ts"
import * as Template from "../src/Template.ts"
import * as Wallet from "../src/Wallet.ts"
import { makeTestChain, type TestChain } from "./internal/apple/testCerts.ts"

class Attendee extends Schema.Class<Attendee>("Attendee")({
  name: Schema.NonEmptyString,
  ticketId: Schema.String
}) {}

const EffectDays = Template.make({
  id: Template.Id("effect-days-2026"),
  data: Attendee,
  render: (a) =>
    Pass.eventTicket({
      serial: Pass.Serial(a.ticketId),
      description: "Effect Days 2026",
      organization: "Effect Days"
    }).pipe(
      Pass.primary(Field.text({ key: "name", label: "ATTENDEE", value: a.name })),
      Pass.barcode(Barcode.Qr({ content: a.ticketId, altText: a.ticketId })),
      Pass.colors({ background: Color.hex("#1e1b4b") })
    )
})

let chain: TestChain | undefined

afterEach(async () => {
  if (chain !== undefined) {
    await rm(chain.dir, { recursive: true, force: true })
    chain = undefined
  }
})

describe("integration: Template -> Apple + Google", () => {
  test("one pass, two wallets", async () => {
    chain = await makeTestChain()

    const pass = await Effect.runPromise(
      Template.issue(EffectDays, { name: "Ada Lovelace", ticketId: "TICKET-001" })
    )

    // --- Apple ---
    const signerLayer = Apple.layer({
      teamId: "TEAM123456",
      passTypeId: "pass.com.acme.tickets",
      certificate: Apple.Certificate.pem({ cert: chain.leafPem, key: chain.leafKeyPem }),
      wwdr: chain.wwdrPem
    })

    const pkpass = await Effect.runPromise(Apple.pkpass(pass).pipe(Effect.provide(signerLayer)))
    expect(pkpass.contentType).toBe("application/vnd.apple.pkpass")

    const unzipped = unzipSync(pkpass.bytes)
    expect(Object.keys(unzipped).sort()).toEqual(["manifest.json", "pass.json", "signature"].sort())

    const passJson = JSON.parse(new TextDecoder().decode(unzipped["pass.json"]))
    expect(passJson.serialNumber).toBe("TICKET-001")
    expect(passJson.description).toBe("Effect Days 2026")

    // --- Google ---
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

    const issuerLayer = Layer.succeed(Google.Issuer, {
      issuerId: "3388000000012345678",
      serviceAccount
    })

    const link = await Effect.runPromise(
      Google.saveLink(pass).pipe(Effect.provide(issuerLayer), Effect.provide(Google.AssetHost.layerNoop))
    )

    expect(link.url).toBe(`https://pay.google.com/gp/v/save/${link.jwt}`)

    const [headerSegment, claimsSegment, signatureSegment] = link.jwt.split(".") as [string, string, string]
    const claims = JSON.parse(Buffer.from(claimsSegment, "base64url").toString("utf8"))
    const verifier = NodeCrypto.createVerify("RSA-SHA256")
    verifier.update(`${headerSegment}.${claimsSegment}`)
    verifier.end()
    expect(verifier.verify(publicKey, Buffer.from(signatureSegment, "base64url"))).toBe(true)

    expect(claims.iss).toBe(serviceAccount.client_email)
    const obj = claims.payload.eventTicketObjects[0]
    expect(obj.id).toBe("3388000000012345678.TICKET-001")
  })

  test("Wallet.issue produces both artifacts concurrently", async () => {
    chain = await makeTestChain()

    const pass = await Effect.runPromise(
      Template.issue(EffectDays, { name: "Grace Hopper", ticketId: "TICKET-002" })
    )

    const signerLayer = Apple.layer({
      teamId: "TEAM123456",
      passTypeId: "pass.com.acme.tickets",
      certificate: Apple.Certificate.pem({ cert: chain.leafPem, key: chain.leafKeyPem }),
      wwdr: chain.wwdrPem
    })

    const { privateKey } = NodeCrypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    })

    const issuerLayer = Layer.succeed(Google.Issuer, {
      issuerId: "3388000000012345678",
      serviceAccount: {
        type: "service_account",
        project_id: "test-project",
        private_key_id: "key-id-1",
        private_key: Redacted.make(privateKey),
        client_email: "wallet@test-project.iam.gserviceaccount.com"
      }
    })

    const offer = await Effect.runPromise(
      Wallet.issue(pass).pipe(
        Effect.provide(Layer.mergeAll(signerLayer, issuerLayer, Google.AssetHost.layerNoop))
      )
    )

    expect(offer.apple.contentType).toBe("application/vnd.apple.pkpass")
    expect(offer.google.url).toBe(`https://pay.google.com/gp/v/save/${offer.google.jwt}`)
  })

  test("JSON round-trip (DB-row) -> Apple.pkpass proves storage is just data", async () => {
    chain = await makeTestChain()

    const pass = await Effect.runPromise(
      Template.issue(EffectDays, { name: "Alan Turing", ticketId: "TICKET-003" })
    )

    // Simulate persisting the pass as a JSON column and reading it back.
    const row = JSON.stringify(Schema.encodeSync(Pass.Schema)(pass))
    const revived = Schema.decodeUnknownSync(Pass.Schema)(JSON.parse(row))

    const signerLayer = Apple.layer({
      teamId: "TEAM123456",
      passTypeId: "pass.com.acme.tickets",
      certificate: Apple.Certificate.pem({ cert: chain.leafPem, key: chain.leafKeyPem }),
      wwdr: chain.wwdrPem
    })

    const pkpass = await Effect.runPromise(Apple.pkpass(revived).pipe(Effect.provide(signerLayer)))
    expect(pkpass.contentType).toBe("application/vnd.apple.pkpass")

    const unzipped = unzipSync(pkpass.bytes)
    const passJson = JSON.parse(new TextDecoder().decode(unzipped["pass.json"]))
    expect(passJson.serialNumber).toBe("TICKET-003")
  })
})
