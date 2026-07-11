/**
 * A runnable event-ticket server: one `Template`, two wallets.
 *
 * Run it with: `bun examples/tickets.ts`, then:
 *   curl -i http://localhost:3000/pass/apple/TICKET-001 -o ticket.pkpass
 *   curl -i http://localhost:3000/pass/google/TICKET-001   (302 -> save link)
 *
 * Uses `Apple.layerUnsigned` (dev-only, no certs needed) and a fake Google
 * service account. Swap in `Apple.layer({ certificate, wwdr, ... })` and a
 * real `Google.ServiceAccount` (from Google Cloud's JSON key file) to go live.
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

import * as Apple from "../src/Apple.ts"
import * as Barcode from "../src/Barcode.ts"
import * as Color from "../src/Color.ts"
import * as Field from "../src/Field.ts"
import * as Google from "../src/Google.ts"
import * as Pass from "../src/Pass.ts"
import * as Template from "../src/Template.ts"

// --- 1. The data your app actually has (e.g. a DB row for an attendee). ---

class Attendee extends Schema.Class<Attendee>("Attendee")({
  name: Schema.NonEmptyString,
  ticketId: Schema.String
}) {}

// --- 2. One Template: data -> Pass IR. This is the only place pass layout lives. ---

const ConferenceTicket = Template.make({
  id: Template.Id("effect-conf-2026"),
  data: Attendee,
  render: (attendee) =>
    Pass.eventTicket({
      serial: Pass.Serial(attendee.ticketId),
      description: "EffectConf 2026",
      organization: "EffectConf"
    }).pipe(
      Pass.primary(Field.text({ key: "name", label: "ATTENDEE", value: attendee.name })),
      Pass.barcode(Barcode.Qr({ content: attendee.ticketId, altText: attendee.ticketId })),
      Pass.colors({ background: Color.hex("#0f172a"), foreground: Color.hex("#ffffff") })
    )
})

// --- 3. Fake "database" of attendees, keyed by ticketId. ---

const attendees: Record<string, string> = {
  "TICKET-001": "Ada Lovelace",
  "TICKET-002": "Grace Hopper"
}

// --- 4. Layers. Swap these for real credentials to go to production. ---

const AppleLayer = Apple.layerUnsigned // dev-only: produces an *unsigned* .pkpass

const GoogleIssuerLayer = Layer.succeed(Google.Issuer, {
  issuerId: "3388000000000000000", // replace with your real Google Wallet issuer ID
  serviceAccount: {
    type: "service_account",
    project_id: "example-project",
    private_key_id: "fake-key-id",
    // NOTE: a fake PEM-shaped key — real deployments load this from the
    // service-account JSON file Google Cloud gives you, never inline.
    private_key: Redacted.make(
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC1\n-----END PRIVATE KEY-----\n"
    ),
    client_email: "wallet@example-project.iam.gserviceaccount.com"
  }
})

const AppLayers = Layer.mergeAll(AppleLayer, GoogleIssuerLayer, Google.AssetHost.layerNoop)

// --- 5. The server. ---

Bun.serve({
  port: 3000,
  routes: {
    "/pass/apple/:id": {
      GET: async (req) => {
        const name = attendees[req.params.id]
        if (name === undefined) return new Response("not found", { status: 404 })

        const program = Effect.gen(function*() {
          const pass = yield* Template.issue(ConferenceTicket, { name, ticketId: req.params.id })
          return yield* Apple.pkpass(pass)
        }).pipe(Effect.provide(AppLayers))

        const result = await Effect.runPromise(Effect.result(program))
        if (result._tag === "Failure") {
          return new Response(`failed to build pass: ${String(result.failure)}`, { status: 500 })
        }

        return new Response(result.success.bytes, {
          headers: { "content-type": result.success.contentType }
        })
      }
    },
    "/pass/google/:id": {
      GET: async (req) => {
        const name = attendees[req.params.id]
        if (name === undefined) return new Response("not found", { status: 404 })

        const program = Effect.gen(function*() {
          const pass = yield* Template.issue(ConferenceTicket, { name, ticketId: req.params.id })
          return yield* Google.saveLink(pass)
        }).pipe(Effect.provide(AppLayers))

        const result = await Effect.runPromise(Effect.result(program))
        if (result._tag === "Failure") {
          return new Response(`failed to build save link: ${String(result.failure)}`, { status: 500 })
        }

        return Response.redirect(result.success.url, 302)
      }
    }
  }
})

console.log("Listening on http://localhost:3000")
console.log("  GET /pass/apple/TICKET-001")
console.log("  GET /pass/google/TICKET-001")
