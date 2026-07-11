/**
 * Detached CMS/PKCS#7 signing of an Apple pass manifest.
 *
 * Produces a DER-encoded detached `SignedData` over `manifest.json`, signed
 * with the Pass Type ID certificate's private key, with the signer
 * certificate and the Apple WWDR intermediate certificate included in the
 * `certificates` set, and a `signingTime` authenticated attribute — the
 * shape `passd` (the OS pass validator) expects.
 *
 * Uses SHA-256 as the message digest algorithm, which is what modern
 * (post-2017-ish) passes use; Apple's tooling has accepted SHA-256 message
 * digests in the pass signature for years now.
 */
import * as Clock from "effect/Clock"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import forge from "node-forge"
import type { SigningIdentity } from "./certificate.ts"

/**
 * Failure while building or serializing the CMS signature.
 */
export class SigningError extends Data.TaggedError("SigningError")<{
  readonly reason: string
  readonly cause?: unknown
}> {}

const bytesToBinaryString = (bytes: Uint8Array): string => Buffer.from(bytes).toString("binary")

/**
 * Signs `manifestBytes` (the raw bytes of manifest.json) producing a
 * DER-encoded detached CMS SignedData, ready to be written as the pass
 * bundle's `signature` file. The `signingTime` authenticated attribute is
 * sourced from the ambient `Clock` rather than the wall clock directly.
 */
export const signManifest = (
  identity: SigningIdentity,
  wwdrCertificate: forge.pki.Certificate,
  manifestBytes: Uint8Array
): Effect.Effect<Uint8Array, SigningError> =>
  Effect.gen(function*() {
    const nowMillis = yield* Clock.currentTimeMillis
    return yield* Effect.try({
      try: () => {
        const p7 = forge.pkcs7.createSignedData()
        p7.content = forge.util.createBuffer(bytesToBinaryString(manifestBytes))
        p7.addCertificate(identity.certificate)
        p7.addCertificate(wwdrCertificate)
        const oidSha256 = forge.pki.oids.sha256!
        const oidContentType = forge.pki.oids.contentType!
        const oidData = forge.pki.oids.data!
        const oidMessageDigest = forge.pki.oids.messageDigest!
        const oidSigningTime = forge.pki.oids.signingTime!

        p7.addSigner({
          key: identity.privateKey as forge.pki.rsa.PrivateKey,
          certificate: identity.certificate,
          digestAlgorithm: oidSha256,
          authenticatedAttributes: [
            { type: oidContentType, value: oidData },
            { type: oidMessageDigest },
            // node-forge accepts a Date for the signingTime attribute at
            // runtime (it encodes it as UTCTime/GeneralizedTime), even
            // though its bundled type declarations only admit `string`.
            { type: oidSigningTime, value: new Date(nowMillis) as unknown as string }
          ]
        })
        p7.sign({ detached: true })
        const der = forge.asn1.toDer(p7.toAsn1()).getBytes()
        const out = new Uint8Array(der.length)
        for (let i = 0; i < der.length; i++) {
          out[i] = der.charCodeAt(i) & 0xff
        }
        return out
      },
      catch: (cause) =>
        new SigningError({
          reason: `Failed to sign manifest: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause
        })
    })
  })
