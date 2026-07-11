import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as NodeCrypto from "node:crypto"

import { signJwt } from "../../../src/internal/google/jwt.js"
import { buildSaveJwtClaims, saveUrl } from "../../../src/internal/google/saveLink.js"
import type { ServiceAccount } from "../../../src/internal/google/serviceAccount.js"

const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
})

const serviceAccount: ServiceAccount = {
  type: "service_account",
  project_id: "test-project",
  private_key_id: "key-id-1",
  private_key: Redacted.make(privateKey),
  client_email: "wallet@test-project.iam.gserviceaccount.com"
}

describe("buildSaveJwtClaims", () => {
  test("assembles standard claims", () => {
    const fixedNow = () => new Date(1_700_000_000_000)
    const payload = { genericObjects: [{ id: "obj-1" }] }
    const claims = buildSaveJwtClaims(serviceAccount, payload, { now: fixedNow })

    expect(claims.iss).toBe(serviceAccount.client_email)
    expect(claims.aud).toBe("google")
    expect(claims.typ).toBe("savetowallet")
    expect(claims.iat).toBe(1_700_000_000)
    expect(claims.payload).toEqual(payload)
    expect(claims.origins).toBeUndefined()
  })

  test("includes origins when provided", () => {
    const claims = buildSaveJwtClaims(
      serviceAccount,
      { genericObjects: [] },
      { origins: ["https://example.com"] }
    )
    expect(claims.origins).toEqual(["https://example.com"])
  })

  test("claims sign and verify end to end", async () => {
    const payload = { eventTicketObjects: [{ id: "tkt-1" }], eventTicketClasses: [{ id: "cls-1" }] }
    const claims = buildSaveJwtClaims(serviceAccount, payload, { origins: ["https://example.com"] })
    const jwt = await Effect.runPromise(signJwt(serviceAccount, claims as unknown as Record<string, unknown>))

    const [headerSegment, claimsSegment, signatureSegment] = jwt.split(".") as [string, string, string]
    const decodedClaims = JSON.parse(Buffer.from(claimsSegment, "base64url").toString("utf8"))
    expect(decodedClaims).toEqual(claims)

    const verifier = NodeCrypto.createVerify("RSA-SHA256")
    verifier.update(`${headerSegment}.${claimsSegment}`)
    verifier.end()
    expect(verifier.verify(publicKey, Buffer.from(signatureSegment, "base64url"))).toBe(true)
  })
})

describe("saveUrl", () => {
  test("builds the pay.google.com save URL", () => {
    expect(saveUrl("abc.def.ghi")).toBe("https://pay.google.com/gp/v/save/abc.def.ghi")
  })
})
