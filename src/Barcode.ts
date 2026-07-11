/**
 * The intersection of barcode symbologies both Apple and Google Wallet
 * render, modeled as a `Data.taggedEnum`.
 */
import * as Data from "effect/Data"
import * as Schema from "effect/Schema"

/** Apple's PKBarcodeFormat message encoding. Applies to all four symbologies. */
export type BarcodeEncoding = "iso-8859-1" | "utf-8"

export type Barcode = Data.TaggedEnum<{
  readonly Qr: { readonly content: string; readonly altText?: string; readonly encoding?: BarcodeEncoding }
  readonly Aztec: { readonly content: string; readonly altText?: string; readonly encoding?: BarcodeEncoding }
  readonly Pdf417: { readonly content: string; readonly altText?: string; readonly encoding?: BarcodeEncoding }
  readonly Code128: { readonly content: string; readonly altText?: string; readonly encoding?: BarcodeEncoding }
}>

const factory = Data.taggedEnum<Barcode>()

type Args = { readonly content: string; readonly altText?: string; readonly encoding?: BarcodeEncoding }

/** Construct a QR barcode. */
export const Qr = (args: Args): Barcode => factory.Qr(args)

/** Construct an Aztec barcode. */
export const Aztec = (args: Args): Barcode => factory.Aztec(args)

/** Construct a PDF417 barcode. */
export const Pdf417 = (args: Args): Barcode => factory.Pdf417(args)

/** Construct a Code128 barcode. */
export const Code128 = (args: Args): Barcode => factory.Code128(args)

export const $is = factory.$is
export const $match = factory.$match

// --- Schema ---
//
// NOTE: `Data.taggedEnum` values (which carry `Equal`/`Hash` via the `Data`
// module) don't have first-class Schema decode/encode support in this v4
// beta. `BarcodeSchema` below decodes to and encodes from plain tagged
// structs with the same shape as `Barcode`'s variants (structurally
// interchangeable, but without `Data`'s value-equality baked in). Use the
// `Qr`/`Aztec`/`Pdf417`/`Code128` constructors above when you want `Data`
// equality; use `BarcodeSchema` for wire (de)serialization.

const fields = {
  content: Schema.String,
  altText: Schema.optional(Schema.String),
  encoding: Schema.optional(Schema.Literals(["iso-8859-1", "utf-8"]))
}

export const QrSchema = Schema.TaggedStruct("Qr", fields)
export const AztecSchema = Schema.TaggedStruct("Aztec", fields)
export const Pdf417Schema = Schema.TaggedStruct("Pdf417", fields)
export const Code128Schema = Schema.TaggedStruct("Code128", fields)

export const BarcodeSchema = Schema.Union([QrSchema, AztecSchema, Pdf417Schema, Code128Schema])

export type BarcodeEncoded = typeof BarcodeSchema.Type
