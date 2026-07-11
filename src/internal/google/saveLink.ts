/**
 * Assembly of "Save to Google Wallet" JWT claims and the resulting save
 * URL. Payload objects are kept loosely typed here — the Pass IR ->
 * Google object compiler lands in a later phase.
 *
 * @internal
 */
import type { ServiceAccount } from "./serviceAccount.js"

/**
 * The known Google Wallet payload keys, each holding an array of the
 * corresponding class or object JSON representations.
 *
 * @internal
 */
export interface SaveJwtPayload {
  readonly genericClasses?: ReadonlyArray<unknown>
  readonly genericObjects?: ReadonlyArray<unknown>
  readonly eventTicketClasses?: ReadonlyArray<unknown>
  readonly eventTicketObjects?: ReadonlyArray<unknown>
  readonly offerClasses?: ReadonlyArray<unknown>
  readonly offerObjects?: ReadonlyArray<unknown>
  readonly loyaltyClasses?: ReadonlyArray<unknown>
  readonly loyaltyObjects?: ReadonlyArray<unknown>
  readonly transitClasses?: ReadonlyArray<unknown>
  readonly transitObjects?: ReadonlyArray<unknown>
  readonly giftCardClasses?: ReadonlyArray<unknown>
  readonly giftCardObjects?: ReadonlyArray<unknown>
}

/**
 * Options for building save JWT claims.
 *
 * @internal
 */
export interface SaveJwtOptions {
  readonly origins?: ReadonlyArray<string>
  readonly now?: () => Date
}

/**
 * The claim set for a "Save to Google Wallet" JWT.
 *
 * @internal
 */
export interface SaveJwtClaims {
  readonly iss: string
  readonly aud: "google"
  readonly typ: "savetowallet"
  readonly iat: number
  readonly origins?: ReadonlyArray<string>
  readonly payload: SaveJwtPayload
}

/**
 * Assemble the claim set for a "Save to Google Wallet" JWT from a service
 * account and a payload of class/object arrays.
 *
 * @internal
 */
export const buildSaveJwtClaims = (
  serviceAccount: ServiceAccount,
  payload: SaveJwtPayload,
  options?: SaveJwtOptions
): SaveJwtClaims => {
  const now = options?.now ?? (() => new Date())
  const claims: SaveJwtClaims = {
    iss: serviceAccount.client_email,
    aud: "google",
    typ: "savetowallet",
    iat: Math.floor(now().getTime() / 1000),
    payload,
    ...(options?.origins !== undefined ? { origins: options.origins } : {})
  }
  return claims
}

/**
 * The "Save to Google Wallet" URL for a signed JWT.
 *
 * @internal
 */
export const saveUrl = (jwt: string): string => `https://pay.google.com/gp/v/save/${jwt}`
