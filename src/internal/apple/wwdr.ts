/**
 * Apple WWDR (Worldwide Developer Relations) intermediate certificate.
 *
 * NOTE: We deliberately do NOT embed Apple's real WWDR G4 certificate bytes
 * here. Verifying an exact, current, byte-correct copy of Apple's WWDR
 * intermediate offline (without fetching it from Apple or another trusted
 * source at build time) is not something this agent could do reliably, and
 * fabricating certificate bytes would be worse than not shipping any —a
 * wrong embedded cert would silently produce passes that fail to install.
 *
 * Apple also rotates/replaces WWDR intermediates periodically (G1..G4 and
 * beyond), so a hardcoded constant would eventually go stale anyway.
 *
 * Instead, this module defines the *shape* callers use to supply a WWDR
 * certificate (PEM string -> parsed forge certificate), which `sign.ts`
 * consumes. Downstream code (or the consuming application) should fetch the
 * current WWDR certificate from
 * https://www.apple.com/certificateauthority/ and pass its PEM bytes in,
 * or bundle it themselves after verifying its fingerprint.
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import forge from "node-forge"

/**
 * Failure parsing a supplied WWDR certificate PEM.
 */
export class WwdrCertificateError extends Data.TaggedError("WwdrCertificateError")<{
  readonly reason: string
  readonly cause?: unknown
}> {}

/**
 * Parses a caller-supplied PEM-encoded WWDR intermediate certificate.
 */
export const loadWwdrCertificate = (
  pem: string
): Effect.Effect<forge.pki.Certificate, WwdrCertificateError> =>
  Effect.try({
    try: () => forge.pki.certificateFromPem(pem),
    catch: (cause) =>
      new WwdrCertificateError({
        reason: `Failed to parse WWDR certificate PEM: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        cause
      })
  })
