import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as NodeCrypto from "node:crypto"

import * as ServiceAccount from "../../../src/internal/google/serviceAccount.js"

const { privateKey } = NodeCrypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
})

const fabricate = () => ({
  type: "service_account",
  project_id: "test-project",
  private_key_id: "abc123",
  private_key: privateKey,
  client_email: "test@test-project.iam.gserviceaccount.com",
  client_id: "12345",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/test",
  universe_domain: "googleapis.com"
})

describe("ServiceAccount", () => {
  test("decodes a valid JSON string", async () => {
    const json = JSON.stringify(fabricate())
    const result = await Effect.runPromise(ServiceAccount.make(json))
    expect(result.client_email).toBe("test@test-project.iam.gserviceaccount.com")
    expect(result.private_key_id).toBe("abc123")
    expect(result.type).toBe("service_account")
  })

  test("decodes a valid object", async () => {
    const result = await Effect.runPromise(ServiceAccount.make(fabricate()))
    expect(result.project_id).toBe("test-project")
  })

  test("rejects invalid JSON string", async () => {
    const exit = await Effect.runPromiseExit(ServiceAccount.make("not json{"))
    expect(exit._tag).toBe("Failure")
  })

  test("rejects malformed shape (wrong type literal)", async () => {
    const bad = { ...fabricate(), type: "not_a_service_account" }
    const exit = await Effect.runPromiseExit(ServiceAccount.make(bad))
    expect(exit._tag).toBe("Failure")
  })

  test("rejects missing required field", async () => {
    const bad = fabricate() as Record<string, unknown>
    delete bad["private_key"]
    const exit = await Effect.runPromiseExit(ServiceAccount.make(bad))
    expect(exit._tag).toBe("Failure")
  })

  test("failure is a ServiceAccountError", async () => {
    const exit = await Effect.runPromiseExit(ServiceAccount.make("not json{"))
    if (exit._tag === "Failure") {
      const failure = exit.cause
      expect(JSON.stringify(failure)).toContain("ServiceAccountError")
    } else {
      throw new Error("expected failure")
    }
  })

  test("private_key does not leak via String()/JSON.stringify of a decoded ServiceAccount", async () => {
    const result = await Effect.runPromise(ServiceAccount.make(fabricate()))
    expect(String(result.private_key)).not.toContain(privateKey)
    expect(JSON.stringify(result)).not.toContain(privateKey)
    // sanity: the raw PEM does contain recognizable substrings that would
    // show up if redaction were broken (e.g. the PEM header).
    expect(privateKey).toContain("PRIVATE KEY")
  })
})
