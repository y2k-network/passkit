/**
 * `Template` — the Class/Object split, made universal (DESIGN.md §4).
 *
 * A `Template` is a `Schema` for per-holder data plus a pure function from
 * that decoded data to a `Pass`. Issuing a pass is: decode → render →
 * validate. Nothing here touches a platform target — Apple/Google class sync
 * happens in phase 3.
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Pass from "./Pass.ts"

// --- Id ---

export const IdSchema = Schema.String.pipe(Schema.brand("TemplateId"))
export type Id = typeof IdSchema.Type

/** Brand an arbitrary string as a `Template.Id`. Throws if empty. */
export const Id = (value: string): Id => Schema.decodeUnknownSync(IdSchema)(value)

// --- Template ---

/**
 * A `Schema`-bound pass factory: per-holder data goes in, a rendered `Pass`
 * comes out. This is the universal analogue of Google Wallet's Class/Object
 * split (DESIGN.md §4) — `Template` ≍ Class, `Pass` ≍ Object.
 */
export interface Template<A, K extends Pass.Kind = Pass.Kind> {
  readonly id: Id
  readonly data: Schema.Codec<A, unknown>
  readonly render: (decoded: A) => Pass.Pass<K>
}

export interface MakeArgs<S extends Schema.Codec<any, unknown>, K extends Pass.Kind> {
  readonly id: Id
  readonly data: S
  readonly render: (decoded: S["Type"]) => Pass.Pass<K>
}

/**
 * Build a `Template` from a per-holder-data `Schema` and a pure render
 * function.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Pass, Field, Barcode, Template } from "effect-passkit"
 *
 * class Attendee extends Schema.Class<Attendee>("Attendee")({
 *   name: Schema.NonEmptyString,
 *   ticketId: Schema.String,
 *   tier: Schema.Literals(["ga", "vip"])
 * }) {}
 *
 * const EffectDays = Template.make({
 *   id: Template.Id("effect-days-2026"),
 *   data: Attendee,
 *   render: (a) =>
 *     Pass.eventTicket({
 *       serial: Pass.Serial(a.ticketId),
 *       description: `Effect Days 2026 — ${a.tier === "vip" ? "VIP" : "GA"}`
 *     }).pipe(
 *       Pass.primary(Field.text({ key: "name", label: "ATTENDEE", value: a.name })),
 *       Pass.barcode(Barcode.Qr({ content: a.ticketId }))
 *     )
 * })
 *
 * // issue one
 * // const pass = yield* Template.issue(EffectDays, { name: "Ada", ticketId: "TKT-1", tier: "vip" })
 * ```
 */
export const make = <S extends Schema.Codec<any, unknown>, K extends Pass.Kind>(
  args: MakeArgs<S, K>
): Template<S["Type"], K> => ({
  id: args.id,
  data: args.data,
  render: args.render
})

// --- Errors ---

export class IssueError extends Schema.ErrorClass<IssueError>("effect-passkit/Template/IssueError")({
  _tag: Schema.tag("TemplateIssueError"),
  templateId: Schema.String,
  message: Schema.String
}) {}

// --- issue / issueAll ---

/**
 * Decode `input` against the template's data schema, render it to a `Pass`,
 * and validate the result (DESIGN.md §3.1 slot invariants).
 */
export const issue = <A, K extends Pass.Kind>(
  template: Template<A, K>,
  input: unknown
): Effect.Effect<Pass.Pass<K>, IssueError | Pass.ValidationError> =>
  Schema.decodeUnknownEffect(template.data)(input).pipe(
    Effect.mapError(
      (issue) =>
        new IssueError({
          templateId: template.id,
          message: `Template "${template.id}" failed to decode input: ${issue.message}`
        })
    ),
    Effect.map((decoded) => template.render(decoded)),
    Effect.flatMap(Pass.validate)
  )

/**
 * `issue` over many inputs, failing fast on the first decode/render/validate
 * error.
 */
export const issueAll = <A, K extends Pass.Kind>(
  template: Template<A, K>,
  inputs: Iterable<unknown>
): Effect.Effect<Array<Pass.Pass<K>>, IssueError | Pass.ValidationError> =>
  Effect.forEach(inputs, (input) => issue(template, input))
