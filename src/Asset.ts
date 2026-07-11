/**
 * Resolvable image resources — Apple embeds bytes, Google references hosted
 * URLs (DESIGN.md §3.4). This module only models the data; fetching and
 * uploading are target-phase concerns.
 */
import * as Data from "effect/Data"
import * as Schema from "effect/Schema"

export type Asset = Data.TaggedEnum<{
  readonly File: { readonly path: string }
  readonly Url: { readonly url: string }
  readonly Bytes: { readonly bytes: Uint8Array }
}>

const factory = Data.taggedEnum<Asset>()

/** An asset resolved from a local filesystem path. */
export const file = (path: string): Asset => factory.File({ path })

/** An asset resolved from a remote URL. */
export const url = (url: string): Asset => factory.Url({ url })

/** An asset provided as raw bytes. */
export const bytes = (bytes: Uint8Array): Asset => factory.Bytes({ bytes })

export const isFile = factory.$is("File")
export const isUrl = factory.$is("Url")
export const isBytes = factory.$is("Bytes")
export const $match = factory.$match

/**
 * An asset that has been fully resolved to bytes with a known content type —
 * the shape a target compiler needs once resolution (fetch/upload) is done.
 * Modeled here as data only; producing one is target-phase work.
 */
export interface Resolved {
  readonly bytes: Uint8Array
  readonly contentType: string
}

/**
 * Density variants for a single image role. Apple wants @1x/@2x/@3x PNGs;
 * Google wants a single URL, so `"1x"` alone is always sufficient there.
 */
export interface AssetSet {
  readonly "1x": Asset
  readonly "2x"?: Asset
  readonly "3x"?: Asset
}

/** Build an `AssetSet` from a base asset plus optional density variants. */
export const set = (
  base: Asset,
  variants?: { readonly "2x"?: Asset; readonly "3x"?: Asset }
): AssetSet => ({ "1x": base, ...variants })

// --- Schema ---
//
// As with `Barcode`/`Field`, `Asset`'s `Data`-backed tagged enum doesn't
// round-trip through Schema directly in this v4 beta; `AssetSchema` below
// decodes to and encodes from plain tagged structs with the same shape.

export const FileSchema = Schema.TaggedStruct("File", { path: Schema.String })
export const UrlSchema = Schema.TaggedStruct("Url", { url: Schema.String })
export const BytesSchema = Schema.TaggedStruct("Bytes", { bytes: Schema.Uint8Array })

export const AssetSchema = Schema.Union([FileSchema, UrlSchema, BytesSchema])

export type AssetEncoded = typeof AssetSchema.Type

export const AssetSetSchema = Schema.Struct({
  "1x": AssetSchema,
  "2x": Schema.optional(AssetSchema),
  "3x": Schema.optional(AssetSchema)
})

export type AssetSetEncoded = typeof AssetSetSchema.Type
