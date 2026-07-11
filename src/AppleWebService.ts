/**
 * The Apple Wallet web-service protocol (DESIGN.md §7) as a mountable
 * `HttpApi` group: device registration, update polling, pass re-fetch, and
 * logging — the five endpoints Apple's spec requires of a pass web service.
 *
 * ```
 * POST   /v1/devices/{deviceLibraryIdentifier}/registrations/{passTypeIdentifier}/{serialNumber}
 * DELETE /v1/devices/{deviceLibraryIdentifier}/registrations/{passTypeIdentifier}/{serialNumber}
 * GET    /v1/devices/{deviceLibraryIdentifier}/registrations/{passTypeIdentifier}?passesUpdatedSince=...
 * GET    /v1/passes/{passTypeIdentifier}/{serialNumber}
 * POST   /v1/log
 * ```
 *
 * Mount it into your own `HttpApi`:
 *
 * ```ts
 * import { HttpApi } from "effect/unstable/httpapi"
 * import * as AppleWebService from "effect-passkit/AppleWebService"
 *
 * const Api = HttpApi.make("api").add(AppleWebService.group)
 *
 * const WebServiceLive = AppleWebService.layer(Api).pipe(
 *   Layer.provide(AppleWebService.PassProvider.layer(myPassProvider)),
 *   Layer.provide(Registry.layerMemory)
 * )
 * ```
 *
 * You implement `PassProvider` (how to authorize a request and render a
 * pass for a serial) and supply a `Registry` (device registration storage,
 * see `./Registry.ts`).
 */
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { HttpApi } from "effect/unstable/httpapi"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

import type * as Apple from "./Apple.ts"
import * as Registry from "./Registry.ts"

// --- Errors ---

/** Raised when `PassProvider.passFor` can't find a pass for the given identifiers. */
export class PassNotFoundError extends Data.TaggedError("ApplePassNotFoundError")<{
  readonly passTypeId: string
  readonly serial: string
}> {}

// --- PassProvider service ---

/**
 * The shape of the `PassProvider` service: the app-supplied bridge from the
 * Apple web-service protocol to your own pass data.
 */
export interface PassProviderShape {
  /**
   * Check whether `authToken` (the bearer value from the
   * `Authorization: ApplePass <authToken>` header) is the token this
   * (passTypeId, serial) pair was issued with. Return `false` (not a
   * failure) for a bad token — the endpoint turns that into 401.
   */
  readonly authorize: (
    args: { readonly passTypeId: string; readonly serial: string; readonly authToken: string }
  ) => Effect.Effect<boolean>

  /** Render the current `.pkpass` bytes for a (passTypeId, serial) pair. */
  readonly passFor: (
    args: { readonly passTypeId: string; readonly serial: string }
  ) => Effect.Effect<Apple.PkPass, PassNotFoundError>
}

/**
 * The `PassProvider` service: your application's authorization + pass
 * rendering logic, consumed by the `AppleWebService` handlers.
 */
export class PassProvider extends Context.Service<PassProvider, PassProviderShape>()(
  "effect-passkit/AppleWebService/PassProvider"
) {
  /** Build a `PassProvider` layer from an implementation. */
  static readonly layer = (shape: PassProviderShape): Layer.Layer<PassProvider> =>
    Layer.succeed(PassProvider, shape)
}

// --- Pusher service ---

/**
 * The shape of the `Pusher` service: sends the silent APNs push that tells a
 * device to re-poll the web service for updated serials. Real APNs delivery
 * (HTTP/2, token or cert auth, the `passTypeId` topic) is deferred to a
 * future phase — implement this interface against `node:http2` (or any APNs
 * client) and provide it in place of `layerNoop` to wire it up. `notify`
 * receives the device's push token; the payload for a pass update push is
 * always the empty JSON object `{}`.
 */
export interface PusherShape {
  readonly notify: (pushToken: string) => Effect.Effect<void>
}

/** The `Pusher` service: APNs (or a stand-in) for pass-update notifications. */
export class Pusher extends Context.Service<Pusher, PusherShape>()(
  "effect-passkit/AppleWebService/Pusher"
) {}

/** A `Pusher` that does nothing — the default until real APNs is wired up. */
export const layerNoop: Layer.Layer<Pusher> = Layer.succeed(Pusher, {
  notify: () => Effect.void
})

// --- updated helper ---

/**
 * Mark a serial as updated (so the next `passesUpdatedSince` poll picks it
 * up) and, if given push tokens for devices registered to it, fan out a
 * silent push via `Pusher`. Callers own looking up which push tokens are
 * registered for a serial (typically by keeping their own index, or —
 * for small deployments — by scanning their `Registry`'s storage directly);
 * `Registry`'s public shape is device-keyed, not serial-keyed, by design.
 */
export const updated = (
  serial: string,
  pushTokens?: ReadonlyArray<string>
): Effect.Effect<void, Registry.RegistryError, Registry.Registry | Pusher> =>
  Effect.gen(function*() {
    const registry = yield* Registry.Registry
    yield* registry.markUpdated(serial)

    if (pushTokens !== undefined && pushTokens.length > 0) {
      const pusher = yield* Pusher
      yield* Effect.forEach(pushTokens, (token) => pusher.notify(token), { discard: true })
    }
  })

// --- HttpApi group ---

const RegistrationParams = Schema.Struct({
  deviceLibraryIdentifier: Schema.String,
  passTypeIdentifier: Schema.String,
  serialNumber: Schema.String
})

const ListParams = Schema.Struct({
  deviceLibraryIdentifier: Schema.String,
  passTypeIdentifier: Schema.String
})

const ListQuery = Schema.Struct({
  passesUpdatedSince: Schema.optional(Schema.String)
})

const PassParams = Schema.Struct({
  passTypeIdentifier: Schema.String,
  serialNumber: Schema.String
})

const RegisterPayload = Schema.Struct({
  pushToken: Schema.String
})

const ListResponse = Schema.Struct({
  serialNumbers: Schema.Array(Schema.String),
  lastUpdated: Schema.String
})

const LogPayload = Schema.Struct({
  logs: Schema.Array(Schema.String)
})

/**
 * The Apple web-service `HttpApi` group. Add it to your own `HttpApi` and
 * implement it with `layer` (or `HttpApiBuilder.group` directly if you need
 * finer control).
 */
export const group = HttpApiGroup.make("AppleWebService")
  .add(
    HttpApiEndpoint.post("register", "/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber", {
      params: RegistrationParams,
      payload: RegisterPayload
    })
  )
  .add(
    HttpApiEndpoint.delete(
      "unregister",
      "/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber",
      { params: RegistrationParams }
    )
  )
  .add(
    HttpApiEndpoint.get("list", "/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier", {
      params: ListParams,
      query: ListQuery
    })
  )
  .add(
    HttpApiEndpoint.get("pass", "/v1/passes/:passTypeIdentifier/:serialNumber", {
      params: PassParams
    })
  )
  .add(
    HttpApiEndpoint.post("log", "/v1/log", {
      payload: LogPayload
    })
  )
  .prefix("/")

/**
 * A standalone `HttpApi` mounting just the `AppleWebService` group. Merge it
 * into your own API with `.addHttpApi(AppleWebService.Api)`, or add
 * `AppleWebService.group` directly to your own `HttpApi` and implement it
 * yourself with `HttpApiBuilder.group` (this module's `layer` is wired
 * against `Api` specifically, for type-checking simplicity).
 */
export const Api = HttpApi.make("AppleWebService").add(group)

const AUTH_PREFIX = "ApplePass "

const authTokenFrom = (authorization: string | undefined): Option.Option<string> =>
  authorization !== undefined && authorization.startsWith(AUTH_PREFIX)
    ? Option.some(authorization.slice(AUTH_PREFIX.length))
    : Option.none()

const appleWebServiceHandlers = HttpApiBuilder.group(Api, "AppleWebService", (handlers) =>
  (handlers as any)
    .handleRaw("register", ({ params, request }: any) =>
      Effect.gen(function*() {
        const authToken = Option.getOrUndefined(authTokenFrom(request.headers.authorization))
        if (authToken === undefined) {
          return HttpServerResponse.empty({ status: 401 })
        }
        const provider = yield* PassProvider
        const authorized = yield* provider.authorize({
          passTypeId: params.passTypeIdentifier,
          serial: params.serialNumber,
          authToken
        })
        if (!authorized) return HttpServerResponse.empty({ status: 401 })

        const body = yield* Effect.orElseSucceed(request.json, () => ({}))
        const decoded = yield* Schema.decodeUnknownEffect(RegisterPayload)(body).pipe(
          Effect.orElseSucceed(() => ({ pushToken: "" }))
        )

        const registry = yield* Registry.Registry
        yield* registry.register({
          deviceLibraryId: params.deviceLibraryIdentifier,
          pushToken: decoded.pushToken,
          passTypeId: params.passTypeIdentifier,
          serial: params.serialNumber
        })

        return HttpServerResponse.empty({ status: 201 })
      }))
    .handleRaw("unregister", ({ params, request }: any) =>
      Effect.gen(function*() {
        const authToken = Option.getOrUndefined(authTokenFrom(request.headers.authorization))
        if (authToken === undefined) {
          return HttpServerResponse.empty({ status: 401 })
        }
        const provider = yield* PassProvider
        const authorized = yield* provider.authorize({
          passTypeId: params.passTypeIdentifier,
          serial: params.serialNumber,
          authToken
        })
        if (!authorized) return HttpServerResponse.empty({ status: 401 })

        const registry = yield* Registry.Registry
        yield* registry.unregister({
          deviceLibraryId: params.deviceLibraryIdentifier,
          passTypeId: params.passTypeIdentifier,
          serial: params.serialNumber
        })

        return HttpServerResponse.empty({ status: 200 })
      }))
    .handleRaw("list", ({ params, query }: any) =>
      Effect.gen(function*() {
        const updatedSince = query.passesUpdatedSince === undefined
          ? undefined
          : Number(query.passesUpdatedSince)

        const registry = yield* Registry.Registry
        const result = yield* registry.serialsForDevice({
          deviceLibraryId: params.deviceLibraryIdentifier,
          passTypeId: params.passTypeIdentifier,
          updatedSince
        })

        if (result.serials.length === 0) {
          return HttpServerResponse.empty({ status: 204 })
        }

        return yield* HttpServerResponse.json({
          serialNumbers: result.serials,
          lastUpdated: String(result.lastUpdated ?? 0)
        })
      }))
    .handleRaw("pass", ({ params, request }: any) =>
      Effect.gen(function*() {
        const authToken = Option.getOrUndefined(authTokenFrom(request.headers.authorization))
        if (authToken === undefined) {
          return HttpServerResponse.empty({ status: 401 })
        }
        const provider = yield* PassProvider
        const authorized = yield* provider.authorize({
          passTypeId: params.passTypeIdentifier,
          serial: params.serialNumber,
          authToken
        })
        if (!authorized) return HttpServerResponse.empty({ status: 401 })

        const result = yield* Effect.result(
          provider.passFor({ passTypeId: params.passTypeIdentifier, serial: params.serialNumber })
        )
        if (result._tag === "Failure") {
          return HttpServerResponse.empty({ status: 404 })
        }

        return HttpServerResponse.uint8Array(result.success.bytes, {
          contentType: result.success.contentType
        })
      }))
    .handleRaw("log", ({ request }: any) =>
      Effect.gen(function*() {
        const body = yield* Effect.orElseSucceed(request.json, () => ({}))
        const decoded = yield* Schema.decodeUnknownEffect(LogPayload)(body).pipe(
          Effect.orElseSucceed(() => ({ logs: [] as ReadonlyArray<string> }))
        )
        yield* Effect.forEach(decoded.logs, (line) => Effect.log(line), { discard: true })
        return HttpServerResponse.empty({ status: 200 })
      }))) as unknown as Layer.Layer<
  HttpApiGroup.ApiGroup<"AppleWebService", "AppleWebService">,
  never,
  Registry.Registry | PassProvider
>

/**
 * Implements the `AppleWebService` group's endpoints against a `Registry`
 * and a `PassProvider`. Provide this alongside a `Registry` layer (and
 * optionally a `Pusher`) when assembling your server.
 */
export const layer = appleWebServiceHandlers
