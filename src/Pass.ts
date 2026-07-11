/**
 * The platform-neutral pass IR (DESIGN.md §3.1). Five kinds, one immutable
 * data structure, slot combinators, all dual (data-first / data-last).
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Fn from "effect/Function"
import * as Option from "effect/Option"
import type * as Pipeable from "effect/Pipeable"
import { pipeArguments } from "effect/Pipeable"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as SchemaIssue from "effect/SchemaIssue"
import * as Asset from "./Asset.ts"
import * as Barcode from "./Barcode.ts"
import * as Color from "./Color.ts"
import * as Field from "./Field.ts"
import * as Relevance from "./Relevance.ts"
import * as Semantics from "./Semantics.ts"

// --- Serial ---

export const SerialSchema = Schema.String.pipe(Schema.brand("PassSerial"))
export type Serial = typeof SerialSchema.Type

/** Brand an arbitrary string as a `Pass.Serial`. Throws if empty. */
export const Serial = (value: string): Serial => Schema.decodeUnknownSync(SerialSchema)(value)

// --- Kinds ---

export type Kind = "EventTicket" | "BoardingPass" | "Coupon" | "StoreCard" | "Generic"

export type Transit = "air" | "train" | "bus" | "boat"

export type AssetRole = "icon" | "logo" | "strip" | "hero" | "thumbnail"

export interface Colors {
  readonly background?: Color.Color
  readonly foreground?: Color.Color
  readonly label?: Color.Color
}

export interface Slots {
  readonly header: ReadonlyArray<Field.Field>
  readonly primary: ReadonlyArray<Field.Field>
  readonly secondary: ReadonlyArray<Field.Field>
  readonly auxiliary: ReadonlyArray<Field.Field>
  readonly back: ReadonlyArray<Field.Field>
}

const emptySlots: Slots = { header: [], primary: [], secondary: [], auxiliary: [], back: [] }

export type Assets = Partial<Record<AssetRole, Asset.AssetSet>>

/** The platform-neutral pass IR. */
export interface Pass<K extends Kind = Kind> extends Pipeable.Pipeable {
  readonly _tag: K
  readonly serial: Serial
  readonly description: string
  readonly organization?: string
  readonly transit?: K extends "BoardingPass" ? Transit : never
  readonly slots: Slots
  readonly barcodes: ReadonlyArray<Barcode.Barcode>
  readonly colors?: Colors
  readonly assets: Assets
  readonly relevance: ReadonlyArray<Relevance.Relevance>
  readonly semantics: Semantics.Semantics
}

export type EventTicket = Pass<"EventTicket">
export type BoardingPass = Pass<"BoardingPass">
export type Coupon = Pass<"Coupon">
export type StoreCard = Pass<"StoreCard">
export type Generic = Pass<"Generic">

const PassTypeId = "~effect-passkit/Pass"

/** Type guard: is `u` a `Pass`? */
export const isPass = (u: unknown): u is Pass =>
  typeof u === "object" && u !== null && (u as any)[PassTypeId] === true

interface BaseArgs {
  readonly serial: Serial
  readonly description: string
  readonly organization?: string
}

const make = <K extends Kind>(tag: K, args: BaseArgs, extra?: Record<string, unknown>): Pass<K> =>
  ({
    [PassTypeId]: true,
    _tag: tag,
    serial: args.serial,
    description: args.description,
    organization: args.organization,
    slots: emptySlots,
    barcodes: [],
    assets: {},
    relevance: [],
    semantics: Semantics.empty,
    ...extra,
    pipe() {
      // eslint-disable-next-line prefer-rest-params
      return pipeArguments(this, arguments)
    }
  }) as unknown as Pass<K>

// --- Constructors ---

/** Construct an event-ticket pass. */
export const eventTicket = (args: BaseArgs): EventTicket => make("EventTicket", args)

/** Construct a boarding-pass pass. A transit mode is required at construction. */
export const boardingPass = (args: BaseArgs & { readonly transit: Transit }): BoardingPass =>
  make("BoardingPass", args, { transit: args.transit })

/** Construct a coupon pass. */
export const coupon = (args: BaseArgs): Coupon => make("Coupon", args)

/** Construct a store-card pass. */
export const storeCard = (args: BaseArgs): StoreCard => make("StoreCard", args)

/** Construct a generic pass — the escape hatch when no other kind fits. */
export const generic = (args: BaseArgs): Generic => make("Generic", args)

// --- Slot combinators (dual) ---

const appendSlot = <K extends Kind>(slot: keyof Slots) =>
  Fn.dual<
    (...fields: ReadonlyArray<Field.Field>) => (self: Pass<K>) => Pass<K>,
    (self: Pass<K>, ...fields: ReadonlyArray<Field.Field>) => Pass<K>
  >(
    (args) => isPass(args[0]),
    (self: Pass<K>, ...fields: ReadonlyArray<Field.Field>): Pass<K> => ({
      ...self,
      slots: { ...self.slots, [slot]: [...self.slots[slot], ...fields] }
    })
  )

/** Append fields to the header slot. */
export const header = appendSlot("header")
/** Append fields to the primary slot. */
export const primary = appendSlot("primary")
/** Append fields to the secondary slot. */
export const secondary = appendSlot("secondary")
/** Append fields to the auxiliary slot. */
export const auxiliary = appendSlot("auxiliary")
/** Append fields to the back slot. */
export const back = appendSlot("back")

// --- Barcode ---

export const barcode: {
  (...barcodes: ReadonlyArray<Barcode.Barcode>): <K extends Kind>(self: Pass<K>) => Pass<K>
  <K extends Kind>(self: Pass<K>, ...barcodes: ReadonlyArray<Barcode.Barcode>): Pass<K>
} = Fn.dual(
  (args) => isPass(args[0]),
  <K extends Kind>(self: Pass<K>, ...barcodes: ReadonlyArray<Barcode.Barcode>): Pass<K> => ({
    ...self,
    barcodes: [...self.barcodes, ...barcodes]
  })
)

// --- Colors ---

export const colors: {
  (colors: Colors): <K extends Kind>(self: Pass<K>) => Pass<K>
  <K extends Kind>(self: Pass<K>, colors: Colors): Pass<K>
} = Fn.dual(
  2,
  <K extends Kind>(self: Pass<K>, colors: Colors): Pass<K> => ({ ...self, colors })
)

// --- Assets ---

const setAsset = <K extends Kind>(role: AssetRole) =>
  Fn.dual<
    (asset: Asset.Asset, variants?: { readonly "2x"?: Asset.Asset; readonly "3x"?: Asset.Asset }) => (
      self: Pass<K>
    ) => Pass<K>,
    (
      self: Pass<K>,
      asset: Asset.Asset,
      variants?: { readonly "2x"?: Asset.Asset; readonly "3x"?: Asset.Asset }
    ) => Pass<K>
  >(
    (args) => isPass(args[0]),
    (
      self: Pass<K>,
      asset: Asset.Asset,
      variants?: { readonly "2x"?: Asset.Asset; readonly "3x"?: Asset.Asset }
    ): Pass<K> => ({
      ...self,
      assets: { ...self.assets, [role]: Asset.set(asset, variants) }
    })
  )

/** Set the icon asset (all kinds). */
export const icon = setAsset("icon")
/** Set the logo asset (all kinds). */
export const logo = setAsset("logo")
/** Set the strip asset. Not valid on boarding passes — see `Fidelity`. */
export const strip = setAsset("strip")
/** Set the hero asset. Google-first; compiles to strip/background on Apple. */
export const hero = setAsset("hero")
/** Set the thumbnail asset. */
export const thumbnail = setAsset("thumbnail")

// --- Relevance ---

export const relevant: {
  (...relevance: ReadonlyArray<Relevance.Relevance>): <K extends Kind>(self: Pass<K>) => Pass<K>
  <K extends Kind>(self: Pass<K>, ...relevance: ReadonlyArray<Relevance.Relevance>): Pass<K>
} = Fn.dual(
  (args) => isPass(args[0]),
  <K extends Kind>(self: Pass<K>, ...relevance: ReadonlyArray<Relevance.Relevance>): Pass<K> => ({
    ...self,
    relevance: [...self.relevance, ...relevance]
  })
)

// --- Semantics ---

export const seat: {
  (seat: Semantics.Seat): <K extends Kind>(self: Pass<K>) => Pass<K>
  <K extends Kind>(self: Pass<K>, seat: Semantics.Seat): Pass<K>
} = Fn.dual(
  2,
  <K extends Kind>(self: Pass<K>, seat: Semantics.Seat): Pass<K> => ({
    ...self,
    semantics: { ...self.semantics, seat }
  })
)

export const venue: {
  (venue: Semantics.Venue): <K extends Kind>(self: Pass<K>) => Pass<K>
  <K extends Kind>(self: Pass<K>, venue: Semantics.Venue): Pass<K>
} = Fn.dual(
  2,
  <K extends Kind>(self: Pass<K>, venue: Semantics.Venue): Pass<K> => ({
    ...self,
    semantics: { ...self.semantics, venue }
  })
)

// --- Kind-specific combinators ---

/** Attach an expiry date. Coupon-only. */
export const expires: {
  (value: Field.Field): (self: Coupon) => Coupon
  (self: Coupon, value: Field.Field): Coupon
} = Fn.dual(
  2,
  // No dedicated semantic slot yet — expiry rides the secondary field itself.
  (self: Coupon, value: Field.Field): Coupon => ({
    ...self,
    slots: { ...self.slots, secondary: [...self.slots.secondary, value] }
  })
)

/** Set the balance field. Store-card-only. Replaces the primary slot (arity 1). */
export const balance: {
  (field: Field.Field): (self: StoreCard) => StoreCard
  (self: StoreCard, field: Field.Field): StoreCard
} = Fn.dual(
  2,
  (self: StoreCard, field: Field.Field): StoreCard => ({
    ...self,
    slots: { ...self.slots, primary: [field] }
  })
)

/** Set the origin field. Boarding-pass-only (paired with `destination`). */
export const origin: {
  (field: Field.Field): (self: BoardingPass) => BoardingPass
  (self: BoardingPass, field: Field.Field): BoardingPass
} = Fn.dual(
  2,
  (self: BoardingPass, field: Field.Field): BoardingPass => ({
    ...self,
    slots: { ...self.slots, primary: [field, ...self.slots.primary.slice(1)] }
  })
)

/** Set the destination field. Boarding-pass-only (paired with `origin`). */
export const destination: {
  (field: Field.Field): (self: BoardingPass) => BoardingPass
  (self: BoardingPass, field: Field.Field): BoardingPass
} = Fn.dual(
  2,
  (self: BoardingPass, field: Field.Field): BoardingPass => ({
    ...self,
    slots: { ...self.slots, primary: [self.slots.primary[0]!, field].filter((f): f is Field.Field => f !== undefined) }
  })
)

// --- Validation ---

export class ValidationError extends Data.TaggedError("PassValidationError")<{
  readonly reason: "DuplicateKey" | "SlotOverflow"
  readonly message: string
}> {}

const SLOT_LIMITS: Record<Kind, Partial<Record<keyof Slots, number>>> = {
  EventTicket: { header: 3, primary: 1, secondary: 4, auxiliary: 4 },
  BoardingPass: { header: 3, primary: 2, secondary: 4, auxiliary: 4 },
  Coupon: { header: 3, primary: 1, secondary: 4, auxiliary: 4 },
  StoreCard: { header: 3, primary: 1, secondary: 4, auxiliary: 4 },
  Generic: { header: 3, primary: 1, secondary: 4, auxiliary: 4 }
}

/**
 * Validate a pass: unique field keys across all slots, and per-kind slot
 * arity limits. Combinators themselves stay total (pure appends); this is
 * where the invariants from DESIGN.md §3.1 are actually enforced.
 */
export const validate = <K extends Kind>(pass: Pass<K>): Effect.Effect<Pass<K>, ValidationError> =>
  Effect.gen(function* () {
    const limits = SLOT_LIMITS[pass._tag]
    const seen = new Map<string, keyof Slots>()

    for (const slotName of ["header", "primary", "secondary", "auxiliary", "back"] as const) {
      const fields = pass.slots[slotName]

      const limit = limits[slotName]
      if (limit !== undefined && fields.length > limit) {
        return yield* Effect.fail(
          new ValidationError({
            reason: "SlotOverflow",
            message: `Slot "${slotName}" on ${pass._tag} allows at most ${limit} field(s), got ${fields.length}`
          })
        )
      }

      for (const field of fields) {
        const existing = seen.get(field.key)
        if (existing !== undefined) {
          return yield* Effect.fail(
            new ValidationError({
              reason: "DuplicateKey",
              message: `Duplicate field key "${field.key}" in slots "${existing}" and "${slotName}"`
            })
          )
        }
        seen.set(field.key, slotName)
      }
    }

    return pass
  })

// --- Schema ---
//
// As with the other IR modules, the whole pass round-trips through Schema
// (DESIGN.md §3.1). Decoding produces a real `Pass` — constructed the same
// way the kind constructors build one, so `.pipe` and every combinator work
// on the result unchanged — while encoding produces a plain JSON-safe
// object. Unknown `_tag`s are rejected by the underlying literal schema; a
// `BoardingPass` missing `transit` is rejected explicitly below.

const KindSchema = Schema.Literals(["EventTicket", "BoardingPass", "Coupon", "StoreCard", "Generic"])

const ColorsSchema = Schema.Struct({
  background: Schema.optional(Color.ColorSchema),
  foreground: Schema.optional(Color.ColorSchema),
  label: Schema.optional(Color.ColorSchema)
})

const SlotsSchema = Schema.Struct({
  header: Schema.Array(Field.FieldSchema),
  primary: Schema.Array(Field.FieldSchema),
  secondary: Schema.Array(Field.FieldSchema),
  auxiliary: Schema.Array(Field.FieldSchema),
  back: Schema.Array(Field.FieldSchema)
})

const AssetsSchema = Schema.Struct({
  icon: Schema.optional(Asset.AssetSetSchema),
  logo: Schema.optional(Asset.AssetSetSchema),
  strip: Schema.optional(Asset.AssetSetSchema),
  hero: Schema.optional(Asset.AssetSetSchema),
  thumbnail: Schema.optional(Asset.AssetSetSchema)
})

const PassStructSchema = Schema.Struct({
  _tag: KindSchema,
  serial: SerialSchema,
  description: Schema.String,
  organization: Schema.optional(Schema.String),
  transit: Schema.optional(Schema.Literals(["air", "train", "bus", "boat"])),
  slots: SlotsSchema,
  barcodes: Schema.Array(Barcode.BarcodeSchema),
  colors: Schema.optional(ColorsSchema),
  assets: AssetsSchema,
  relevance: Schema.Array(Relevance.RelevanceSchema),
  semantics: Semantics.SemanticsSchema
})

export type PassEncoded = typeof PassStructSchema.Type

const PassTarget = Schema.declare<Pass>(isPass)

/**
 * The whole IR, Schema-backed (DESIGN.md §3.1). Decodes plain JSON-safe data
 * into a real `Pass` (same construction as the kind constructors — pipeable,
 * combinator-compatible); encodes a `Pass` back into plain data.
 */
export const Schema_ = PassStructSchema.pipe(
  Schema.decodeTo(PassTarget, {
    decode: SchemaGetter.transformOrFail((encoded) => {
      if (encoded._tag === "BoardingPass" && encoded.transit === undefined) {
        return Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(encoded), {
            message: "BoardingPass requires a transit mode"
          })
        )
      }

      const base = make(
        encoded._tag,
        { serial: encoded.serial, description: encoded.description, organization: encoded.organization },
        encoded._tag === "BoardingPass" ? { transit: encoded.transit } : undefined
      )

      const pass: Pass = {
        ...base,
        slots: encoded.slots,
        barcodes: encoded.barcodes,
        colors: encoded.colors,
        assets: encoded.assets,
        relevance: encoded.relevance,
        semantics: encoded.semantics
      }

      return Effect.succeed(pass)
    }),
    encode: SchemaGetter.transform(
      (pass: Pass): typeof PassStructSchema.Type => ({
        _tag: pass._tag,
        serial: pass.serial,
        description: pass.description,
        organization: pass.organization,
        transit: pass.transit,
        slots: pass.slots as unknown as typeof PassStructSchema.Type["slots"],
        barcodes: pass.barcodes,
        colors: pass.colors,
        assets: pass.assets,
        relevance: pass.relevance as unknown as typeof PassStructSchema.Type["relevance"],
        semantics: pass.semantics
      })
    )
  })
)

export { Schema_ as Schema }
