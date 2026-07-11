/**
 * Minimal REST client for the Google Wallet Objects API plus the OAuth2
 * service-account JWT-bearer token grant, built directly on `fetch` +
 * `Effect.tryPromise`.
 *
 * `dist/unstable/http`'s `HttpClient` was considered, but adding it to the
 * `R` of `Google.sync` would force every caller to provide
 * `FetchHttpClient.layer` even though the base URL/token URL already need
 * to be injectable for tests — a plain `fetch` wrapped in `Effect` keeps
 * `sync`'s requirements at `Issuer | AssetHost`, matching `saveLink`.
 *
 * @internal
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"

import * as Jwt from "./jwt.js"
import type { ServiceAccount } from "./serviceAccount.js"

/** @internal */
export const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token"

/** @internal */
export const DEFAULT_BASE_URL = "https://walletobjects.googleapis.com/walletobjects/v1"

/** @internal */
export const DEFAULT_SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer"

/**
 * Error raised when the OAuth2 access-token exchange fails.
 *
 * @internal
 */
export class TokenError extends Data.TaggedError("GoogleTokenError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Error raised when a Wallet Objects API request fails (any non-2xx status
 * other than the 404 used to detect "needs insert").
 *
 * @internal
 */
export class ApiError extends Data.TaggedError("GoogleApiError")<{
  readonly status: number
  readonly body: unknown
  readonly message: string
}> {}

/** Options overriding the default endpoints — always injectable for tests. */
export interface RestOptions {
  readonly baseUrl?: string
  readonly tokenUrl?: string
  readonly scope?: string
}

/**
 * Build the OAuth2 JWT-bearer token-request claims for a service account,
 * scoped to the Wallet Objects API by default.
 *
 * @internal
 */
export const buildTokenClaims = (
  serviceAccount: ServiceAccount,
  options?: RestOptions,
  now: () => Date = () => new Date()
): Record<string, unknown> => {
  const iat = Math.floor(now().getTime() / 1000)
  return {
    iss: serviceAccount.client_email,
    scope: options?.scope ?? DEFAULT_SCOPE,
    aud: options?.tokenUrl ?? DEFAULT_TOKEN_URL,
    iat,
    exp: iat + 3600
  }
}

const parseJsonBody = (res: Response): Effect.Effect<unknown, never> =>
  Effect.tryPromise(() => res.json()).pipe(Effect.orElseSucceed(() => undefined))

/**
 * Exchange the service account's signed JWT assertion for an OAuth2 access
 * token via the `urn:ietf:params:oauth:grant-type:jwt-bearer` grant.
 *
 * @internal
 */
export const getAccessToken = (
  serviceAccount: ServiceAccount,
  options?: RestOptions
): Effect.Effect<string, TokenError | Jwt.JwtError> =>
  Effect.gen(function*() {
    const claims = buildTokenClaims(serviceAccount, options)
    const assertion = yield* Jwt.signJwt(serviceAccount, claims)
    const tokenUrl = options?.tokenUrl ?? DEFAULT_TOKEN_URL

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })

    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString()
        }),
      catch: (cause) => new TokenError({ message: `Failed to reach token endpoint ${tokenUrl}`, cause })
    })

    const json = yield* parseJsonBody(res)

    if (!res.ok) {
      return yield* Effect.fail(
        new TokenError({
          message: `Token endpoint ${tokenUrl} returned ${res.status}`,
          cause: json
        })
      )
    }

    const accessToken = (json as { access_token?: unknown } | undefined)?.access_token
    if (typeof accessToken !== "string") {
      return yield* Effect.fail(
        new TokenError({ message: "Token endpoint response did not include an access_token", cause: json })
      )
    }

    return accessToken
  })

const resourceUrl = (baseUrl: string, resourceType: string, id: string): string =>
  `${baseUrl}/${resourceType}/${encodeURIComponent(id)}`

/**
 * `GET` a resource by id, returning `undefined` when the API reports 404
 * (the "needs insert" signal) and failing with `ApiError` for any other
 * non-2xx status.
 *
 * @internal
 */
export const get = (
  resourceType: string,
  id: string,
  accessToken: string,
  options?: RestOptions
): Effect.Effect<Record<string, unknown> | undefined, ApiError> =>
  Effect.gen(function*() {
    const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(resourceUrl(baseUrl, resourceType, id), {
          method: "GET",
          headers: { authorization: `Bearer ${accessToken}` }
        }),
      catch: (cause) =>
        new ApiError({ status: 0, body: undefined, message: `Failed to reach ${baseUrl} for GET ${resourceType}/${id}: ${cause}` })
    })

    if (res.status === 404) return undefined

    const json = yield* parseJsonBody(res)

    if (!res.ok) {
      return yield* Effect.fail(
        new ApiError({ status: res.status, body: json, message: `GET ${resourceType}/${id} returned ${res.status}` })
      )
    }

    return json as Record<string, unknown>
  })

const write = (
  method: "POST" | "PATCH",
  resourceType: string,
  id: string,
  payload: Record<string, unknown>,
  accessToken: string,
  options?: RestOptions
): Effect.Effect<Record<string, unknown>, ApiError> =>
  Effect.gen(function*() {
    const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL
    const url = method === "POST" ? `${baseUrl}/${resourceType}` : resourceUrl(baseUrl, resourceType, id)

    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(payload)
        }),
      catch: (cause) =>
        new ApiError({ status: 0, body: undefined, message: `Failed to reach ${baseUrl} for ${method} ${resourceType}/${id}: ${cause}` })
    })

    const json = yield* parseJsonBody(res)

    if (!res.ok) {
      return yield* Effect.fail(
        new ApiError({ status: res.status, body: json, message: `${method} ${resourceType}/${id} returned ${res.status}` })
      )
    }

    return (json ?? payload) as Record<string, unknown>
  })

/**
 * `POST` a new resource (insert).
 *
 * @internal
 */
export const insert = (
  resourceType: string,
  id: string,
  payload: Record<string, unknown>,
  accessToken: string,
  options?: RestOptions
): Effect.Effect<Record<string, unknown>, ApiError> => write("POST", resourceType, id, payload, accessToken, options)

/**
 * `PATCH` an existing resource.
 *
 * @internal
 */
export const patch = (
  resourceType: string,
  id: string,
  payload: Record<string, unknown>,
  accessToken: string,
  options?: RestOptions
): Effect.Effect<Record<string, unknown>, ApiError> => write("PATCH", resourceType, id, payload, accessToken, options)

/**
 * Upsert a resource: `GET` to check existence, then `insert` on 404 or
 * `patch` otherwise.
 *
 * @internal
 */
export const upsert = (
  resourceType: string,
  id: string,
  payload: Record<string, unknown>,
  accessToken: string,
  options?: RestOptions
): Effect.Effect<Record<string, unknown>, ApiError> =>
  Effect.flatMap(
    get(resourceType, id, accessToken, options),
    (existing) =>
      existing === undefined
        ? insert(resourceType, id, payload, accessToken, options)
        : patch(resourceType, id, payload, accessToken, options)
  )
