import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as NodeCrypto from "node:crypto"

import * as Barcode from "../src/Barcode.ts"
import * as Field from "../src/Field.ts"
import * as Google from "../src/Google.ts"
import * as Pass from "../src/Pass.ts"
import * as Relevance from "../src/Relevance.ts"

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

const FAKE_ACCESS_TOKEN = "fake-access-token-xyz"

// --- verify the OAuth2 assertion JWT the token endpoint receives ---

const verifyAssertion = (assertion: string) => {
  const [headerSegment, claimsSegment, signatureSegment] = assertion.split(".") as [string, string, string]
  const claims = JSON.parse(Buffer.from(claimsSegment, "base64url").toString("utf8"))
  const verifier = NodeCrypto.createVerify("RSA-SHA256")
  verifier.update(`${headerSegment}.${claimsSegment}`)
  verifier.end()
  const verified = verifier.verify(publicKey, Buffer.from(signatureSegment, "base64url"))
  return { claims, verified }
}

// --- an in-memory fake of the token endpoint + Wallet Objects REST API ---

interface RequestLog {
  readonly method: string
  readonly path: string
  readonly authorization: string | null
  readonly body: unknown
}

let store: Map<string, Record<string, unknown>>
let requests: Array<RequestLog>
let lastAssertion: string | undefined
let server: ReturnType<typeof Bun.serve>
let baseUrl: string
let tokenUrl: string

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      const method = req.method

      if (url.pathname === "/token") {
        const text = await req.text()
        const params = new URLSearchParams(text)
        lastAssertion = params.get("assertion") ?? undefined
        return Response.json({ access_token: FAKE_ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600 })
      }

      const authorization = req.headers.get("authorization")
      const body = method === "GET" ? undefined : await req.json()
      requests.push({ method, path: url.pathname, authorization, body })

      // /walletobjects/v1/<type>/<id> or /walletobjects/v1/<type> for POST
      const segments = url.pathname.split("/").filter((s) => s.length > 0)
      const resourceType = segments[2]!
      const id = segments[3]

      if (method === "GET") {
        const existing = store.get(`${resourceType}/${id}`)
        if (existing === undefined) {
          return new Response(JSON.stringify({ error: { code: 404, message: "not found" } }), { status: 404 })
        }
        return Response.json(existing)
      }

      if (method === "POST") {
        const payload = body as Record<string, unknown>
        const insertedId = payload.id as string
        store.set(`${resourceType}/${insertedId}`, payload)
        return Response.json(payload)
      }

      if (method === "PATCH") {
        const existing = store.get(`${resourceType}/${id}`) ?? {}
        const merged = { ...existing, ...(body as Record<string, unknown>) }
        store.set(`${resourceType}/${id}`, merged)
        return Response.json(merged)
      }

      return new Response("not found", { status: 404 })
    }
  })
  baseUrl = `http://localhost:${server.port}/walletobjects/v1`
  tokenUrl = `http://localhost:${server.port}/token`
})

afterAll(() => {
  server.stop(true)
})

// `baseUrl`/`tokenUrl` are only known once `beforeAll` starts the fake
// server, so build the layer lazily via `Layer.effect` rather than
// `Layer.succeed`, which would eagerly capture the pre-`beforeAll` values.
const issuerLayer = Layer.effect(
  Google.Issuer,
  Effect.sync(() => ({
    issuerId: "3388000000012345678",
    serviceAccount,
    restBaseUrl: baseUrl,
    tokenUrl: tokenUrl
  }))
)

const eventTicket = () =>
  Pass.eventTicket({ serial: Pass.Serial("evt-sync-1"), description: "Concert Ticket" }).pipe(
    Pass.header(
      Field.date({ key: "doors", label: "DOORS", value: DateTime.makeUnsafe("2026-08-01T19:00:00Z"), date: "medium", time: "short" })
    ),
    Pass.barcode(Barcode.Qr({ content: "ticket-payload", altText: "TICKET-1" }))
  )

describe("Google.sync", () => {
  test("inserts on first sync, patches on second", async () => {
    store = new Map()
    requests = []
    lastAssertion = undefined

    const run = (pass: Pass.Pass) =>
      Effect.runPromise(
        Google.sync(pass, {}).pipe(
          Effect.provide(issuerLayer),
          Effect.provide(Google.AssetHost.layerNoop)
        )
      )

    const first = await run(eventTicket())

    expect(first.classId).toBe("3388000000012345678.evt")
    expect(first.objectId).toBe("3388000000012345678.evt-sync-1")

    // OAuth assertion JWT must verify against the test keypair.
    expect(lastAssertion).toBeDefined()
    const { claims, verified } = verifyAssertion(lastAssertion!)
    expect(verified).toBe(true)
    expect(claims.iss).toBe(serviceAccount.client_email)
    expect(claims.aud).toBe(tokenUrl)
    expect(claims.scope).toBe("https://www.googleapis.com/auth/wallet_object.issuer")
    expect(typeof claims.iat).toBe("number")
    expect(claims.exp).toBe(claims.iat + 3600)

    // First sync: GET (404) then POST for class, and GET (404) then POST for object.
    const methodsFirst = requests.map((r) => `${r.method} ${r.path}`)
    expect(methodsFirst).toEqual([
      "GET /walletobjects/v1/eventTicketClass/3388000000012345678.evt",
      "POST /walletobjects/v1/eventTicketClass",
      "GET /walletobjects/v1/eventTicketObject/3388000000012345678.evt-sync-1",
      "POST /walletobjects/v1/eventTicketObject"
    ])

    for (const r of requests) {
      expect(r.authorization).toBe(`Bearer ${FAKE_ACCESS_TOKEN}`)
    }

    const insertedClassBody = requests[1]!.body as Record<string, unknown>
    expect(insertedClassBody.id).toBe("3388000000012345678.evt")
    const insertedObjectBody = requests[3]!.body as Record<string, unknown>
    expect(insertedObjectBody.id).toBe("3388000000012345678.evt-sync-1")
    expect(insertedObjectBody.classId).toBe("3388000000012345678.evt")

    // Second sync: both resources now exist, so GET (200) then PATCH.
    requests = []
    const second = await run(eventTicket())

    expect(second).toEqual(first)

    const methodsSecond = requests.map((r) => `${r.method} ${r.path}`)
    expect(methodsSecond).toEqual([
      "GET /walletobjects/v1/eventTicketClass/3388000000012345678.evt",
      "PATCH /walletobjects/v1/eventTicketClass/3388000000012345678.evt",
      "GET /walletobjects/v1/eventTicketObject/3388000000012345678.evt-sync-1",
      "PATCH /walletobjects/v1/eventTicketObject/3388000000012345678.evt-sync-1"
    ])
  })

  test("onUnsupported: \"error\" fails sync when the pass has google findings", async () => {
    store = new Map()
    requests = []

    const passWithBeacon = eventTicket().pipe(
      Pass.relevant(Relevance.beacon({ proximityUUID: "12345678-1234-1234-1234-123456789012", major: 1, minor: 2 }))
    )

    const exit = await Effect.runPromiseExit(
      Google.sync(passWithBeacon, { onUnsupported: "error" }).pipe(
        Effect.provide(issuerLayer),
        Effect.provide(Google.AssetHost.layerNoop)
      )
    )

    expect(exit._tag).toBe("Failure")
    // No REST calls should have been made once fidelity enforcement fails.
    expect(requests.length).toBe(0)
  })
})
