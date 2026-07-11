/**
 * Minimal RS256 JWT signing for Google Wallet "Save to Google Wallet"
 * links, using node:crypto against a PKCS#8 PEM private key.
 *
 * @internal
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as NodeCrypto from "node:crypto"

import type { ServiceAccount } from "./serviceAccount.js"

/**
 * Error raised when JWT signing fails.
 *
 * @internal
 */
export class JwtError extends Data.TaggedError("JwtError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const base64url = (input: Buffer | string): string => {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input
  return buf.toString("base64url")
}

/**
 * Sign an arbitrary set of JWT claims with the service account's private
 * key using RS256, producing a compact JWS string.
 *
 * @internal
 */
export const signJwt = (
  serviceAccount: ServiceAccount,
  claims: Record<string, unknown>
): Effect.Effect<string, JwtError> =>
  Effect.try({
    try: () => {
      const header = {
        alg: "RS256",
        typ: "JWT",
        kid: serviceAccount.private_key_id
      }

      const headerSegment = base64url(JSON.stringify(header))
      const claimsSegment = base64url(JSON.stringify(claims))
      const signingInput = `${headerSegment}.${claimsSegment}`

      const signer = NodeCrypto.createSign("RSA-SHA256")
      signer.update(signingInput)
      signer.end()

      const signature = signer.sign(Redacted.value(serviceAccount.private_key))
      const signatureSegment = base64url(signature)

      return `${signingInput}.${signatureSegment}`
    },
    catch: (cause) =>
      new JwtError({
        message: "Failed to sign JWT with the service account private key",
        cause
      })
  })
