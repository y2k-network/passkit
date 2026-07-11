import { afterEach, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServer from "effect/unstable/http/HttpServer"

import * as AppleWebService from "../src/AppleWebService.ts"
import * as Registry from "../src/Registry.ts"

const PASS_BYTES = new Uint8Array([1, 2, 3, 4, 5])
const AUTH_TOKEN = "secret-token"
const PASS_TYPE_ID = "pass.com.acme.tickets"
const SERIAL = "TICKET-001"

const stubProvider: AppleWebService.PassProviderShape = {
  authorize: ({ authToken }) => Effect.succeed(authToken === AUTH_TOKEN),
  passFor: ({ passTypeId, serial }) =>
    passTypeId === PASS_TYPE_ID && serial === SERIAL
      ? Effect.succeed({ bytes: PASS_BYTES, contentType: "application/vnd.apple.pkpass" as const })
      : Effect.fail(new AppleWebService.PassNotFoundError({ passTypeId, serial }))
}

let server: ReturnType<typeof Bun.serve> | undefined

const startServer = async () => {
  const { dispose, handler } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(AppleWebService.Api).pipe(
      Layer.provide(AppleWebService.layer),
      Layer.provide(AppleWebService.PassProvider.layer(stubProvider)),
      Layer.provide(Registry.layerMemory),
      Layer.provide(HttpServer.layerServices)
    )
  )

  server = Bun.serve({ port: 0, fetch: (request) => handler(request) })
  return { dispose, baseUrl: `http://localhost:${server.port}` }
}

afterEach(() => {
  if (server !== undefined) {
    server.stop(true)
    server = undefined
  }
})

describe("AppleWebService", () => {
  test("full register -> list -> fetch pass -> unregister flow", async () => {
    const { baseUrl, dispose } = await startServer()
    try {
      const registerRes = await fetch(
        `${baseUrl}/v1/devices/DEVICE-1/registrations/${PASS_TYPE_ID}/${SERIAL}`,
        {
          method: "POST",
          headers: { authorization: `ApplePass ${AUTH_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ pushToken: "push-token-1" })
        }
      )
      expect(registerRes.status).toBe(201)

      const listRes = await fetch(
        `${baseUrl}/v1/devices/DEVICE-1/registrations/${PASS_TYPE_ID}`,
        { headers: { authorization: `ApplePass ${AUTH_TOKEN}` } }
      )
      expect(listRes.status).toBe(200)
      const listBody = await listRes.json() as { serialNumbers: Array<string>; lastUpdated: string }
      expect(listBody.serialNumbers).toEqual([SERIAL])

      const passRes = await fetch(
        `${baseUrl}/v1/passes/${PASS_TYPE_ID}/${SERIAL}`,
        { headers: { authorization: `ApplePass ${AUTH_TOKEN}` } }
      )
      expect(passRes.status).toBe(200)
      expect(passRes.headers.get("content-type")).toBe("application/vnd.apple.pkpass")
      const passBytes = new Uint8Array(await passRes.arrayBuffer())
      expect(passBytes).toEqual(PASS_BYTES)

      const unregisterRes = await fetch(
        `${baseUrl}/v1/devices/DEVICE-1/registrations/${PASS_TYPE_ID}/${SERIAL}`,
        { method: "DELETE", headers: { authorization: `ApplePass ${AUTH_TOKEN}` } }
      )
      expect(unregisterRes.status).toBe(200)

      const listAfterRes = await fetch(
        `${baseUrl}/v1/devices/DEVICE-1/registrations/${PASS_TYPE_ID}`,
        { headers: { authorization: `ApplePass ${AUTH_TOKEN}` } }
      )
      expect(listAfterRes.status).toBe(204)
    } finally {
      await dispose()
    }
  })

  test("rejects a bad auth token with 401", async () => {
    const { baseUrl, dispose } = await startServer()
    try {
      const res = await fetch(
        `${baseUrl}/v1/passes/${PASS_TYPE_ID}/${SERIAL}`,
        { headers: { authorization: "ApplePass wrong-token" } }
      )
      expect(res.status).toBe(401)
    } finally {
      await dispose()
    }
  })

  test("returns 401 when the Authorization header is missing entirely", async () => {
    const { baseUrl, dispose } = await startServer()
    try {
      const res = await fetch(`${baseUrl}/v1/passes/${PASS_TYPE_ID}/${SERIAL}`)
      expect(res.status).toBe(401)
    } finally {
      await dispose()
    }
  })

  test("204s on an empty list", async () => {
    const { baseUrl, dispose } = await startServer()
    try {
      const res = await fetch(
        `${baseUrl}/v1/devices/UNKNOWN-DEVICE/registrations/${PASS_TYPE_ID}`,
        { headers: { authorization: `ApplePass ${AUTH_TOKEN}` } }
      )
      expect(res.status).toBe(204)
    } finally {
      await dispose()
    }
  })

  test("filters the list by passesUpdatedSince", async () => {
    const { baseUrl, dispose } = await startServer()
    try {
      await fetch(
        `${baseUrl}/v1/devices/DEVICE-2/registrations/${PASS_TYPE_ID}/${SERIAL}`,
        {
          method: "POST",
          headers: { authorization: `ApplePass ${AUTH_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ pushToken: "push-token-2" })
        }
      )

      const firstListRes = await fetch(
        `${baseUrl}/v1/devices/DEVICE-2/registrations/${PASS_TYPE_ID}`,
        { headers: { authorization: `ApplePass ${AUTH_TOKEN}` } }
      )
      const firstList = await firstListRes.json() as { serialNumbers: Array<string>; lastUpdated: string }
      expect(firstList.serialNumbers).toEqual([SERIAL])

      // Filtering by a tag equal to (or after) the serial's own updatedAt excludes it.
      const filteredRes = await fetch(
        `${baseUrl}/v1/devices/DEVICE-2/registrations/${PASS_TYPE_ID}?passesUpdatedSince=${firstList.lastUpdated}`,
        { headers: { authorization: `ApplePass ${AUTH_TOKEN}` } }
      )
      expect(filteredRes.status).toBe(204)
    } finally {
      await dispose()
    }
  })

  test("POST /v1/log accepts device logs", async () => {
    const { baseUrl, dispose } = await startServer()
    try {
      const res = await fetch(`${baseUrl}/v1/log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ logs: ["device says hi"] })
      })
      expect(res.status).toBe(200)
    } finally {
      await dispose()
    }
  })
})

describe("Registry.layerMemory", () => {
  test("register/unregister/serialsForDevice/markUpdated round-trip", async () => {
    const program = Effect.gen(function*() {
      const registry = yield* Registry.Registry
      yield* registry.register({
        deviceLibraryId: "D",
        pushToken: "T",
        passTypeId: PASS_TYPE_ID,
        serial: SERIAL
      })
      const before = yield* registry.serialsForDevice({ deviceLibraryId: "D", passTypeId: PASS_TYPE_ID })
      yield* registry.markUpdated(SERIAL)
      const after = yield* registry.serialsForDevice({
        deviceLibraryId: "D",
        passTypeId: PASS_TYPE_ID,
        updatedSince: before.lastUpdated
      })
      yield* registry.unregister({ deviceLibraryId: "D", passTypeId: PASS_TYPE_ID, serial: SERIAL })
      const afterUnregister = yield* registry.serialsForDevice({ deviceLibraryId: "D", passTypeId: PASS_TYPE_ID })
      return { before, after, afterUnregister }
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(Registry.layerMemory)))
    expect(result.before.serials).toEqual([SERIAL])
    expect(result.afterUnregister.serials).toEqual([])
  })
})
