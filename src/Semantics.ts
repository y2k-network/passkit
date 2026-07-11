/**
 * Machine-readable meaning attached to a pass (DESIGN.md §3.6). Deliberately
 * minimal to start — Apple semanticTags / Google structured fields both grow
 * over time, and this is where that growth lands.
 */
import * as Schema from "effect/Schema"

export interface Seat {
  readonly section?: string
  readonly row?: string
  readonly seat?: string
}

export interface Venue {
  readonly name: string
  readonly address?: string
}

export type EventName = string

/** The open bag of semantic data a pass can carry. Grows over time. */
export interface Semantics {
  readonly seat?: Seat
  readonly venue?: Venue
  readonly eventName?: EventName
}

export const empty: Semantics = {}

/** Build a `Seat` semantic value. */
export const seat = (args: Seat): Seat => args

/** Build a `Venue` semantic value. */
export const venue = (args: Venue): Venue => args

// --- Schema ---

export const SeatSchema = Schema.Struct({
  section: Schema.optional(Schema.String),
  row: Schema.optional(Schema.String),
  seat: Schema.optional(Schema.String)
})

export const VenueSchema = Schema.Struct({
  name: Schema.String,
  address: Schema.optional(Schema.String)
})

export const SemanticsSchema = Schema.Struct({
  seat: Schema.optional(SeatSchema),
  venue: Schema.optional(VenueSchema),
  eventName: Schema.optional(Schema.String)
})

export type SemanticsEncoded = typeof SemanticsSchema.Type
