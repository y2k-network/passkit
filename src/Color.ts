/**
 * Branded hex color, Schema-backed.
 */
import * as Schema from "effect/Schema"

const isHex = (s: string): boolean => /^#[0-9a-fA-F]{6}$/.test(s)

/**
 * A validated `#rrggbb` hex color string, branded so it cannot be mixed with
 * arbitrary strings.
 */
export const ColorSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((s) =>
      isHex(s) ? undefined : `Expected a hex color like "#1e1b4b", got ${JSON.stringify(s)}`
    )
  ),
  Schema.brand("Color")
)

export type Color = typeof ColorSchema.Type

/**
 * Validate and brand a `#rrggbb` hex string as a `Color`. Throws if invalid.
 */
export const hex = (value: string): Color => Schema.decodeUnknownSync(ColorSchema)(value)

const toHexByte = (n: number): string => Math.max(0, Math.min(255, Math.trunc(n))).toString(16).padStart(2, "0")

/**
 * Build a `Color` from individual 0-255 red/green/blue components.
 */
export const rgb = (r: number, g: number, b: number): Color =>
  hex(`#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`)
