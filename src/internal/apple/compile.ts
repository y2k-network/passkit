/**
 * Pure IR -> pass.json compiler for the Apple target (DESIGN.md §5.1).
 *
 * `toPassJson` takes a platform-neutral `Pass` and a small target-config
 * object and produces the plain JSON object Apple's PassKit expects. No I/O,
 * no signing, no asset resolution — those live in `Apple.ts`.
 */
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import * as Barcode from "../../Barcode.ts"
import * as Color from "../../Color.ts"
import * as Field from "../../Field.ts"
import type * as Pass from "../../Pass.ts"
import * as Relevance from "../../Relevance.ts"

/**
 * Compile-time config needed to render pass.json: the Team ID / Pass Type ID
 * that identify the signing identity, and an optional web-service mount
 * point for update polling (DESIGN.md §7).
 */
export interface CompileConfig {
  readonly teamId: string
  readonly passTypeId: string
  readonly webService?: {
    readonly url: string
    readonly authToken: string
  }
}

const KIND_TO_STYLE: Record<Pass.Kind, string> = {
  EventTicket: "eventTicket",
  BoardingPass: "boardingPass",
  Coupon: "coupon",
  StoreCard: "storeCard",
  Generic: "generic"
}

const TRANSIT_TO_PK: Record<NonNullable<Pass.Transit>, string> = {
  air: "PKTransitTypeAir",
  train: "PKTransitTypeTrain",
  bus: "PKTransitTypeBus",
  boat: "PKTransitTypeBoat"
}

const DATE_STYLE_TO_PK: Record<Field.DateStyle, string> = {
  none: "PKDateStyleNone",
  short: "PKDateStyleShort",
  medium: "PKDateStyleMedium",
  long: "PKDateStyleLong",
  full: "PKDateStyleFull"
}

const NUMBER_STYLE_TO_PK: Record<Field.NumberStyle, string> = {
  decimal: "PKNumberStyleDecimal",
  percent: "PKNumberStylePercent"
}

const BARCODE_FORMAT: Record<Barcode.Barcode["_tag"], string> = {
  Qr: "PKBarcodeFormatQR",
  Aztec: "PKBarcodeFormatAztec",
  Pdf417: "PKBarcodeFormatPDF417",
  Code128: "PKBarcodeFormatCode128"
}

const hexToRgb = (color: Color.Color): string => {
  const r = parseInt(color.slice(1, 3), 16)
  const g = parseInt(color.slice(3, 5), 16)
  const b = parseInt(color.slice(5, 7), 16)
  return `rgb(${r}, ${g}, ${b})`
}

const compileFieldValue = (value: Field.FieldValue): Record<string, unknown> => {
  switch (value._tag) {
    case "Text":
      return { value: value.text }
    case "Date": {
      const out: Record<string, unknown> = { value: DateTime.formatIso(value.value) }
      if (value.date !== undefined) out.dateStyle = DATE_STYLE_TO_PK[value.date]
      if (value.time !== undefined) out.timeStyle = DATE_STYLE_TO_PK[value.time]
      return out
    }
    case "Number": {
      const out: Record<string, unknown> = { value: value.value }
      if (value.style !== undefined) out.numberStyle = NUMBER_STYLE_TO_PK[value.style]
      return out
    }
    case "Currency":
      return { value: BigDecimal.toNumberUnsafe(value.value), currencyCode: value.currency }
  }
}

const compileField = (field: Field.Field): Record<string, unknown> => ({
  key: field.key,
  ...(field.label !== undefined ? { label: field.label } : {}),
  ...compileFieldValue(field.value),
  ...(field.changeMessage !== undefined ? { changeMessage: field.changeMessage } : {})
})

const compileSlots = (slots: Pass.Slots): Record<string, unknown> => ({
  headerFields: slots.header.map(compileField),
  primaryFields: slots.primary.map(compileField),
  secondaryFields: slots.secondary.map(compileField),
  auxiliaryFields: slots.auxiliary.map(compileField),
  backFields: slots.back.map(compileField)
})

const compileBarcode = (barcode: Barcode.Barcode): Record<string, unknown> => ({
  format: BARCODE_FORMAT[barcode._tag],
  message: barcode.content,
  messageEncoding: barcode.encoding ?? "iso-8859-1",
  ...(barcode.altText !== undefined ? { altText: barcode.altText } : {})
})

const compileRelevance = (relevance: ReadonlyArray<Relevance.Relevance>): Record<string, unknown> => {
  const locations: Array<Record<string, unknown>> = []
  const beacons: Array<Record<string, unknown>> = []
  let relevantDate: string | undefined

  for (const r of relevance) {
    switch (r._tag) {
      case "Near":
        locations.push({
          latitude: r.lat,
          longitude: r.lng,
          ...(r.note !== undefined ? { relevantText: r.note } : {})
        })
        break
      case "During":
        relevantDate = DateTime.formatIso(r.start)
        break
      case "Beacon":
        beacons.push({
          proximityUUID: r.proximityUUID,
          ...(r.major !== undefined ? { major: r.major } : {}),
          ...(r.minor !== undefined ? { minor: r.minor } : {}),
          ...(r.note !== undefined ? { relevantText: r.note } : {})
        })
        break
    }
  }

  const out: Record<string, unknown> = {}
  if (locations.length > 0) out.locations = locations
  if (beacons.length > 0) out.beacons = beacons
  if (relevantDate !== undefined) out.relevantDate = relevantDate
  return out
}

const compileSemantics = (pass: Pass.Pass): Record<string, unknown> | undefined => {
  const { semantics } = pass
  if (semantics.seat === undefined && semantics.venue === undefined && semantics.eventName === undefined) {
    return undefined
  }

  const out: Record<string, unknown> = {}
  if (semantics.eventName !== undefined) out.eventName = semantics.eventName
  if (semantics.venue !== undefined) {
    out.venueName = semantics.venue.name
    if (semantics.venue.address !== undefined) out.venueLocation = semantics.venue.address
  }
  if (semantics.seat !== undefined) {
    const seats: Record<string, unknown> = {}
    if (semantics.seat.section !== undefined) seats.seatSection = semantics.seat.section
    if (semantics.seat.row !== undefined) seats.seatRow = semantics.seat.row
    if (semantics.seat.seat !== undefined) seats.seatNumber = semantics.seat.seat
    out.seats = [seats]
  }
  return out
}

/**
 * Compiles a platform-neutral `Pass` into the plain pass.json object Apple's
 * PassKit expects. Pure — no validation (call `Pass.validate` first), no
 * asset resolution, no signing.
 */
export const toPassJson = (pass: Pass.Pass, config: CompileConfig): Record<string, unknown> => {
  const style = KIND_TO_STYLE[pass._tag]

  const styleBody: Record<string, unknown> = compileSlots(pass.slots)
  if (pass._tag === "BoardingPass" && pass.transit !== undefined) {
    styleBody.transitType = TRANSIT_TO_PK[pass.transit]
  }

  const out: Record<string, unknown> = {
    formatVersion: 1,
    serialNumber: pass.serial,
    description: pass.description,
    organizationName: pass.organization ?? pass.description,
    teamIdentifier: config.teamId,
    passTypeIdentifier: config.passTypeId,
    [style]: styleBody
  }

  if (pass.barcodes.length > 0) {
    out.barcodes = pass.barcodes.map(compileBarcode)
  }

  if (pass.colors !== undefined) {
    if (pass.colors.background !== undefined) out.backgroundColor = hexToRgb(pass.colors.background)
    if (pass.colors.foreground !== undefined) out.foregroundColor = hexToRgb(pass.colors.foreground)
    if (pass.colors.label !== undefined) out.labelColor = hexToRgb(pass.colors.label)
  }

  if (pass.relevance.length > 0) {
    Object.assign(out, compileRelevance(pass.relevance))
  }

  const semantics = compileSemantics(pass)
  if (semantics !== undefined) out.semantics = semantics

  if (config.webService !== undefined) {
    out.webServiceURL = config.webService.url
    out.authenticationToken = config.webService.authToken
  }

  return out
}
