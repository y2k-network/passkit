/**
 * The Apple Wallet compile target (DESIGN.md §5.1): a `Signer` service
 * carrying the Pass Type ID signing identity + WWDR intermediate, and
 * `pkpass` — the pure `Pass` IR compiled to a signed `.pkpass` bundle.
 */
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import type forge from "node-forge"

import * as Asset from "./Asset.ts"
import * as Fidelity from "./Fidelity.ts"
import * as CertificateInternal from "./internal/apple/certificate.ts"
import * as compile from "./internal/apple/compile.ts"
import * as ManifestInternal from "./internal/apple/manifest.ts"
import * as SignInternal from "./internal/apple/sign.ts"
import * as WwdrInternal from "./internal/apple/wwdr.ts"
import * as ZipInternal from "./internal/apple/zip.ts"
import * as Pass from "./Pass.ts"

// --- Errors ---

/** Re-exported: failure loading/parsing a Pass Type ID signing identity. */
export const CertificateError = CertificateInternal.CertificateError
export type CertificateError = CertificateInternal.CertificateError

/** Re-exported: failure parsing a supplied WWDR intermediate certificate PEM. */
export const WwdrCertificateError = WwdrInternal.WwdrCertificateError
export type WwdrCertificateError = WwdrInternal.WwdrCertificateError

/** Re-exported: failure building/serializing the detached CMS signature. */
export const SigningError = SignInternal.SigningError
export type SigningError = SignInternal.SigningError

/**
 * Raised when the signing identity's certificate has already expired.
 * Checked eagerly at `Apple.layer` construction — a deploy with an expired
 * cert fails loudly at startup, not silently at a user's add-to-wallet tap.
 */
export class CertificateExpiredError extends Data.TaggedError("AppleCertificateExpiredError")<{
  readonly notAfter: Date
  readonly message: string
}> {}

/** Raised when an `Asset` (file/url) needed for the pkpass bundle can't be resolved to bytes. */
export class AssetResolveError extends Data.TaggedError("AppleAssetResolveError")<{
  readonly role: Pass.AssetRole
  readonly density: "1x" | "2x" | "3x"
  readonly cause?: unknown
  readonly message: string
}> {}

/** The union of errors `Apple.pkpass` can fail with. */
export type PkpassError =
  | Pass.ValidationError
  | AssetResolveError
  | SigningError
  | Fidelity.UnsupportedError

// --- Signer service ---

/** The shape of the `Signer` service: the signing identity, WWDR intermediate, and identifiers. */
export interface SignerShape {
  readonly identity: CertificateInternal.SigningIdentity
  readonly wwdr: forge.pki.Certificate
  readonly teamId: string
  readonly passTypeId: string
}

/**
 * The `Signer` service: your Pass Type ID signing identity, Apple's WWDR
 * intermediate certificate, and the Team ID / Pass Type ID that identify the
 * pass. Build one with `Apple.layer` (real signing) or `Apple.layerUnsigned`
 * (structural, unsigned bundles for tests/CI).
 */
export class Signer extends Context.Service<Signer, SignerShape>()(
  "effect-passkit/Apple/Signer"
) {}

// --- layer ---

/** A PKCS#12 (.p12) archive plus its password — the form Apple's developer portal exports. */
export interface Pkcs12CertificateConfig {
  readonly _tag: "Pkcs12"
  readonly bytes: Uint8Array
  readonly password: Redacted.Redacted<string>
}

/**
 * A PEM-encoded certificate + PEM-encoded private key pair. `passphrase` is
 * required when `key` is an encrypted private key (either the legacy
 * "RSA PRIVATE KEY" form or the PKCS#8 "ENCRYPTED PRIVATE KEY" form
 * Apple/Keychain exports produce) — omit it for an unencrypted key.
 */
export interface PemCertificateConfig {
  readonly _tag: "Pem"
  readonly cert: string
  readonly key: string
  readonly passphrase?: Redacted.Redacted<string>
}

export type CertificateConfig = Pkcs12CertificateConfig | PemCertificateConfig

/** Constructors for `Apple.layer`'s `certificate` option. */
export const Certificate = {
  /** Load the signing identity from a PKCS#12 (.p12) archive and its password. */
  pkcs12: (
    args: { readonly bytes: Uint8Array; readonly password: string | Redacted.Redacted<string> }
  ): CertificateConfig => ({
    _tag: "Pkcs12",
    bytes: args.bytes,
    password: Redacted.isRedacted(args.password) ? args.password : Redacted.make(args.password)
  }),
  /**
   * Load the signing identity from a PEM certificate and a PEM private key.
   * Pass `passphrase` when `key` is encrypted (e.g. the "ENCRYPTED PRIVATE
   * KEY" form Apple/Keychain exports produce) — omit it for an unencrypted
   * key.
   */
  pem: (
    args: { readonly cert: string; readonly key: string; readonly passphrase?: string | Redacted.Redacted<string> }
  ): CertificateConfig => ({
    _tag: "Pem",
    cert: args.cert,
    key: args.key,
    passphrase: args.passphrase === undefined
      ? undefined
      : Redacted.isRedacted(args.passphrase) ? args.passphrase : Redacted.make(args.passphrase)
  })
}

/**
 * Configuration for `Apple.layer`.
 *
 * NOTE: `wwdr` (Apple's WWDR intermediate certificate, PEM-encoded) is
 * **required**. Phase 1 deliberately does not embed Apple's real WWDR
 * certificate bytes in this library — verifying an exact, current,
 * byte-correct copy offline isn't something that can be done reliably here,
 * and a wrong embedded cert would silently produce passes that fail to
 * install. Apple also rotates WWDR intermediates (G1..G4 and beyond)
 * periodically, so a hardcoded constant would eventually go stale anyway.
 * Fetch the current WWDR certificate from
 * https://www.apple.com/certificateauthority/ and pass its PEM bytes here
 * (or bundle it in your own application after verifying its fingerprint).
 */
export interface LayerConfig {
  readonly teamId: string
  readonly passTypeId: string
  readonly certificate: CertificateConfig
  readonly wwdr: string
}

const loadIdentity = (
  certificate: CertificateConfig
): Effect.Effect<CertificateInternal.SigningIdentity, CertificateError> =>
  certificate._tag === "Pkcs12"
    ? CertificateInternal.fromPkcs12(certificate.bytes, certificate.password)
    : CertificateInternal.fromPem(certificate.cert, certificate.key, certificate.passphrase)

/**
 * Build the `Signer` service from a Pass Type ID signing certificate and
 * Apple's WWDR intermediate. Fails the layer (not a later `pkpass` call) if
 * the signing certificate has already expired.
 */
export const layer = (
  config: LayerConfig
): Layer.Layer<Signer, CertificateError | WwdrCertificateError | CertificateExpiredError> =>
  Layer.effect(
    Signer,
    Effect.gen(function*() {
      const identity = yield* loadIdentity(config.certificate)
      const wwdr = yield* WwdrInternal.loadWwdrCertificate(config.wwdr)

      const nowMillis = yield* Clock.currentTimeMillis
      if (identity.notAfter.getTime() < nowMillis) {
        return yield* Effect.fail(
          new CertificateExpiredError({
            notAfter: identity.notAfter,
            message: `Signing certificate expired on ${identity.notAfter.toISOString()}`
          })
        )
      }

      return { identity, wwdr, teamId: config.teamId, passTypeId: config.passTypeId }
    })
  )

/**
 * A `Signer` layer for tests/CI (DESIGN.md §10): produces a structurally
 * complete but **unsigned** bundle. The `signature` file is empty bytes.
 * Never use this in production — no wallet installs a pass with an invalid
 * signature.
 */
export const layerUnsigned: Layer.Layer<Signer> = Layer.succeed(Signer, {
  identity: undefined as unknown as CertificateInternal.SigningIdentity,
  wwdr: undefined as unknown as forge.pki.Certificate,
  teamId: "unsigned",
  passTypeId: "pass.unsigned"
})

/** @deprecated use `layerUnsigned` */
export const layerNoop = layerUnsigned

// --- pkpass ---

/** The finished .pkpass artifact. */
export interface PkPass {
  readonly bytes: Uint8Array
  readonly contentType: "application/vnd.apple.pkpass"
}

/** Options for `Apple.pkpass`. */
export interface PkpassOptions {
  readonly webService?: {
    readonly url: string
    readonly authToken: string
  }
  /**
   * Policy for cross-compilation lossiness found by `Fidelity.audit` on the
   * Apple target (DESIGN.md §6). Defaults to `"warn"` (log each finding via
   * `Effect.logWarning`, still compile).
   */
  readonly onUnsupported?: Fidelity.OnUnsupported
}

const DENSITIES = ["1x", "2x", "3x"] as const

const roleFileBase: Record<Pass.AssetRole, string> = {
  icon: "icon",
  logo: "logo",
  strip: "strip",
  hero: "strip",
  thumbnail: "thumbnail"
}

const resolveAssetBytes = (
  asset: Asset.Asset,
  role: Pass.AssetRole,
  density: "1x" | "2x" | "3x"
): Effect.Effect<Uint8Array, AssetResolveError> =>
  Asset.$match(asset, {
    Bytes: (a) => Effect.succeed(a.bytes),
    File: (a) =>
      Effect.tryPromise({
        try: async () => new Uint8Array(await Bun.file(a.path).arrayBuffer()),
        catch: (cause) =>
          new AssetResolveError({
            role,
            density,
            cause,
            message: `Failed to read asset file "${a.path}" for role "${role}" (${density})`
          })
      }),
    Url: (a) =>
      Effect.tryPromise({
        try: async () => {
          const res = await fetch(a.url)
          if (!res.ok) {
            throw new Error(`Fetching asset "${a.url}" failed with status ${res.status}`)
          }
          return new Uint8Array(await res.arrayBuffer())
        },
        catch: (cause) =>
          new AssetResolveError({
            role,
            density,
            cause,
            message: `Failed to fetch asset "${a.url}" for role "${role}" (${density})`
          })
      })
  })

const resolveAssets = (
  assets: Pass.Assets
): Effect.Effect<ReadonlyMap<string, Uint8Array>, AssetResolveError> =>
  Effect.gen(function*() {
    const files = new Map<string, Uint8Array>()

    for (const role of Object.keys(assets) as Array<Pass.AssetRole>) {
      // `hero` maps onto strip.png when there's no dedicated strip asset;
      // if both are present, a real `strip` role wins.
      if (role === "hero" && assets.strip !== undefined) continue

      const set = assets[role]
      if (set === undefined) continue

      for (const density of DENSITIES) {
        const asset = set[density]
        if (asset === undefined) continue

        const bytes = yield* resolveAssetBytes(asset, role, density)
        const base = roleFileBase[role]
        const suffix = density === "1x" ? "" : `@${density}`
        files.set(`${base}${suffix}.png`, bytes)
      }
    }

    return files
  })

/**
 * Compile a `Pass` to a signed `.pkpass` bundle (DESIGN.md §5.1). Validates
 * the pass, resolves its assets to bytes, compiles pass.json, builds the
 * SHA-1 manifest, signs it with the `Signer`'s identity (detached CMS over
 * WWDR + leaf), and zips the result.
 */
export const pkpass = (
  pass: Pass.Pass,
  options?: PkpassOptions
): Effect.Effect<PkPass, PkpassError, Signer> =>
  Effect.gen(function*() {
    const validated = yield* Pass.validate(pass)
    yield* Fidelity.enforce(Fidelity.audit(validated).apple, options?.onUnsupported ?? "warn")
    const signer = yield* Signer

    const passJson = compile.toPassJson(validated, {
      teamId: signer.teamId,
      passTypeId: signer.passTypeId,
      webService: options?.webService
    })

    const files = new Map<string, Uint8Array>(yield* resolveAssets(validated.assets))
    files.set("pass.json", new TextEncoder().encode(JSON.stringify(passJson)))

    const manifestBytes = ManifestInternal.makeManifest(files)

    const signature = signer.identity === undefined
      ? new Uint8Array(0)
      : yield* SignInternal.signManifest(signer.identity, signer.wwdr, manifestBytes)

    const bundle = new Map(files)
    bundle.set("manifest.json", manifestBytes)
    bundle.set("signature", signature)

    const bytes = ZipInternal.makeZip(bundle)

    return { bytes, contentType: "application/vnd.apple.pkpass" as const }
  })
