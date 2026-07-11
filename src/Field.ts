/**
 * Typed field values — a field is not a string, it's a typed value each
 * compile target formats natively (DESIGN.md §3.2).
 */
import * as BigDecimal from "effect/BigDecimal"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"

// --- Key ---

export const KeySchema = Schema.String.pipe(Schema.brand("FieldKey"))
export type Key = typeof KeySchema.Type

/** Brand an arbitrary string as a `Field.Key`. Throws if empty. */
export const Key = (value: string): Key => Schema.decodeUnknownSync(KeySchema)(value)

// --- FieldValue ---

export type DateStyle = "none" | "short" | "medium" | "long" | "full"
export type NumberStyle = "decimal" | "percent"

export type FieldValue = Data.TaggedEnum<{
  readonly Text: { readonly text: string }
  readonly Date: { readonly value: DateTime.DateTime; readonly date?: DateStyle; readonly time?: DateStyle }
  readonly Number: { readonly value: number; readonly style?: NumberStyle }
  readonly Currency: { readonly value: BigDecimal.BigDecimal; readonly currency: string }
}>

const fieldValueFactory = Data.taggedEnum<FieldValue>()

// --- Field ---

export interface Field {
  readonly key: Key
  readonly label?: string
  readonly value: FieldValue
  readonly changeMessage?: string
}

interface TextArgs {
  readonly key: string
  readonly label?: string
  readonly value: string
}

interface DateArgs {
  readonly key: string
  readonly label?: string
  readonly value: DateTime.DateTime
  readonly date?: DateStyle
  readonly time?: DateStyle
}

interface NumberArgs {
  readonly key: string
  readonly label?: string
  readonly value: number
  readonly style?: NumberStyle
}

interface CurrencyArgs {
  readonly key: string
  readonly label?: string
  readonly value: BigDecimal.BigDecimal
  readonly currency: string
}

/** A plain-text field value. */
export const text = (args: TextArgs): Field => ({
  key: Key(args.key),
  label: args.label,
  value: fieldValueFactory.Text({ text: args.value })
})

/** A date/time field value, rendered natively by each target's locale. */
export const date = (args: DateArgs): Field => ({
  key: Key(args.key),
  label: args.label,
  value: fieldValueFactory.Date({ value: args.value, date: args.date, time: args.time })
})

/** A numeric field value. */
export const number = (args: NumberArgs): Field => ({
  key: Key(args.key),
  label: args.label,
  value: fieldValueFactory.Number({ value: args.value, style: args.style })
})

/** A currency field value, backed by `BigDecimal` to avoid float drift. */
export const currency = (args: CurrencyArgs): Field => ({
  key: Key(args.key),
  label: args.label,
  value: fieldValueFactory.Currency({ value: args.value, currency: args.currency })
})

/** Attach an update message ("Gate changed to %@") to a field. */
export const changed = (field: Field, message: string): Field => ({ ...field, changeMessage: message })

export const isText = fieldValueFactory.$is("Text")
export const isDate = fieldValueFactory.$is("Date")
export const isNumber = fieldValueFactory.$is("Number")
export const isCurrency = fieldValueFactory.$is("Currency")

// --- Schema ---
//
// As with `Barcode`, `Field`'s `Data`-backed `FieldValue` doesn't round-trip
// through Schema directly in this v4 beta; `FieldSchema` encodes/decodes a
// structurally-equivalent plain representation for wire transport.

export const FieldValueSchema = Schema.Union([
  Schema.TaggedStruct("Text", { text: Schema.String }),
  Schema.TaggedStruct("Date", {
    value: Schema.DateTimeUtcFromString,
    date: Schema.optional(Schema.Literals(["none", "short", "medium", "long", "full"])),
    time: Schema.optional(Schema.Literals(["none", "short", "medium", "long", "full"]))
  }),
  Schema.TaggedStruct("Number", {
    value: Schema.Number,
    style: Schema.optional(Schema.Literals(["decimal", "percent"]))
  }),
  Schema.TaggedStruct("Currency", {
    value: Schema.BigDecimalFromString,
    currency: Schema.String
  })
])

export const FieldSchema = Schema.Struct({
  key: KeySchema,
  label: Schema.optional(Schema.String),
  value: FieldValueSchema,
  changeMessage: Schema.optional(Schema.String)
})

export type FieldEncoded = typeof FieldSchema.Type
