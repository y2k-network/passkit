import { afterEach, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { unzipSync } from "fflate"
import * as NodeCrypto from "node:crypto"
import { rm } from "node:fs/promises"

import * as Apple from "../src/Apple.ts"
import * as Barcode from "../src/Barcode.ts"
import * as Fidelity from "../src/Fidelity.ts"
import * as Google from "../src/Google.ts"
import * as Pass from "../src/Pass.ts"
import * as Relevance from "../src/Relevance.ts"
import * as Wallet from "../src/Wallet.ts"
import { makeTestChain, type TestChain } from "./internal/apple/testCerts.ts"

let chain: TestChain | undefined

afterEach(async () => {
  if (chain !== undefined) {
    await rm(chain.dir, { recursive: true, force: true })
    chain = undefined
  }
})

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

const buildPass = () =>
  Pass.eventTicket({ serial: Pass.Serial("evt-wallet-1"), description: "Wallet Facade Ticket" }).pipe(
    Pass.barcode(Barcode.Qr({ content: "wallet-payload", altText: "TICKET-1" }))
  )

const runWith = (signerLayer: Layer.Layer<Apple.Signer, any>) =>
  Layer.mergeAll(signerLayer, issuerLayer, Google.AssetHost.layerNoop)

describe("Wallet.issue", () => {
  test("issues both an Apple pkpass and a Google save link", async () => {
    chain = await makeTestChain()

    const signerLayer = Apple.layer({
      teamId: "TEAM123456",
      passTypeId: "pass.com.acme.tickets",
      certificate: Apple.Certificate.pem({ cert: chain.leafPem, key: chain.leafKeyPem }),
      wwdr: chain.wwdrPem
    })

    const offer = await Effect.runPromise(
      Wallet.issue(buildPass()).pipe(Effect.provide(runWith(signerLayer)))
    )

    expect(offer.apple.contentType).toBe("application/vnd.apple.pkpass")
    const unzipped = unzipSync(offer.apple.bytes)
    expect(Object.keys(unzipped).sort()).toEqual(["manifest.json", "pass.json", "signature"].sort())

    expect(offer.google.url).toBe(`https://pay.google.com/gp/v/save/${offer.google.jwt}`)
    const { claims, verified } = decodeJwt(offer.google.jwt)
    expect(verified).toBe(true)
    expect(claims.iss).toBe(serviceAccount.client_email)
  })

  test("onUnsupported: error fails on a Beacon-relevance pass (Google side)", async () => {
    const passWithBeacon = buildPass().pipe(
      Pass.relevant(Relevance.beacon({ proximityUUID: "E2C56DB5-DFFB-48D2-B060-D0F5A71096E0" }))
    )

    const program = Wallet.issue(passWithBeacon, { onUnsupported: "error" }).pipe(
      Effect.provide(Layer.mergeAll(Apple.layerUnsigned, issuerLayer, Google.AssetHost.layerNoop))
    )

    let caught: Fidelity.UnsupportedError | undefined
    await Effect.runPromise(
      program.pipe(
        Effect.catchTag("FidelityUnsupportedError", (error) => {
          caught = error
          return Effect.void
        }),
        Effect.catchTag("AppleAssetResolveError", () => Effect.void),
        Effect.catchTag("GoogleMissingAssetHostError", () => Effect.void),
        Effect.catchTag("GoogleAssetUploadError", () => Effect.void),
        Effect.catchTag("PassValidationError", () => Effect.void),
        Effect.catchTag("ServiceAccountError", () => Effect.void),
        Effect.catchTag("JwtError", () => Effect.void),
        Effect.catchTag("SigningError", () => Effect.void)
      )
    )

    expect(caught).toBeDefined()
    expect(caught?._tag).toBe("FidelityUnsupportedError")
    expect(caught?.findings.some((f) => Fidelity.isDropped(f) && f.feature === "Beacon relevance")).toBe(true)
  })

  test("onUnsupported: ignore succeeds despite the Beacon-relevance finding", async () => {
    chain = await makeTestChain()

    const passWithBeacon = buildPass().pipe(
      Pass.relevant(Relevance.beacon({ proximityUUID: "E2C56DB5-DFFB-48D2-B060-D0F5A71096E0" }))
    )

    const signerLayer = Apple.layer({
      teamId: "TEAM123456",
      passTypeId: "pass.com.acme.tickets",
      certificate: Apple.Certificate.pem({ cert: chain.leafPem, key: chain.leafKeyPem }),
      wwdr: chain.wwdrPem
    })

    const offer = await Effect.runPromise(
      Wallet.issue(passWithBeacon, { onUnsupported: "ignore" }).pipe(
        Effect.provide(runWith(signerLayer))
      )
    )

    expect(offer.apple.contentType).toBe("application/vnd.apple.pkpass")
    expect(offer.google.jwt).toBeTruthy()
  })
})
