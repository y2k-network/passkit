import { afterEach, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { TestClock } from "effect/testing"
import { rm } from "node:fs/promises"
import {
  CertificateError,
  fromPem,
  fromPkcs12,
  requireNotExpired
} from "../../../src/internal/apple/certificate.ts"
import { makeTestChain, type TestChain } from "./testCerts.ts"

let chain: TestChain | undefined

afterEach(async () => {
  if (chain !== undefined) {
    await rm(chain.dir, { recursive: true, force: true })
    chain = undefined
  }
})

describe("certificate loading", () => {
  test("fromPkcs12 parses cert + key and reports notAfter", async () => {
    chain = await makeTestChain()
    const identity = await Effect.runPromise(fromPkcs12(chain.p12Bytes, Redacted.make(chain.p12Password)))
    expect(identity.certificate.subject.getField("CN")?.value).toBe("Test Pass Type")
    expect(identity.notAfter.getTime()).toBeGreaterThan(Date.now())
  })

  test("fromPkcs12 fails with CertificateError on wrong password", async () => {
    chain = await makeTestChain()
    const result = await Effect.runPromise(
      Effect.result(fromPkcs12(chain.p12Bytes, Redacted.make("wrong-password")))
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(CertificateError)
    }
  })

  test("fromPem parses cert + key and reports notAfter", async () => {
    chain = await makeTestChain()
    const identity = await Effect.runPromise(fromPem(chain.leafPem, chain.leafKeyPem))
    expect(identity.certificate.subject.getField("CN")?.value).toBe("Test Pass Type")
    expect(identity.notAfter.getTime()).toBeGreaterThan(Date.now())
  })

  test("fromPem fails with CertificateError on malformed PEM", async () => {
    const result = await Effect.runPromise(
      Effect.result(fromPem("not a pem", "also not a pem"))
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(CertificateError)
    }
  })

  test("fromPem decrypts an encrypted private key given the correct passphrase", async () => {
    chain = await makeTestChain()
    const identity = await Effect.runPromise(
      fromPem(chain.leafPem, chain.encryptedLeafKeyPem, Redacted.make(chain.encryptedLeafKeyPassword))
    )
    expect(identity.certificate.subject.getField("CN")?.value).toBe("Test Pass Type")
    expect(identity.notAfter.getTime()).toBeGreaterThan(Date.now())
  })

  test("fromPem fails with CertificateError (not the passphrase) on wrong passphrase", async () => {
    chain = await makeTestChain()
    const result = await Effect.runPromise(
      Effect.result(fromPem(chain.leafPem, chain.encryptedLeafKeyPem, Redacted.make("wrong-passphrase")))
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(CertificateError)
      const message = JSON.stringify(result.failure)
      expect(message).not.toContain(chain.encryptedLeafKeyPassword)
      expect(message).not.toContain("wrong-passphrase")
    }
  })

  test("fromPem fails with CertificateError mentioning encryption when passphrase is missing", async () => {
    chain = await makeTestChain()
    const result = await Effect.runPromise(
      Effect.result(fromPem(chain.leafPem, chain.encryptedLeafKeyPem))
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(CertificateError)
      expect((result.failure as CertificateError).reason).toContain("encrypted")
    }
  })

  test("fromPem ignores a passphrase supplied for an unencrypted key", async () => {
    chain = await makeTestChain()
    const identity = await Effect.runPromise(
      fromPem(chain.leafPem, chain.leafKeyPem, Redacted.make("unused-passphrase"))
    )
    expect(identity.certificate.subject.getField("CN")?.value).toBe("Test Pass Type")
  })

  test("requireNotExpired passes for a fresh cert and fails for an already-expired asOf", async () => {
    chain = await makeTestChain()
    const identity = await Effect.runPromise(fromPem(chain.leafPem, chain.leafKeyPem))

    const ok = await Effect.runPromise(requireNotExpired(identity))
    expect(ok).toBe(identity)

    const farFuture = new Date(identity.notAfter.getTime() + 1000)
    const result = await Effect.runPromise(Effect.result(requireNotExpired(identity, farFuture)))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(CertificateError)
    }
  })

  test("requireNotExpired sources its default 'now' from the Clock (TestClock)", async () => {
    chain = await makeTestChain()
    const identity = await Effect.runPromise(fromPem(chain.leafPem, chain.leafKeyPem))

    const program = Effect.gen(function*() {
      // Advance the (test) clock past the cert's expiry, then rely on
      // requireNotExpired's default `asOf` — sourced from the Clock, not
      // the wall clock — to observe the failure deterministically.
      yield* TestClock.setTime(identity.notAfter.getTime() + 1000)
      return yield* Effect.result(requireNotExpired(identity))
    }).pipe(Effect.provide(TestClock.layer()))

    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(CertificateError)
    }
  })

  test("CertificateConfig-like password does not leak via String()/JSON.stringify", () => {
    const password = Redacted.make("super-secret-password")
    expect(String(password)).not.toContain("super-secret-password")
    expect(JSON.stringify({ password })).not.toContain("super-secret-password")
  })
})
