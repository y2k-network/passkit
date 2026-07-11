/**
 * Loading Apple Pass Type ID signing identities.
 *
 * Supports two input shapes:
 *  - a PKCS#12 (.p12) archive + password (the form Apple's developer portal
 *    exports), or
 *  - a PEM certificate + PEM private key pair.
 *
 * Both resolve to a `SigningIdentity` carrying the parsed forge certificate,
 * private key, and the certificate's `notAfter` expiry so callers can fail
 * fast on an expired Pass Type ID certificate before attempting a sign.
 */
import * as Clock from "effect/Clock"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import forge from "node-forge"

/**
 * Failure loading or parsing a signing identity: bad password, malformed
 * PKCS#12/PEM, missing cert/key bag, etc.
 */
export class CertificateError extends Data.TaggedError("CertificateError")<{
  readonly reason: string
  readonly cause?: unknown
}> {}

/**
 * A parsed Apple Pass Type ID signing identity: the leaf certificate, its
 * private key, and the certificate's expiry.
 */
export interface SigningIdentity {
  readonly certificate: forge.pki.Certificate
  readonly privateKey: forge.pki.PrivateKey
  readonly notAfter: Date
}

const bytesToForgeBuffer = (bytes: Uint8Array): forge.util.ByteStringBuffer =>
  forge.util.createBuffer(Buffer.from(bytes).toString("binary"))

/**
 * Loads a signing identity from a PKCS#12 (.p12) archive and its password.
 * This is the format exported by Apple's developer portal / Keychain Access
 * when you export a Pass Type ID certificate together with its private key.
 */
export const fromPkcs12 = (
  p12Bytes: Uint8Array,
  password: Redacted.Redacted<string>
): Effect.Effect<SigningIdentity, CertificateError> =>
  Effect.try({
    try: () => {
      const asn1 = forge.asn1.fromDer(bytesToForgeBuffer(p12Bytes))
      const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, Redacted.value(password))

      let certificate: forge.pki.Certificate | undefined
      let privateKey: forge.pki.PrivateKey | undefined
      for (const safeContent of p12.safeContents) {
        for (const bag of safeContent.safeBags) {
          if (certificate === undefined && bag.cert !== undefined) {
            certificate = bag.cert
          }
          if (privateKey === undefined && bag.key !== undefined) {
            privateKey = bag.key
          }
        }
      }
      if (certificate === undefined) {
        throw new Error("PKCS#12 archive did not contain a certificate")
      }
      if (privateKey === undefined) {
        throw new Error("PKCS#12 archive did not contain a private key")
      }

      return {
        certificate,
        privateKey,
        notAfter: certificate.validity.notAfter
      }
    },
    catch: (cause) =>
      new CertificateError({
        reason: `Failed to parse PKCS#12 signing identity: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        cause
      })
  })

/**
 * Loads a signing identity from a PEM-encoded certificate and a PEM-encoded
 * private key. The key may be unencrypted, or encrypted — either the legacy
 * "RSA PRIVATE KEY" form with a `Proc-Type: 4,ENCRYPTED` header, or the
 * PKCS#8 "ENCRYPTED PRIVATE KEY" form Apple/Keychain exports produce — in
 * which case `passphrase` is required to decrypt it. `passphrase` is
 * ignored (not an error) when the key isn't encrypted.
 */
export const fromPem = (
  certificatePem: string,
  privateKeyPem: string,
  passphrase?: Redacted.Redacted<string>
): Effect.Effect<SigningIdentity, CertificateError> =>
  Effect.try({
    try: () => {
      const certificate = forge.pki.certificateFromPem(certificatePem)

      const keyMessage = forge.pem.decode(privateKeyPem)[0]
      if (keyMessage === undefined) {
        throw new Error("Could not parse private key PEM")
      }
      const isEncrypted = keyMessage.type === "ENCRYPTED PRIVATE KEY" ||
        keyMessage.procType?.type === "ENCRYPTED"

      let privateKey: forge.pki.PrivateKey
      if (isEncrypted) {
        if (passphrase === undefined) {
          throw new Error(
            "Private key is encrypted (PKCS#8 \"ENCRYPTED PRIVATE KEY\" or legacy encrypted PEM) but no passphrase was provided"
          )
        }
        // Returns the decrypted key on success, `null` on a wrong
        // passphrase or corrupt key (does not throw for that case).
        const decrypted = forge.pki.decryptRsaPrivateKey(privateKeyPem, Redacted.value(passphrase))
        if (decrypted === null) {
          throw new Error("Failed to decrypt private key: wrong passphrase or corrupt key")
        }
        privateKey = decrypted
      } else {
        privateKey = forge.pki.privateKeyFromPem(privateKeyPem)
      }

      return {
        certificate,
        privateKey,
        notAfter: certificate.validity.notAfter
      }
    },
    catch: (cause) =>
      new CertificateError({
        reason: `Failed to parse PEM signing identity: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        cause
      })
  })

/**
 * Fails with a `CertificateError` if the identity's certificate has already
 * expired (or expires before `asOf`, which defaults to now). Lets callers
 * fail fast rather than discover an expired Pass Type ID certificate only
 * after Apple rejects the pass.
 */
export const requireNotExpired = (
  identity: SigningIdentity,
  asOf?: Date
): Effect.Effect<SigningIdentity, CertificateError> =>
  Effect.gen(function*() {
    const asOfMillis = asOf !== undefined ? asOf.getTime() : yield* Clock.currentTimeMillis
    if (identity.notAfter.getTime() < asOfMillis) {
      return yield* Effect.fail(
        new CertificateError({
          reason: `Signing certificate expired on ${identity.notAfter.toISOString()}`
        })
      )
    }
    return identity
  })
