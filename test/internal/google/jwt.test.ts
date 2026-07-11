import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as NodeCrypto from "node:crypto"

import { signJwt } from "../../../src/internal/google/jwt.js"
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

const decodeBase64url = (segment: string): Buffer => Buffer.from(segment, "base64url")

describe("signJwt", () => {
  test("produces three base64url segments", async () => {
    const jwt = await Effect.runPromise(signJwt(serviceAccount, { hello: "world" }))
    const parts = jwt.split(".")
    expect(parts.length).toBe(3)
    for (const part of parts) {
      expect(/^[A-Za-z0-9_-]+$/.test(part)).toBe(true)
    }
  })

  test("header contains alg RS256 and kid", async () => {
    const jwt = await Effect.runPromise(signJwt(serviceAccount, { foo: "bar" }))
    const [headerSegment] = jwt.split(".") as [string, string, string]
    const header = JSON.parse(decodeBase64url(headerSegment).toString("utf8"))
    expect(header.alg).toBe("RS256")
    expect(header.typ).toBe("JWT")
    expect(header.kid).toBe("key-id-1")
  })

  test("claims round-trip through base64url decoding", async () => {
    const claims = { iss: "a@b.com", aud: "google", typ: "savetowallet", iat: 12345 }
    const jwt = await Effect.runPromise(signJwt(serviceAccount, claims))
    const [, claimsSegment] = jwt.split(".") as [string, string, string]
    const decoded = JSON.parse(decodeBase64url(claimsSegment).toString("utf8"))
    expect(decoded).toEqual(claims)
  })

  test("signature verifies against the public key", async () => {
    const claims = { iss: "a@b.com", aud: "google", typ: "savetowallet", iat: 999 }
    const jwt = await Effect.runPromise(signJwt(serviceAccount, claims))
    const [headerSegment, claimsSegment, signatureSegment] = jwt.split(".") as [string, string, string]
    const signingInput = `${headerSegment}.${claimsSegment}`
    const signature = decodeBase64url(signatureSegment)

    const verifier = NodeCrypto.createVerify("RSA-SHA256")
    verifier.update(signingInput)
    verifier.end()

    expect(verifier.verify(publicKey, signature)).toBe(true)
  })

  test("signature fails verification against a different key", async () => {
    const { publicKey: otherPublicKey } = NodeCrypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    })
    const jwt = await Effect.runPromise(signJwt(serviceAccount, { a: 1 }))
    const [headerSegment, claimsSegment, signatureSegment] = jwt.split(".") as [string, string, string]
    const signingInput = `${headerSegment}.${claimsSegment}`
    const signature = decodeBase64url(signatureSegment)

    const verifier = NodeCrypto.createVerify("RSA-SHA256")
    verifier.update(signingInput)
    verifier.end()

    expect(verifier.verify(otherPublicKey, signature)).toBe(false)
  })

  test("fails with JwtError on an invalid private key", async () => {
    const badServiceAccount: ServiceAccount = {
      ...serviceAccount,
      private_key: Redacted.make("not-a-valid-pem-key")
    }
    const exit = await Effect.runPromiseExit(signJwt(badServiceAccount, { a: 1 }))
    expect(exit._tag).toBe("Failure")
  })
})
