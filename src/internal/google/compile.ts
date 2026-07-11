/**
 * Pure Pass IR -> Google Wallet class/object compiler (DESIGN.md §5.2).
 *
 * @internal
 */
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"

import * as Asset from "../../Asset.ts"
import * as Barcode from "../../Barcode.ts"
import * as Field from "../../Field.ts"
import type * as Pass from "../../Pass.ts"
import * as Relevance from "../../Relevance.ts"

/**
 * A reference to an asset that could not be compiled to a URL directly and
 * needs to be resolved through an `AssetHost` before the object is usable.
 *
 * @internal
 */
export interface Unhosted {
  readonly role: Pass.AssetRole
  readonly density: "1x" | "2x" | "3x"
  readonly asset: Asset.Asset
  /** The field on the compiled `class` object this asset's hosted URL belongs at. */
  readonly targetField: string
}

/**
 * The result of compiling a `Pass` to Google Wallet's class/object pair.
 *
 * @internal
 */
export interface Compiled {
  readonly classId: string
  readonly objectId: string
  readonly class: Record<string, unknown>
  readonly object: Record<string, unknown>
  readonly classField: string
  readonly objectField: string
  readonly unhosted: ReadonlyArray<Unhosted>
}

const KIND_FIELDS: Record<
  Pass.Kind,
  { readonly classField: string; readonly objectField: string; readonly classType: string; readonly objectType: string }
> = {
  EventTicket: {
    classField: "eventTicketClasses",
    objectField: "eventTicketObjects",
    classType: "eventTicketClass",
    objectType: "eventTicketObject"
  },
  BoardingPass: {
    classField: "transitClasses",
    objectField: "transitObjects",
    classType: "transitClass",
    objectType: "transitObject"
  },
  Coupon: {
    classField: "offerClasses",
    objectField: "offerObjects",
    classType: "offerClass",
    objectType: "offerObject"
  },
  StoreCard: {
    classField: "loyaltyClasses",
    objectField: "loyaltyObjects",
    classType: "loyaltyClass",
    objectType: "loyaltyObject"
  },
  Generic: {
    classField: "genericClasses",
    objectField: "genericObjects",
    classType: "genericClass",
    objectType: "genericObject"
  }
}

/**
 * The Google Wallet class field each kind uses for its "logo" image
 * (DESIGN.md §5.2) — most kinds call it `logo`, but loyalty and offer
 * classes use their own field names.
 */
const LOGO_FIELD: Record<Pass.Kind, string> = {
  EventTicket: "logo",
  BoardingPass: "logo",
  Coupon: "titleImage",
  StoreCard: "programLogo",
  Generic: "logo"
}

const TRANSIT_TYPE: Record<NonNullable<Pass.Transit>, string> = {
  air: "AIR",
  train: "TRAIN",
  bus: "BUS",
  boat: "FERRY"
}

const BARCODE_TYPE: Record<Barcode.Barcode["_tag"], string> = {
  Qr: "QR_CODE",
  Aztec: "AZTEC",
  Pdf417: "PDF_417",
  Code128: "CODE_128"
}

/** Render a `Field.FieldValue` to a display string via `Intl`. */
export const renderFieldValue = (value: Field.FieldValue): string => {
  switch (value._tag) {
    case "Text":
      return value.text
    case "Date": {
      const date = DateTime.toDate(value.value)
      const dateStyle = value.date === "none" ? undefined : value.date
      const timeStyle = value.time === "none" ? undefined : value.time
      const options: Intl.DateTimeFormatOptions = {}
      if (dateStyle !== undefined) options.dateStyle = dateStyle
      if (timeStyle !== undefined) options.timeStyle = timeStyle
      if (options.dateStyle === undefined && options.timeStyle === undefined) {
        options.dateStyle = "medium"
      }
      return new Intl.DateTimeFormat("en-US", options).format(date)
    }
    case "Number":
      return new Intl.NumberFormat("en-US", {
        style: value.style === "percent" ? "percent" : "decimal"
      }).format(value.value)
    case "Currency":
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: value.currency
      }).format(BigDecimal.toNumberUnsafe(value.value))
  }
}

const textModule = (field: Field.Field): Record<string, unknown> => ({
  id: field.key,
  header: field.label ?? field.key,
  body: renderFieldValue(field.value)
})

const classSuffixFor = (pass: Pass.Pass, classSuffix?: string): string => {
  if (classSuffix !== undefined) return classSuffix
  const prefix = pass.serial.split(/[-_.]/)[0]
  return prefix !== undefined && prefix.length > 0 ? prefix : "default"
}

const compileBarcode = (barcode: Barcode.Barcode): Record<string, unknown> => ({
  type: BARCODE_TYPE[barcode._tag],
  value: barcode.content,
  ...(barcode.altText !== undefined ? { alternateText: barcode.altText } : {})
})

/**
 * Resolve a `Url` asset to a Google Wallet image object, or produce an
 * `Unhosted` marker for `File`/`Bytes` assets that need an `AssetHost`.
 *
 * @internal
 */
const compileImage = (
  role: Pass.AssetRole,
  density: "1x" | "2x" | "3x",
  asset: Asset.Asset,
  targetField: string,
  unhosted: Array<Unhosted>
): Record<string, unknown> | undefined => {
  if (Asset.isUrl(asset)) {
    return { sourceUri: { uri: asset.url } }
  }
  unhosted.push({ role, density, asset, targetField })
  return undefined
}

/**
 * Compile a validated `Pass` to a Google Wallet class/object pair.
 *
 * @internal
 */
export const compile = (
  pass: Pass.Pass,
  options: { readonly issuerId: string; readonly classSuffix?: string }
): Compiled => {
  const unhosted: Array<Unhosted> = []
  const { classField, classType, objectField, objectType } = KIND_FIELDS[pass._tag]
  const classId = `${options.issuerId}.${classSuffixFor(pass, options.classSuffix)}`
  const objectId = `${options.issuerId}.${pass.serial}`

  const allFields = [
    ...pass.slots.header,
    ...pass.slots.primary,
    ...pass.slots.secondary,
    ...pass.slots.auxiliary,
    ...pass.slots.back
  ]

  const cls: Record<string, unknown> = {
    id: classId
  }

  const obj: Record<string, unknown> = {
    id: objectId,
    classId,
    state: "ACTIVE"
  }

  if (pass._tag === "BoardingPass" && pass.transit !== undefined) {
    ;(cls as Record<string, unknown>).transitType = TRANSIT_TYPE[pass.transit]
  }

  if (pass._tag === "EventTicket") {
    const eventName = pass.semantics.eventName ?? pass.description
    ;(cls as Record<string, unknown>).eventName = { defaultValue: { language: "en-US", value: eventName } }
    if (pass.semantics.venue !== undefined) {
      ;(cls as Record<string, unknown>).venue = {
        name: { defaultValue: { language: "en-US", value: pass.semantics.venue.name } },
        ...(pass.semantics.venue.address !== undefined
          ? { address: { defaultValue: { language: "en-US", value: pass.semantics.venue.address } } }
          : {})
      }
    }
    if (pass.semantics.seat !== undefined) {
      const seat = pass.semantics.seat
      ;(obj as Record<string, unknown>).seatInfo = {
        ...(seat.section !== undefined
          ? { section: { defaultValue: { language: "en-US", value: seat.section } } }
          : {}),
        ...(seat.row !== undefined ? { row: { defaultValue: { language: "en-US", value: seat.row } } } : {}),
        ...(seat.seat !== undefined ? { seat: { defaultValue: { language: "en-US", value: seat.seat } } } : {})
      }
    }
    ;(obj as Record<string, unknown>).textModulesData = allFields.map(textModule)
  } else {
    ;(obj as Record<string, unknown>).textModulesData = [
      { id: "description", header: "Description", body: pass.description },
      ...allFields.map(textModule)
    ]
  }

  if (pass.colors?.background !== undefined) {
    ;(cls as Record<string, unknown>).hexBackgroundColor = pass.colors.background
  }

  if (pass.barcodes.length > 0) {
    ;(obj as Record<string, unknown>).barcode = compileBarcode(pass.barcodes[0]!)
  }

  // Google Wallet has no field for icon/thumbnail assets on any kind — they
  // are dropped entirely (see Fidelity.ts googleIconThumbnailDropped) and
  // never queued for AssetHost upload.

  const logoField = LOGO_FIELD[pass._tag]
  const logo = pass.assets.logo
  if (logo !== undefined) {
    const image = compileImage("logo", "1x", logo["1x"], logoField, unhosted)
    if (image !== undefined) (cls as Record<string, unknown>)[logoField] = image
  }

  // Google Wallet has a single hero image slot. Prefer `hero`; when it is
  // absent, approximate `strip` as the hero image (Fidelity.ts
  // googleStripApproximated). When both are set, `hero` wins and `strip` is
  // dropped (Fidelity.ts googleStripDroppedWhenHeroPresent) — never both.
  const heroSource = pass.assets.hero ?? pass.assets.strip
  const heroRole: Pass.AssetRole = pass.assets.hero !== undefined ? "hero" : "strip"
  if (heroSource !== undefined) {
    const image = compileImage(heroRole, "1x", heroSource["1x"], "heroImage", unhosted)
    if (image !== undefined) (cls as Record<string, unknown>).heroImage = image
  }

  const near = pass.relevance.filter(Relevance.isNear)
  if (near.length > 0) {
    ;(obj as Record<string, unknown>).locations = near.map((r) => ({ latitude: r.lat, longitude: r.lng }))
  }

  const during = pass.relevance.find(Relevance.isDuring)
  if (during !== undefined && (pass._tag === "EventTicket" || pass._tag === "BoardingPass")) {
    ;(obj as Record<string, unknown>).validTimeInterval = {
      startTime: { date: DateTime.formatIso(during.start) },
      endTime: { date: DateTime.formatIso(during.end) }
    }
  }

  return {
    classId,
    objectId,
    class: cls,
    object: obj,
    classField,
    objectField,
    unhosted
  }
}

/** The Google Wallet class/object type names for a `Pass.Kind`, e.g. `"eventTicketClass"`. */
export const typesFor = (kind: Pass.Kind): { readonly classType: string; readonly objectType: string } => {
  const { classType, objectType } = KIND_FIELDS[kind]
  return { classType, objectType }
}
