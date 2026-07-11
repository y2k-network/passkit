# @y2k-network/passkit

[![CI](https://github.com/y2k-network/passkit/actions/workflows/ci.yml/badge.svg)](https://github.com/y2k-network/passkit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40y2k-network%2Fpasskit.svg)](https://www.npmjs.com/package/@y2k-network/passkit)

An [Effect](https://effect.website)-native library for Apple Wallet and
Google Wallet passes: one neutral pass IR, two compile targets.

> **Beta.** Built on `effect@4.0.0-beta.97`, itself pre-1.0 — expect API
> movement. You must supply your own Apple WWDR intermediate certificate and
> pass-type certificate/key; this library doesn't ship or manage them.
> `AppleWebService.Pusher` (silent-push-to-re-poll) is an interface with a
> no-op default — real APNs delivery is not yet wired up. See `DESIGN.md`
> for the full architecture and rationale.

## The pitch

Apple Wallet and Google Wallet are two different, incompatible pass formats
— different asset models, different field vocabularies, different signing
schemes. Most integrations either duplicate the pass definition twice or
build a leaky lowest-common-denominator abstraction that quietly drops data.

@y2k-network/passkit instead defines one **neutral intermediate representation**
(`Pass`) that captures what a pass actually *is* — an event ticket, a
boarding pass, a coupon; header/primary/secondary/auxiliary/back fields; a
barcode; relevance triggers; assets — and treats Apple's `.pkpass` and
Google's Wallet Objects API as two **compile targets** off that one IR.
Where a target can't represent something the IR expresses, that's not
silently swallowed: `Fidelity.audit` tells you exactly what was dropped,
approximated, or resized, and you choose per-call whether that's fine,
worth a log line, or a hard failure.

```
        ┌────────────┐
        │  Template   │  data -> Pass (your layout, once)
        └──────┬──────┘
               │
               ▼
        ┌────────────┐
        │    Pass     │  neutral IR (DESIGN.md §3)
        └──────┬──────┘
         ┌──────┴──────┐
         ▼             ▼
   Apple.pkpass   Google.saveLink   <- two compile targets (DESIGN.md §5)
         │             │
   .pkpass bytes   save-to-wallet JWT/link
```

## Install

```bash
bun add @y2k-network/passkit
# or
npm install @y2k-network/passkit
```

`effect` is a peer dependency — you need `effect@^4.0.0-beta.97` (or later
compatible beta) installed alongside this package. Duplicate `effect`
instances break its fiber runtime, so a library must peer-depend rather than
bundle its own copy.

## The flagship snippet: one pass, two wallets

This is real, verified code — lifted from `test/integration.test.ts`.

```ts
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import { Apple, Barcode, Color, Field, Google, Pass, Template, Wallet } from "@y2k-network/passkit"

// 1. The data you actually have.
class Attendee extends Schema.Class<Attendee>("Attendee")({
  name: Schema.NonEmptyString,
  ticketId: Schema.String
}) {}

// 2. One Template: data -> Pass IR. This is the only place layout lives.
const EffectDays = Template.make({
  id: Template.Id("effect-days-2026"),
  data: Attendee,
  render: (a) =>
    Pass.eventTicket({
      serial: Pass.Serial(a.ticketId),
      description: "Effect Days 2026",
      organization: "Effect Days"
    }).pipe(
      Pass.primary(Field.text({ key: "name", label: "ATTENDEE", value: a.name })),
      Pass.barcode(Barcode.Qr({ content: a.ticketId, altText: a.ticketId })),
      Pass.colors({ background: Color.hex("#1e1b4b") })
    )
})

// 3. Issue once, ship to both wallets, concurrently.
const program = Effect.gen(function*() {
  const pass = yield* Template.issue(EffectDays, { name: "Ada Lovelace", ticketId: "TICKET-001" })
  return yield* Wallet.issue(pass) // { apple: PkPass, google: SaveLink }
})

const AppleLayer = Apple.layer({
  teamId: "TEAM123456",
  passTypeId: "pass.com.acme.tickets",
  certificate: Apple.Certificate.pem({ cert: leafPem, key: leafKeyPem }),
  wwdr: wwdrPem
})

const GoogleLayer = Layer.mergeAll(
  Layer.succeed(Google.Issuer, { issuerId: "3388000000012345678", serviceAccount }),
  Google.AssetHost.layerNoop // fine when every asset is Asset.Url
)

const offer = await Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(AppleLayer, GoogleLayer))))
// offer.apple.bytes      -> write as a .pkpass file / serve with the right content-type
// offer.google.url       -> redirect the user here ("Add to Google Wallet")
```

`Wallet.issue` is sugar, not magic: it's exactly `Apple.pkpass` and
`Google.saveLink` run concurrently via `Effect.all`. Call them directly
instead if you want per-target options (e.g. a different `onUnsupported`
policy per wallet, or an Apple web-service URL for push updates).

## Layers, one target at a time

```ts
// Apple only, real signing
const pkpass = await Effect.runPromise(Apple.pkpass(pass).pipe(Effect.provide(AppleLayer)))

// Apple only, no certs (dev/example — produces an *unsigned* .pkpass)
const pkpassUnsigned = await Effect.runPromise(Apple.pkpass(pass).pipe(Effect.provide(Apple.layerUnsigned)))

// Google only
const link = await Effect.runPromise(Google.saveLink(pass).pipe(Effect.provide(GoogleLayer)))
```

## The fidelity story

Cross-compiling one IR to two very different formats is inherently lossy —
Google has no per-field `changeMessage` template, Apple has one strip image
slot, Google drops `@2x`/`@3x` density variants, and so on. `Fidelity` makes
that loss visible instead of silent:

```ts
import { Fidelity } from "@y2k-network/passkit"

const report = Fidelity.audit(pass) // { apple: Finding[], google: Finding[] }
report.google.forEach((f) => console.log(Fidelity.format(f)))
```

Every compile call (`Apple.pkpass`, `Google.saveLink`, `Wallet.issue`)
takes an `onUnsupported` option — `"ignore"`, `"warn"` (default, logs each
finding), or `"error"` (fails with `Fidelity.UnsupportedError` carrying the
full finding list) — so you decide, per call site, how strict to be.

## Template story

`Template.make({ id, data: <Schema>, render })` is the one place your pass
*layout* lives, parameterized over whatever data shape you already have
(a DB row, an API response schema, etc.). `Template.issue(template, data)`
validates `data` against the schema and produces a `Pass`; `Template.issueAll`
does the same over a batch, collecting per-item failures.

## Storage and the Apple web service

Passes round-trip through `Pass.Schema` — encode a `Pass` to plain
JSON-safe data to store it (a DB column, a queue message), decode it back
before compiling. See `test/integration.test.ts` for a literal
`JSON.stringify`/`JSON.parse` hop feeding `Apple.pkpass` unchanged.

For push-updatable passes, `AppleWebService` exposes Apple's five-endpoint
device-registration protocol as a mountable `effect/unstable/httpapi`
`HttpApi` group; `Registry.layerMemory` is a dev/test-only in-memory
backing store — bring your own for production. See `src/AppleWebService.ts`
and `examples/tickets.ts`.

## Example server

```bash
bun examples/tickets.ts
```

A ~120-line `Bun.serve()` app: `GET /pass/apple/:id` returns `.pkpass`
bytes (via `Apple.layerUnsigned`, so it runs with no certificates), and
`GET /pass/google/:id` redirects to a "Save to Google Wallet" link. Heavily
commented — start there.

## Learn more

See `DESIGN.md` for the full architecture: the IR's design constraints,
why compile targets rather than a shared superset format, the fidelity
model, and the Apple web-service protocol.

## License

MIT — see `LICENSE`.
