/**
 * The two-for-one facade across both compile targets (DESIGN.md §5.3).
 * `Wallet.issue` is sugar, not magic — it's exactly `Effect.all` of
 * `Apple.pkpass` and `Google.saveLink`, concurrently, nothing hidden.
 */
import * as Effect from "effect/Effect"

import * as Apple from "./Apple.ts"
import * as Fidelity from "./Fidelity.ts"
import * as Google from "./Google.ts"
import * as Pass from "./Pass.ts"

/** Both artifacts produced by issuing one `Pass` to both targets. */
export interface Offer {
  readonly apple: Apple.PkPass
  readonly google: Google.SaveLink
}

/** Options for `Wallet.issue`. */
export interface IssueOptions {
  /**
   * Policy for cross-compilation lossiness on both targets (DESIGN.md §6).
   * Defaults to `"warn"`. Applies uniformly to `apple` and `google`; call
   * `Apple.pkpass`/`Google.saveLink` directly for per-target policies.
   */
  readonly onUnsupported?: Fidelity.OnUnsupported
  readonly google?: {
    readonly origins?: ReadonlyArray<string>
    readonly classSuffix?: string
  }
  readonly apple?: {
    readonly webService?: {
      readonly url: string
      readonly authToken: string
    }
  }
}

/**
 * Issue a `Pass` to both Apple and Google Wallet, concurrently. This is
 * exactly `Effect.all({ apple: Apple.pkpass(pass, ...), google: ... },
 * { concurrency: "unbounded" })` — no additional behavior, no third target,
 * no hidden retries.
 *
 * `Google.saveLink` accepts its own `onUnsupported` option directly, so the
 * uniform policy given here is passed straight through to both
 * `Apple.pkpass` and `Google.saveLink` — no separate enforcement step.
 */
export const issue = (
  pass: Pass.Pass,
  options?: IssueOptions
): Effect.Effect<
  Offer,
  Apple.PkpassError | Google.IssueError,
  Apple.Signer | Google.Issuer | Google.AssetHost
> => {
  const policy = options?.onUnsupported ?? "warn"

  const appleEffect = Apple.pkpass(pass, {
    webService: options?.apple?.webService,
    onUnsupported: policy
  })

  const googleEffect = Google.saveLink(pass, {
    origins: options?.google?.origins,
    classSuffix: options?.google?.classSuffix,
    onUnsupported: policy
  })

  return Effect.all({ apple: appleEffect, google: googleEffect }, { concurrency: "unbounded" })
}
