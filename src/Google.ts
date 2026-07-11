/**
 * The Google Wallet compile target (DESIGN.md §5.2): a service for issuer
 * identity, a service for hosting binary assets, and `saveLink` — the pure
 * `Pass` IR compiled to a signed "Save to Google Wallet" JWT.
 */
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import * as Asset from "./Asset.ts"
import * as Fidelity from "./Fidelity.ts"
import * as compile from "./internal/google/compile.ts"
import * as Jwt from "./internal/google/jwt.ts"
import * as Rest from "./internal/google/rest.ts"
import * as SaveLinkInternal from "./internal/google/saveLink.ts"
import * as ServiceAccountInternal from "./internal/google/serviceAccount.ts"
import * as Pass from "./Pass.ts"

// --- Errors ---

/**
 * Raised when an `Asset.File` or `Asset.Bytes` needs to be uploaded to a
 * hosted URL but no working `AssetHost` was provided (DESIGN.md §3.4).
 */
export class MissingAssetHostError extends Data.TaggedError("GoogleMissingAssetHostError")<{
  readonly role: Pass.AssetRole
  readonly density: "1x" | "2x" | "3x"
  readonly message: string
}> {}

/** Raised when uploading an asset through `AssetHost.upload` fails. */
export class AssetUploadError extends Data.TaggedError("GoogleAssetUploadError")<{
  readonly role: Pass.AssetRole
  readonly density: "1x" | "2x" | "3x"
  readonly cause?: unknown
  readonly message: string
}> {}

/** The union of errors `Google.saveLink` can fail with. */
export type IssueError =
  | Pass.ValidationError
  | MissingAssetHostError
  | AssetUploadError
  | Jwt.JwtError
  | ServiceAccountInternal.ServiceAccountError
  | Fidelity.UnsupportedError

/** The union of errors `Google.sync` can fail with. */
export type SyncError = IssueError | Rest.TokenError | Rest.ApiError

// --- ServiceAccount ---

/** The Google Cloud service account key shape used to sign save JWTs. */
export type ServiceAccount = ServiceAccountInternal.ServiceAccount
export const ServiceAccountError = ServiceAccountInternal.ServiceAccountError

// --- Issuer service ---

/** The identity a pass is issued under: the Wallet issuer id and the signing service account. */
export interface IssuerShape {
  readonly issuerId: string
  readonly serviceAccount: ServiceAccount
  /** Override the Wallet Objects API base URL — for tests, or non-default universes. */
  readonly restBaseUrl?: string
  /** Override the OAuth2 token endpoint — for tests. */
  readonly tokenUrl?: string
}

/**
 * The `Issuer` service: your Google Wallet issuer id plus the service
 * account credentials used to sign save JWTs. Build one with `Google.layer`.
 */
export class Issuer extends Context.Service<Issuer, IssuerShape>()(
  "effect-passkit/Google/Issuer"
) {}

// --- AssetHost service ---

/**
 * A capability for turning `Asset.File`/`Asset.Bytes` payloads into hosted
 * URLs Google Wallet can fetch (DESIGN.md §3.4). Provide a layer backed by
 * R2/S3/GCS/your CDN; if all your assets are already `Asset.Url`, this
 * service's `upload` is never called.
 */
export interface AssetHostShape {
  readonly upload: (
    bytes: Uint8Array,
    hint: { readonly role: Pass.AssetRole; readonly density: "1x" | "2x" | "3x" }
  ) => Effect.Effect<string, unknown>
}

/** The `AssetHost` service. See `AssetHostShape` and `AssetHost.layerNoop`. */
export class AssetHost extends Context.Service<AssetHost, AssetHostShape>()(
  "effect-passkit/Google/AssetHost"
) {
  /**
   * A layer that fails every upload with `MissingAssetHostError`, naming the
   * asset. Use this as the default when your passes only ever carry
   * `Asset.Url` assets — any `File`/`Bytes` asset then surfaces a clear,
   * typed compile error instead of silently doing nothing.
   */
  static readonly layerNoop: Layer.Layer<AssetHost> = Layer.succeed(AssetHost, {
    upload: (_bytes, hint) =>
      Effect.fail(
        new MissingAssetHostError({
          role: hint.role,
          density: hint.density,
          message:
            `Asset for role "${hint.role}" (${hint.density}) needs an AssetHost to upload to a URL, ` +
            `but AssetHost.layerNoop is in effect. Provide a real AssetHost layer, or use Asset.url(...) instead.`
        })
      )
  })
}

// --- layer ---

/** Configuration for `Google.layer`: the issuer id and service account credentials. */
export interface LayerConfig {
  readonly issuerId: string
  readonly serviceAccount: { readonly json: string }
  /** Override the Wallet Objects API base URL — for tests, or non-default universes. */
  readonly restBaseUrl?: string
  /** Override the OAuth2 token endpoint — for tests. */
  readonly tokenUrl?: string
}

/**
 * Build the `Issuer` service from a Google Wallet issuer id and a service
 * account JSON key (as a string — read the file yourself, e.g. with
 * `Bun.file(path).text()`, before calling this).
 */
export const layer = (config: LayerConfig): Layer.Layer<Issuer, ServiceAccountInternal.ServiceAccountError> =>
  Layer.effect(
    Issuer,
    Effect.map(
      ServiceAccountInternal.make(config.serviceAccount.json),
      (serviceAccount): IssuerShape => ({
        issuerId: config.issuerId,
        serviceAccount,
        restBaseUrl: config.restBaseUrl,
        tokenUrl: config.tokenUrl
      })
    )
  )

// --- SaveLink ---

/** The result of compiling a pass to a "Save to Google Wallet" link. */
export interface SaveLink {
  readonly url: string
  readonly jwt: string
}

/** Options for `Google.saveLink`. */
export interface SaveLinkOptions {
  readonly origins?: ReadonlyArray<string>
  readonly classSuffix?: string
  /**
   * Policy applied to `Fidelity.audit(pass).google` findings before
   * compiling. Defaults to `"warn"` — the findings are logged, not
   * enforced, unless you opt into `"error"`.
   */
  readonly onUnsupported?: Fidelity.OnUnsupported
}

const resolveAsset = (
  asset: Asset.Asset,
  role: Pass.AssetRole,
  density: "1x" | "2x" | "3x"
): Effect.Effect<string, MissingAssetHostError | AssetUploadError, AssetHost> => {
  if (Asset.isUrl(asset)) return Effect.succeed(asset.url)

  return Effect.flatMap(AssetHost, (host) => {
    const bytesEffect: Effect.Effect<Uint8Array, MissingAssetHostError> = Asset.isBytes(asset)
      ? Effect.succeed(asset.bytes)
      : Effect.fail(
        new MissingAssetHostError({
          role,
          density,
          message: `Asset.File assets cannot be read without a filesystem step; resolve to bytes before calling Google.saveLink.`
        })
      )

    return Effect.flatMap(bytesEffect, (bytes) =>
      host.upload(bytes, { role, density }).pipe(
        Effect.mapError(
          (cause) =>
            new AssetUploadError({
              role,
              density,
              cause,
              message: `AssetHost.upload failed for role "${role}" (${density})`
            })
        )
      ))
  })
}

const setPath = (obj: Record<string, unknown>, path: ReadonlyArray<string>, value: unknown): void => {
  let cursor: Record<string, unknown> = obj
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!
    const next = cursor[key]
    if (typeof next !== "object" || next === null) {
      cursor[key] = {}
    }
    cursor = cursor[key] as Record<string, unknown>
  }
  cursor[path[path.length - 1]!] = value
}

const hostUnhosted = (
  compiled: compile.Compiled
): Effect.Effect<compile.Compiled, MissingAssetHostError | AssetUploadError, AssetHost> =>
  Effect.gen(function*() {
    let acc = compiled
    for (const u of compiled.unhosted) {
      const url = yield* resolveAsset(u.asset, u.role, u.density)
      const cls = { ...acc.class } as Record<string, unknown>
      setPath(cls, [u.targetField], { sourceUri: { uri: url } })
      acc = { ...acc, class: cls }
    }
    return acc
  })

/**
 * Compile a `Pass` to a signed "Save to Google Wallet" link (DESIGN.md
 * §5.2). Validates the pass, compiles it to a Google Wallet class/object
 * pair, resolves any non-`Url` assets through `AssetHost`, and embeds both
 * in a skinny signed JWT.
 *
 * `AssetHost` is always required in `R` — even for passes with no
 * non-`Url` assets — because Google Wallet's asset requirement isn't a
 * function of the pass's *type*, only its *data*, and v4's service
 * resolution has no clean way to make a requirement conditional on runtime
 * values. Provide `AssetHost.layerNoop` when you know all your assets are
 * `Asset.Url`; it fails loudly, with the offending asset named, the moment
 * that assumption is wrong.
 */
export const saveLink = (
  pass: Pass.Pass,
  options?: SaveLinkOptions
): Effect.Effect<SaveLink, IssueError, Issuer | AssetHost> =>
  Effect.gen(function*() {
    const validated = yield* Pass.validate(pass)
    yield* Fidelity.enforce(Fidelity.audit(validated).google, options?.onUnsupported ?? "warn")
    const issuer = yield* Issuer

    const compiled = compile.compile(validated, { issuerId: issuer.issuerId, classSuffix: options?.classSuffix })
    const hosted = yield* hostUnhosted(compiled)

    const payload = {
      [hosted.classField]: [hosted.class],
      [hosted.objectField]: [hosted.object]
    }

    const claims = SaveLinkInternal.buildSaveJwtClaims(issuer.serviceAccount, payload, { origins: options?.origins })
    const jwt = yield* Jwt.signJwt(issuer.serviceAccount, claims as unknown as Record<string, unknown>)

    return { url: SaveLinkInternal.saveUrl(jwt), jwt }
  })

// --- Sync ---

/** The result of `Google.sync`: the class and object ids the pass was upserted under. */
export interface SyncResult {
  readonly classId: string
  readonly objectId: string
}

/** Options for `Google.sync`. */
export interface SyncOptions {
  readonly classSuffix?: string
  /**
   * Policy applied to `Fidelity.audit(pass).google` findings before
   * compiling. Defaults to `"warn"`.
   */
  readonly onUnsupported?: Fidelity.OnUnsupported
}

/**
 * Compile a `Pass` to a Google Wallet class/object pair and upsert both
 * through the Wallet Objects REST API (DESIGN.md §5.2), for passes that
 * must live server-side and be pushed updates later — as opposed to
 * `saveLink`, which embeds the class/object in the save JWT itself.
 *
 * Each of the class and the object is fetched first (`GET`); a 404 inserts
 * (`POST`), anything else patches (`PATCH`).
 */
export const sync = (
  pass: Pass.Pass,
  options?: SyncOptions
): Effect.Effect<SyncResult, SyncError, Issuer | AssetHost> =>
  Effect.gen(function*() {
    const validated = yield* Pass.validate(pass)
    yield* Fidelity.enforce(Fidelity.audit(validated).google, options?.onUnsupported ?? "warn")
    const issuer = yield* Issuer

    const compiled = compile.compile(validated, { issuerId: issuer.issuerId, classSuffix: options?.classSuffix })
    const hosted = yield* hostUnhosted(compiled)
    const { classType, objectType } = compile.typesFor(pass._tag)

    const restOptions: Rest.RestOptions = { baseUrl: issuer.restBaseUrl, tokenUrl: issuer.tokenUrl }
    const accessToken = yield* Rest.getAccessToken(issuer.serviceAccount, restOptions)

    yield* Rest.upsert(classType, hosted.classId, hosted.class, accessToken, restOptions)
    yield* Rest.upsert(objectType, hosted.objectId, hosted.object, accessToken, restOptions)

    return { classId: hosted.classId, objectId: hosted.objectId }
  })
