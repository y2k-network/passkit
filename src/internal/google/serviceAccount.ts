/**
 * Schema and constructors for the Google Cloud service account JSON key
 * file used to sign "Save to Google Wallet" JWTs.
 *
 * @internal
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * Error raised when a service account key file fails to parse or decode.
 *
 * @internal
 */
export class ServiceAccountError extends Data.TaggedError("ServiceAccountError")<{
  readonly reason: "InvalidJson" | "InvalidShape"
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * The shape of a Google Cloud service account JSON key file, restricted to
 * the fields relevant to signing Wallet save JWTs.
 *
 * @internal
 */
export const ServiceAccount = Schema.Struct({
  type: Schema.Literal("service_account"),
  project_id: Schema.String,
  private_key_id: Schema.String,
  private_key: Schema.RedactedFromValue(Schema.String),
  client_email: Schema.String,
  client_id: Schema.optionalKey(Schema.String),
  auth_uri: Schema.optionalKey(Schema.String),
  token_uri: Schema.optionalKey(Schema.String),
  auth_provider_x509_cert_url: Schema.optionalKey(Schema.String),
  client_x509_cert_url: Schema.optionalKey(Schema.String),
  universe_domain: Schema.optionalKey(Schema.String)
})

/**
 * The decoded service account type.
 *
 * @internal
 */
export type ServiceAccount = typeof ServiceAccount.Type

const decodeUnknown = Schema.decodeUnknownEffect(ServiceAccount)

/**
 * Parse a service account from a JSON string or already-parsed object,
 * returning a tagged error on failure.
 *
 * @internal
 */
export const make = (
  input: string | unknown
): Effect.Effect<ServiceAccount, ServiceAccountError> => {
  const parsed: Effect.Effect<unknown, ServiceAccountError> = typeof input === "string"
    ? Effect.try({
      try: () => JSON.parse(input) as unknown,
      catch: (cause) =>
        new ServiceAccountError({
          reason: "InvalidJson",
          message: "Failed to parse service account JSON string",
          cause
        })
    })
    : Effect.succeed(input)

  return Effect.flatMap(parsed, (value) =>
    decodeUnknown(value).pipe(
      Effect.mapError(
        (cause) =>
          new ServiceAccountError({
            reason: "InvalidShape",
            message: "Service account JSON does not match the expected shape",
            cause
          })
      )
    ))
}
