/**
 * Lossiness as data, not vibes (DESIGN.md §6). Cross-compilation from the
 * neutral IR to Apple/Google is lossy; this module makes that loss visible,
 * auditable, and — per call site — enforceable.
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type * as Pass from "./Pass.ts"
import * as Relevance from "./Relevance.ts"

// --- Finding ---

export type Target = "apple" | "google"

export type Finding = Data.TaggedEnum<{
  readonly Dropped: {
    readonly target: Target
    readonly path: string
    readonly feature: string
    readonly reason: string
  }
  readonly Approximated: {
    readonly target: Target
    readonly path: string
    readonly feature: string
    readonly reason: string
    readonly approximation: string
  }
  readonly Resized: {
    readonly target: Target
    readonly path: string
    readonly feature: string
    readonly reason: string
  }
}>

const factory = Data.taggedEnum<Finding>()

/** A feature silently dropped, with no replacement on the target. */
export const dropped = (
  args: { readonly target: Target; readonly path: string; readonly feature: string; readonly reason: string }
): Finding => factory.Dropped(args)

/** A feature mapped onto something else on the target — lossy but present. */
export const approximated = (
  args: {
    readonly target: Target
    readonly path: string
    readonly feature: string
    readonly reason: string
    readonly approximation: string
  }
): Finding => factory.Approximated(args)

/** A feature whose size/shape was altered to fit the target's constraints. */
export const resized = (
  args: { readonly target: Target; readonly path: string; readonly feature: string; readonly reason: string }
): Finding => factory.Resized(args)

export const isDropped = factory.$is("Dropped")
export const isApproximated = factory.$is("Approximated")
export const isResized = factory.$is("Resized")
export const $match = factory.$match

// --- Report ---

export interface Report {
  readonly apple: ReadonlyArray<Finding>
  readonly google: ReadonlyArray<Finding>
}

// --- Rules ---
//
// Each rule inspects the pass and produces zero or more findings for one
// target. `audit` runs the full rule set and partitions the results.

type Rule = (pass: Pass.Pass) => ReadonlyArray<Finding>

/** Google has no beacon relevance concept — iBeacon regions are Apple-only. */
const googleBeaconDropped: Rule = (pass) =>
  pass.relevance
    .map((r, i) => [r, i] as const)
    .filter(([r]) => Relevance.isBeacon(r))
    .map(([, i]) =>
      dropped({
        target: "google",
        path: `relevance[${i}]`,
        feature: "Beacon relevance",
        reason: "Google Wallet has no iBeacon-region relevance equivalent"
      })
    )

const slotNames = ["header", "primary", "secondary", "auxiliary", "back"] as const

/**
 * Field `changeMessage` becomes a push-notification string on Google, not a
 * per-field update template the way it does on Apple.
 */
const googleChangeMessageApproximated: Rule = (pass) => {
  const findings: Array<Finding> = []
  for (const slotName of slotNames) {
    pass.slots[slotName].forEach((field, i) => {
      if (field.changeMessage !== undefined) {
        findings.push(
          approximated({
            target: "google",
            path: `slots.${slotName}[${i}].changeMessage`,
            feature: "Field changeMessage",
            reason: "Google Wallet has no per-field update template",
            approximation: "rendered as a generic push-notification message"
          })
        )
      }
    })
  }
  return findings
}

/**
 * The strip asset maps onto Google's single hero image slot — but only when
 * `hero` itself is absent; `hero` takes priority over `strip` when both are
 * set, matching what `internal/google/compile.ts` actually does.
 */
const googleStripApproximated: Rule = (pass) =>
  pass.assets.strip === undefined || pass.assets.hero !== undefined
    ? []
    : [
      approximated({
        target: "google",
        path: "assets.strip",
        feature: "Strip asset",
        reason: "Google Wallet has a single hero image, not a distinct strip",
        approximation: "mapped to hero image"
      })
    ]

/** When both `hero` and `strip` are set, `hero` wins Google's single hero
 * image slot and `strip` is dropped outright (not even approximated). */
const googleStripDroppedWhenHeroPresent: Rule = (pass) =>
  pass.assets.strip !== undefined && pass.assets.hero !== undefined
    ? [
      dropped({
        target: "google",
        path: "assets.strip",
        feature: "Strip asset",
        reason: "Google Wallet has one hero-image slot and hero is also set; hero wins"
      })
    ]
    : []

/** Google Wallet has no icon or thumbnail image field on any pass kind. */
const googleIconThumbnailDropped: Rule = (pass) => {
  const findings: Array<Finding> = []
  for (const role of ["icon", "thumbnail"] as const) {
    if (pass.assets[role] !== undefined) {
      findings.push(
        dropped({
          target: "google",
          path: `assets.${role}`,
          feature: `${role[0]!.toUpperCase()}${role.slice(1)} asset`,
          reason: `Google Wallet has no ${role} image field`
        })
      )
    }
  }
  return findings
}

/** Google takes exactly one image per role; @2x/@3x density variants are dropped. */
const googleDensityVariantsDropped: Rule = (pass) => {
  const findings: Array<Finding> = []
  for (const role of Object.keys(pass.assets) as Array<Pass.AssetRole>) {
    // icon/thumbnail have no Google field at all (googleIconThumbnailDropped
    // already reports the whole role as dropped); don't double-report their
    // density variants too.
    if (role === "icon" || role === "thumbnail") continue
    const set = pass.assets[role]
    if (set === undefined) continue
    for (const density of ["2x", "3x"] as const) {
      if (set[density] !== undefined) {
        findings.push(
          dropped({
            target: "google",
            path: `assets.${role}.${density}`,
            feature: `${density} density variant`,
            reason: "Google Wallet takes a single image per role"
          })
        )
      }
    }
  }
  return findings
}

/** Google has no label-color concept — only background/foreground. */
const googleLabelColorDropped: Rule = (pass) =>
  pass.colors?.label === undefined
    ? []
    : [
      dropped({
        target: "google",
        path: "colors.label",
        feature: "Label color",
        reason: "Google Wallet has no labelColor equivalent"
      })
    ]

/** Apple has a single strip/background image slot; when both strip and hero
 * are set, strip wins and hero is dropped. */
const appleHeroDroppedWhenStripPresent: Rule = (pass) =>
  pass.assets.strip !== undefined && pass.assets.hero !== undefined
    ? [
      dropped({
        target: "apple",
        path: "assets.hero",
        feature: "Hero asset",
        reason: "Apple Wallet has one strip/background image slot and strip is also set; strip wins"
      })
    ]
    : []

const googleRules: ReadonlyArray<Rule> = [
  googleBeaconDropped,
  googleChangeMessageApproximated,
  googleStripApproximated,
  googleStripDroppedWhenHeroPresent,
  googleIconThumbnailDropped,
  googleDensityVariantsDropped,
  googleLabelColorDropped
]

const appleRules: ReadonlyArray<Rule> = [
  appleHeroDroppedWhenStripPresent
]

/** Audit a pass for cross-compilation lossiness on each target, pure. */
export const audit = (pass: Pass.Pass): Report => ({
  apple: appleRules.flatMap((rule) => rule(pass)),
  google: googleRules.flatMap((rule) => rule(pass))
})

// --- Policy ---

export type OnUnsupported = "ignore" | "warn" | "error"

export class UnsupportedError extends Data.TaggedError("FidelityUnsupportedError")<{
  readonly findings: ReadonlyArray<Finding>
}> {}

/** Render a `Finding` as one readable line, used by the "warn" policy. */
export const format = (finding: Finding): string =>
  $match(finding, {
    Dropped: ({ feature, path, reason, target }) => `[${target}] dropped ${feature} at ${path}: ${reason}`,
    Approximated: ({ approximation, feature, path, reason, target }) =>
      `[${target}] approximated ${feature} at ${path}: ${reason} (${approximation})`,
    Resized: ({ feature, path, reason, target }) => `[${target}] resized ${feature} at ${path}: ${reason}`
  })

/**
 * Apply an `OnUnsupported` policy to a set of findings: ignore silently,
 * log a warning per finding, or fail with all findings attached.
 */
export const enforce = (
  findings: ReadonlyArray<Finding>,
  policy: OnUnsupported
): Effect.Effect<void, UnsupportedError> => {
  switch (policy) {
    case "ignore":
      return Effect.void
    case "warn":
      return Effect.forEach(findings, (finding) => Effect.logWarning(format(finding)), { discard: true })
    case "error":
      return findings.length === 0 ? Effect.void : Effect.fail(new UnsupportedError({ findings }))
  }
}
