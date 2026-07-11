/**
 * Where and when a pass surfaces (DESIGN.md §3.5).
 */
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"

export type Relevance = Data.TaggedEnum<{
  readonly Near: { readonly lat: number; readonly lng: number; readonly note?: string }
  readonly During: { readonly start: DateTime.DateTime; readonly end: DateTime.DateTime }
  readonly Beacon: {
    readonly proximityUUID: string
    readonly major?: number
    readonly minor?: number
    readonly note?: string
  }
}>

const factory = Data.taggedEnum<Relevance>()

/** Surface the pass near a physical location. */
export const near = (args: { readonly lat: number; readonly lng: number; readonly note?: string }): Relevance =>
  factory.Near(args)

/** Surface the pass during a time window. */
export const during = (args: { readonly start: DateTime.DateTime; readonly end: DateTime.DateTime }): Relevance =>
  factory.During(args)

/**
 * Surface the pass near an iBeacon region. Apple-only — dropped when
 * compiling to Google (see `Fidelity`).
 */
export const beacon = (
  args: { readonly proximityUUID: string; readonly major?: number; readonly minor?: number; readonly note?: string }
): Relevance => factory.Beacon(args)

export const isNear = factory.$is("Near")
export const isDuring = factory.$is("During")
export const isBeacon = factory.$is("Beacon")
export const $match = factory.$match

// --- Schema ---
//
// As with `Barcode`/`Field`/`Asset`, decodes to and encodes from plain
// tagged structs with the same shape as `Relevance`'s variants.

export const NearSchema = Schema.TaggedStruct("Near", {
  lat: Schema.Number,
  lng: Schema.Number,
  note: Schema.optional(Schema.String)
})

export const DuringSchema = Schema.TaggedStruct("During", {
  start: Schema.DateTimeUtcFromString,
  end: Schema.DateTimeUtcFromString
})

export const BeaconSchema = Schema.TaggedStruct("Beacon", {
  proximityUUID: Schema.String,
  major: Schema.optional(Schema.Number),
  minor: Schema.optional(Schema.Number),
  note: Schema.optional(Schema.String)
})

export const RelevanceSchema = Schema.Union([NearSchema, DuringSchema, BeaconSchema])

export type RelevanceEncoded = typeof RelevanceSchema.Type
