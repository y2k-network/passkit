# effect-passkit — Design Sketch

> One pass, two wallets. A platform-neutral pass IR, compiled by two targets:
> Apple (`.pkpass`, signed) and Google (Wallet Objects, JWT save links).
> Written the way the Effect team would write it: schemas as the source of
> truth, capabilities as services, effects for everything that can fail.

---

## 1. The core insight

Apple Wallet and Google Wallet are not two APIs to be papered over — they are
two **compile targets** for the same abstract artifact. A boarding pass is a
boarding pass; Apple wants a zip of JSON + PNGs signed with PKCS#7, Google
wants a REST object referenced from an RS256 JWT. Neither of those is the
*pass*. The pass is the data.

So the library is a compiler:

```
            ┌────────────────┐
            │  Pass (the IR) │   pure data, Schema-backed, platform-neutral
            └───────┬────────┘
        ┌───────────┴────────────┐
        ▼                        ▼
  Apple.pkpass(pass)      Google.saveLink(pass)
  Effect<PkPass,          Effect<SaveLink,
    Apple.Error,            Google.Error,
    Apple.Signer | ...>     Google.Issuer | ...>
```

Everything platform-specific — certificates, service accounts, signing, image
byte-wrangling, the Apple web-service update protocol — lives in the targets,
expressed as **services** you provide with **layers**. The pass itself never
touches an `R` beyond what its assets need.

## 2. Module map

```
effect-passkit
├── Pass         the IR: five pass kinds, slot combinators, dual APIs
├── Field        typed field values (text / date / currency / number)
├── Barcode      Data.taggedEnum — Qr | Aztec | Pdf417 | Code128
├── Color        branded hex color, contrast helpers
├── Asset        resolvable images — file / url / bytes; R flows into the type
├── Relevance    where & when a pass surfaces (locations, windows, beacons)
├── Semantics    machine-readable meaning (seat, gate, venue, …)
├── Template     Schema-bound pass factories (Google Class ≍ Template, Object ≍ Pass)
├── Fidelity     what survives compilation to each target, as data
├── Apple        target: Signer service, pkpass builder; AppleWebService HttpApi (APNs push interface, no-op default)
├── Google       target: Issuer service, saveLink, class/object sync, AssetHost
└── Wallet       one-call ergonomics across both targets
```

## 3. Primitives

### 3.1 `Pass` — the IR

Five kinds, one per constructor. The kind is a tag, and kind-specific
requirements are captured at construction (a boarding pass *cannot exist*
without a transit mode):

```ts
import { Pass, Field, Barcode, Color, Asset } from "effect-passkit"

const ticket = Pass.eventTicket({
  serial: Pass.Serial("TKT-8675309"),
  description: "Effect Days 2026 — General Admission",
  organization: "Effectful Technologies"
}).pipe(
  Pass.header(Field.text({ key: "gate", label: "GATE", value: "B42" })),
  Pass.primary(Field.text({ key: "event", label: "EVENT", value: "Effect Days 2026" })),
  Pass.secondary(
    Field.date({ key: "doors", label: "DOORS", value: doors, time: "short" }),
    Field.text({ key: "section", label: "SECTION", value: "GA" })
  ),
  Pass.back(Field.text({ key: "terms", label: "Terms", value: "Non-transferable." })),
  Pass.barcode(Barcode.Qr({ content: "TKT-8675309", altText: "TKT-8675309" })),
  Pass.colors({
    background: Color.hex("#1e1b4b"),
    foreground: Color.hex("#ffffff"),
    label: Color.hex("#a5b4fc")
  }),
  Pass.logo(Asset.file("assets/logo.png")),
  Pass.icon(Asset.file("assets/icon.png"))
)
```

Design notes:

- **Slots, not children.** A pass is not a tree; it is a fixed set of slots
  (`header`, `primary`, `secondary`, `auxiliary`, `back`) with per-kind arity
  rules (an event ticket has one primary field; a boarding pass has two —
  origin and destination). Slot combinators are typed per kind, so
  `Pass.origin`/`Pass.destination` exist on boarding passes and nowhere else.
  Slot combinators themselves stay total pure appends — they do **not** check
  arity or key uniqueness. Those invariants are enforced by `Pass.validate`,
  which every compile entrypoint (`Apple.pkpass`, `Google.saveLink`,
  `Google.sync`, `Template.issue`/`issueAll`) runs as its first step. That
  keeps the combinators composable and total while still guaranteeing that
  nothing malformed reaches a target compiler — validated at the boundary,
  not scattered through construction.
- **Every combinator is dual** (data-first and data-last, `dual`-style), so
  the API works in `pipe` and in direct application.
- **`Pass.Serial`** is a branded string (`Schema.String.pipe(Schema.brand("PassSerial"))`).
  Identity is first-class because updates and revocation hang off it.
- The whole IR is `Schema`-backed (`Pass.Schema`) — decode a pass from a
  database row or queue message, encode it back to plain JSON-safe data to
  store it. This includes a full round-trip guarantee for the value types
  that don't serialize as plain JSON natively: `Field.date` values encode as
  ISO-8601 strings (`Schema.DateTimeUtcFromString`) and `Field.currency`
  values encode as decimal strings (`Schema.BigDecimalFromString`), both
  decoding back to real `DateTime`/`BigDecimal` values, not stringly-typed
  approximations. `Barcode`, `Field`, and `Asset` are `Data.taggedEnum`s that
  don't round-trip through `Schema.declare` directly in this v4 beta, so each
  has a small companion `Schema` (`FieldSchema`, `BarcodeSchema`,
  `AssetSchema`) that decodes/encodes a structurally-equivalent plain tagged
  struct — `Pass.Schema` composes all of them.

Kind constructors and their kind-specific surface:

| Constructor         | Extra surface                                          |
| ------------------- | ------------------------------------------------------ |
| `Pass.eventTicket`  | `Pass.venue`, `Pass.seat` (semantics, all kinds)       |
| `Pass.boardingPass` | requires `transit: "air" \| "train" \| "bus" \| "boat"` at construction; `Pass.origin`/`Pass.destination` (paired primary slot) |
| `Pass.coupon`       | `Pass.expires` (rides the secondary slot; no dedicated semantic slot yet) |
| `Pass.storeCard`    | `Pass.balance` (replaces the primary slot, arity 1)    |
| `Pass.generic`      | nothing extra — the escape hatch                       |

(`Pass.seat`/`Pass.venue` are actually available on every kind — they attach
to `pass.semantics`, not a kind-specific slot; listed under `eventTicket`
above only because that's where they're most useful.)

### 3.2 `Field` — values with meaning

A field is not a string; it is a typed value that each target formats
natively (Apple: `dateStyle`/`currencyCode` in pass.json so the *device*
localizes; Google: pre-rendered via `Intl` at compile time):

```ts
Field.text({ key: "seat", label: "SEAT", value: "14C" })
Field.date({ key: "departs", label: "DEPARTS", value: departsUtc, date: "medium", time: "short" })
Field.currency({ key: "balance", label: "BALANCE", value: BigDecimal.make(2450n, 2), currency: "USD" })
Field.number({ key: "points", label: "POINTS", value: 8250, style: "decimal" })
```

`key` is branded (`Field.Key`) and must be unique across every slot in a
pass — enforced by `Pass.validate` (run by every compile entrypoint, see
§3.1), not discovered at Apple's door.

`Field.changed(field, message)` attaches an update message ("Gate changed to
%@") which compiles to Apple's `changeMessage`. There is no `Google.push`
today — see "Roadmap" below.

### 3.3 `Barcode`

The intersection both platforms render, as a tagged enum:

```ts
export type Barcode = Data.TaggedEnum<{
  Qr:      { content: string; altText?: string; encoding?: "iso-8859-1" | "utf-8" }
  Aztec:   { content: string; altText?: string }
  Pdf417:  { content: string; altText?: string }
  Code128: { content: string; altText?: string }
}>
```

No `Barcode.custom`. If a symbology isn't renderable on both platforms, it
isn't in the core — that's the covenant of the IR. (Apple-only extras would
live under `Apple.Barcode` and surface in the `Fidelity` report.)

### 3.4 `Asset` — images that know how to become bytes *or* URLs

The deepest platform asymmetry: Apple embeds image **bytes** in the signed
bundle; Google references **hosted URLs**. So an asset is a *resolvable*
resource, and what it costs to resolve shows up in `R` — the Effect way of
saying "this pass needs the network":

```ts
Asset.file("assets/logo.png")      // Apple: free (FileSystem). Google: needs Google.AssetHost to upload → URL
Asset.url("https://cdn/logo.png")  // Google: free. Apple: fetched at compile (needs HttpClient)
Asset.bytes(uint8array)            // Apple: free. Google: needs Google.AssetHost
```

`Google.AssetHost` is a small service — `upload: (bytes, hint) =>
Effect<string, unknown>` — with layers for R2/S3/GCS or your own CDN. It's
required in `Google.saveLink`/`Google.sync`'s `R` unconditionally (not just
when a non-`Url` asset is present — v4's service resolution can't make a
requirement conditional on runtime data). `AssetHost.layerNoop` is the
honest default when every asset is `Asset.Url`: it fails loudly, naming the
offending asset, the moment that assumption breaks. If your assets are
already URLs the upload function is simply never called.

Density variants are explicit, not filename-magic:

```ts
Pass.logo(Asset.file("logo.png"), { "2x": Asset.file("logo@2x.png") })
```

Roles are separate combinators — `Pass.icon`, `Pass.logo`, `Pass.strip`,
`Pass.hero`, `Pass.thumbnail` — because roles have per-kind validity (strip
images don't exist on boarding passes; `hero` is Google-first and maps onto
Apple's `strip.png` unless a real `strip` asset is also set, in which case
`strip` wins).

### 3.5 `Relevance` — where and when

```ts
ticket.pipe(
  Pass.relevant(
    Relevance.near({ lat: 52.52, lng: 13.405, note: "Walk to Gate B42" }),
    Relevance.during({ start: doors, end: ends })
  )
)
```

`Relevance.beacon(...)` exists but is Apple-only — it compiles on Apple and
shows up as a `Fidelity.Dropped` on Google. Which brings us to:

### 3.6 `Semantics` — meaning, not markup

Both platforms increasingly want *semantic* data (Apple semanticTags, Google
structured fields) to power Siri/Assistant/live activities. Instead of two
dialects, semantics attach to the pass or to fields:

```ts
Pass.seat({ section: "GA", row: Option.none(), seat: Option.none() })
Pass.venue({ name: "Kraftwerk Berlin", address: "Köpenicker Str. 70" })
```

These are the highest-leverage "new primitives": one declaration fans out to
`semantics.seats` on Apple and `eventTicketObject.seatInfo` on Google.

## 4. `Template` — the Class/Object split, made universal

Google natively splits design-time **Class** from per-user **Object**. Apple
doesn't — and every Apple integration reinvents the split badly. So it's
first-class: a `Template` is a `Schema` for the per-holder data plus a pure
function from that data to a pass.

```ts
class Attendee extends Schema.Class<Attendee>("Attendee")({
  name: Schema.NonEmptyString,
  ticketId: Schema.String,
  tier: Schema.Literals(["ga", "vip"])
}) {}

const EffectDays = Template.make({
  id: Template.Id("effect-days-2026"),
  data: Attendee,
  render: (a) =>
    Pass.eventTicket({
      serial: Pass.Serial(a.ticketId),
      description: `Effect Days 2026 — ${a.tier === "vip" ? "VIP" : "GA"}`
    }).pipe(
      Pass.primary(Field.text({ key: "name", label: "ATTENDEE", value: a.name })),
      Pass.barcode(Barcode.Qr({ content: a.ticketId })),
      sharedBranding // just a function Pass → Pass. Composition is function composition.
    )
})

// issue one
const pass = yield* Template.issue(EffectDays, { name: "Ada", ticketId: "TKT-1", tier: "vip" })
```

`Template.issue` decodes the input against `template.data`, renders it with
`template.render`, and runs it through `Pass.validate` — decode → render →
validate, failing with `Template.IssueError | Pass.ValidationError`.
`Template.issueAll` does the same over an `Iterable`, failing fast on the
first error and returning `Array<Pass>`.

Today, `Template` is a per-holder-data factory only — a Class/Object split
exists conceptually (`Template` ≍ Class, `Pass` ≍ Object) but there is no
`Template.sync` that upserts a Google Wallet class from a `Template` the way
`Google.sync` upserts a class/object pair from a fully-rendered `Pass`. See
"Roadmap" below.

And note what a `render` function is: **a component**. Which is the honest
answer to the JSX question — see §8.

## 5. Targets

### 5.1 Apple

```ts
import { Apple } from "effect-passkit"

const pkpass = yield* Apple.pkpass(pass)
// Effect<Apple.PkPass, Apple.PkpassError, Apple.Signer>
// PkpassError = Pass.ValidationError | Apple.AssetResolveError
//             | Apple.SigningError | Fidelity.UnsupportedError

// PkPass is the finished artifact — plain data, nothing HTTP-shaped:
pkpass.bytes        // Uint8Array — the signed zip
pkpass.contentType  // "application/vnd.apple.pkpass" (literal type)
```

The `Signer` is a service; expiry is *checked at layer construction* — your
deploy fails noisily, not your user's add-to-wallet tap:

```ts
const AppleLive = Apple.layer({
  teamId: "TEAM123456",
  passTypeId: "pass.com.acme.tickets",
  certificate: Apple.Certificate.pkcs12({
    bytes: p12Bytes,        // Uint8Array — read the .p12 yourself, e.g. Bun.file(path).arrayBuffer()
    password: "..."         // plain string; not Redacted today
  }),
  // or: Apple.Certificate.pem({ cert: leafPem, key: leafKeyPem })
  wwdr: wwdrPem              // REQUIRED — this library does not bundle Apple's WWDR cert (§ below)
})
```

`Apple.layerUnsigned` (aliased as the deprecated `Apple.layerNoop`) builds a
structurally-complete but **unsigned** bundle (`signature` is empty bytes) —
tests/CI only, never production.

Under the hood: manifest of SHA-1s, CMS/PKCS#7 detached signature (via
`node-forge`), zip. All invisible. The real tagged errors are
`Apple.CertificateExpiredError`, `Apple.AssetResolveError`,
`Apple.SigningError`, `Apple.CertificateError`, `Apple.WwdrCertificateError`
— see §9 for the full taxonomy.

### 5.2 Google

```ts
import { Google } from "effect-passkit"

const link = yield* Google.saveLink(pass)
// Effect<Google.SaveLink, Google.IssueError, Google.Issuer | Google.AssetHost>
link.url       // https://pay.google.com/gp/v/save/<jwt>  — JWT-embedded, no API call needed
link.jwt       // the signed token, if you want to render your own button

// or, for passes that must live server-side (updatable):
const result = yield* Google.sync(pass)
// Effect<Google.SyncResult, Google.SyncError, Google.Issuer | Google.AssetHost>
// { classId, objectId } — upserted via REST (GET, then POST on 404 or PATCH otherwise)
```

`Google.saveLink`/`Google.sync` always require `Google.AssetHost` in `R`,
even if every asset on the pass is already `Asset.Url` (see §3.4) — provide
`Google.AssetHost.layerNoop` in that case.

```ts
const GoogleLive = Google.layer({
  issuerId: "3388000000012345678",
  serviceAccount: { json: await Bun.file(saPath).text() }
})
```

### 5.3 `Wallet` — the two-for-one

```ts
const offer = yield* Wallet.issue(pass)
// Effect<Wallet.Offer, Apple.PkpassError | Google.IssueError,
//        Apple.Signer | Google.Issuer | Google.AssetHost>

offer.apple     // Apple.PkPass — { bytes, contentType }
offer.google    // Google.SaveLink — { url, jwt }
```

`Wallet.issue` is sugar, not magic — it's exactly `Effect.all({ apple:
Apple.pkpass(pass, ...), google: Google.saveLink(pass, ...) }, {
concurrency: "unbounded" })`, and the error/requirement unions say so. There
is no `offer.response` — content negotiation (choosing pkpass bytes vs. a
Google redirect from a User-Agent) is not shipped; see "Roadmap" below.

## 6. `Fidelity` — lossiness as data, not vibes

Cross-compilation is lossy. Beacons don't exist on Google; grouping doesn't
exist on Apple; a fifth secondary field fits nowhere. Silent dropping is a
lie and hard failure is hostile, so lossiness is a **value**:

```ts
const report = Fidelity.audit(pass)
// { apple: Fidelity.Finding[], google: Fidelity.Finding[] }
// Finding = Dropped | Approximated | Resized — each with a path and a reason

// and each target takes a policy:
Apple.pkpass(pass, { onUnsupported: "warn" })   // default: Effect.logWarning per finding
Google.saveLink(pass, { onUnsupported: "error" }) // fail with Fidelity.UnsupportedError
```

Run `Fidelity.audit` in a test and snapshot it: your CI now knows exactly
what each platform's users don't get.

## 7. Lifecycle — updates as a mountable API

A pass that never changes is a PDF. The hard part of PassKit is the
web-service protocol (device registration, update polling, APNs pushes).
`AppleWebService` (`src/AppleWebService.ts`) ships that as an `HttpApi`
group covering Apple's full five-endpoint spec (register/unregister a
device, list a device's updated serials, fetch a pass, log), backed by a
`Registry` service:

```ts
import { HttpApi } from "effect/unstable/httpapi"
import * as AppleWebService from "effect-passkit/AppleWebService"
import * as Registry from "effect-passkit/Registry"

const Api = HttpApi.make("api")
  .add(MyRoutes)
  .add(AppleWebService.group)

const WebServiceLive = AppleWebService.layer(Api).pipe(
  Layer.provide(AppleWebService.PassProvider.layer({
    authorize: ({ passTypeId, serial, authToken }) => lookupAndCheckToken(passTypeId, serial, authToken),
    passFor: ({ passTypeId, serial }) => lookupAndSign(passTypeId, serial)  // -> .pkpass bytes
  })),
  Layer.provide(Registry.layerMemory),
  Layer.provide(AppleWebService.layerNoop)   // Pusher: no-op until real APNs is wired (§ Roadmap)
)
```

`Registry.layerMemory` is a `Ref`-backed in-memory implementation for
dev/tests only — registrations do not survive a restart. Bring your own
(any layer providing the `Registry` service shape) for production.

There is no `Wallet.update` helper today — driving an update means calling
`Registry.markUpdated(serial)` (and, once real APNs is wired, notifying the
`Pusher`) yourself; devices then re-poll your mounted `AppleWebService` and
re-fetch the pass via `PassProvider.passFor`. See "Roadmap" below for what's
not yet shipped here.

## 8. The JSX question

JSX was seriously considered. The verdict: **the core is data, and JSX is an
optional dialect — not the foundation.** Three reasons:

1. **Passes are slots, not trees.** JSX's gift is arbitrary recursive
   children; a pass has five fixed slots with per-kind arities. Modeling
   "boarding passes have exactly two primary fields (origin, destination)"
   through `children: Element[]` throws away the type-level guarantees that
   are the whole point of writing this in TypeScript. The combinators keep
   those guarantees; JSX launders them into runtime checks.
2. **The "components" already exist.** A `Template.render` function *is* a
   component: pure data in, pass out. Shared branding is a `Pass → Pass`
   function. Composition is function composition — no reconciler, no no-op
   components, nothing to explain away.
3. **Nobody re-renders a pass.** JSX earns its complexity when a tree diffs
   against a stateful view. A pass compiles once per issue/update. There is
   no view to reconcile.

That said, because the IR is pure data, a JSX facade is ~200 lines and zero
runtime — `jsxImportSource: "effect-passkit/jsx"` where every element
constructs IR directly:

```tsx
const pass = (
  <EventTicket serial={id} description="Effect Days 2026">
    <Primary><Text key="event" label="EVENT">Effect Days 2026</Text></Primary>
    <Qr>{payload}</Qr>
  </EventTicket>
)  // : Pass — same IR, same targets, no reconciler
```

If it exists, it's `effect-passkit/jsx`, it's sugar, and the docs say so.

## 9. Error taxonomy

All `Data.TaggedError` (a couple are `Schema.ErrorClass`), unioned honestly
in signatures. The real `_tag`s shipped today:

```
Pass.ValidationError            "PassValidationError"     (DuplicateKey | SlotOverflow)
Fidelity.UnsupportedError        "FidelityUnsupportedError"

Apple.CertificateExpiredError    "AppleCertificateExpiredError"
Apple.CertificateError           "CertificateError"        (re-exported from internal/apple/certificate)
Apple.WwdrCertificateError       "WwdrCertificateError"    (re-exported from internal/apple/wwdr)
Apple.SigningError               "SigningError"            (re-exported from internal/apple/sign)
Apple.AssetResolveError          "AppleAssetResolveError"
AppleWebService.PassNotFoundError "ApplePassNotFoundError"

Google.MissingAssetHostError     "GoogleMissingAssetHostError"
Google.AssetUploadError          "GoogleAssetUploadError"
Google.ServiceAccountError       (internal/google/serviceAccount) "ServiceAccountError"
(internal) Jwt.JwtError          "JwtError"
(internal) Rest.TokenError       "GoogleTokenError"
(internal) Rest.ApiError         "GoogleApiError"

Template.IssueError              "TemplateIssueError"      (Schema.ErrorClass)
Registry.RegistryError           "RegistryError"
```

Each public entrypoint unions exactly what it can fail with —
e.g. `Apple.PkpassError = Pass.ValidationError | Apple.AssetResolveError |
Apple.SigningError | Fidelity.UnsupportedError`, `Google.IssueError` adds
`Google.MissingAssetHostError | Google.AssetUploadError | Jwt.JwtError |
ServiceAccountError`, and `Google.SyncError = Google.IssueError |
Rest.TokenError | Rest.ApiError`. Nothing throws. Nothing returns `null`.
`catchTag` works everywhere.

## 10. End to end

```ts
import { Effect, Layer, Config, Schema } from "effect"
import { Pass, Field, Barcode, Template, Apple, Google, Wallet } from "effect-passkit"

const program = Effect.gen(function* () {
  const pass = yield* Template.issue(EffectDays, {
    name: "Ada Lovelace", ticketId: "TKT-0001", tier: "vip"
  })
  const offer = yield* Wallet.issue(pass)
  yield* Effect.log(`Google save link: ${offer.google.url}`)
  return offer.apple.bytes
})

program.pipe(
  Effect.provide(Layer.mergeAll(AppleLive, GoogleLive)),
  Effect.runPromise
)
```

Test story: provide `Apple.layerUnsigned` (structural pkpass, unsigned
signature) and a real (or test-fixture) `Google.layer` +
`Google.AssetHost.layerNoop` — assert on the IR and the compiled JSON
without production certificates anywhere near CI. There is no
`Google.layerNoop`; Google's JWT signing always needs a service-account
key (a throwaway test fixture is fine).

---

## Roadmap (not yet shipped)

Everything below is either sketched in this document's prose, an interface
that exists with only a no-op implementation, or a design intent that hasn't
been built. None of it is available today — treat any earlier mention as
aspirational, not documentation of shipped behavior.

- **`Wallet.update` / real APNs push.** `AppleWebService.Pusher` is a real
  `Context.Service` interface (`notify: (args) => Effect<void, ...>`), but
  the only implementation shipped is `AppleWebService.layerNoop` — it does
  nothing. There is no `Wallet.update(serial, pass => ...)` convenience that
  fans an edit out to both an APNs push and a Google object PATCH; driving
  an update today means calling `Registry.markUpdated` yourself and (once a
  real `Pusher` is wired) notifying it, plus calling `Google.sync` again for
  Google.
- **`Template.sync`.** `Template` is a per-holder-data factory (schema +
  render) only. There's no method that upserts a Google Wallet *class* from
  a `Template` the way Google natively splits Class/Object — today
  `Google.sync` operates on a single fully-rendered `Pass` and upserts both
  the class and the object every call.
- **`offer.response` / content negotiation.** `Wallet.issue`'s `Offer` is
  exactly `{ apple: Apple.PkPass, google: Google.SaveLink }` — plain data,
  no `HttpServerResponse`. Choosing which artifact to serve based on the
  requesting device's User-Agent is left to the caller (see
  `examples/tickets.ts` for a manual example: separate `/pass/apple/:id` and
  `/pass/google/:id` routes).
- **`Registry.layerSql`.** Only `Registry.layerMemory` (an in-memory `Ref`)
  ships. A SQL-backed layer for `effect/unstable/sql` was sketched but not
  built; bring your own layer satisfying `Registry.RegistryShape` for
  production persistence.
- **JSX facade (`effect-passkit/jsx`).** Discussed at length in §8 as a
  deliberate non-foundation — a ~200-line, zero-runtime sugar layer over the
  IR. Not implemented; there is no `effect-passkit/jsx` export.
- **NFC / Smart Tap.** Apple's NFC pass entitlement and Google's Smart Tap
  collector-id story are both real, both platform-specific, and both
  unshipped. No `Pass.nfc` primitive exists yet.
- **`Field.changed` → Google Wallet notification.** The `changeMessage`
  compiles to Apple's native update-message mechanism; there is no
  equivalent Google Wallet push/notification wiring (`Google.push` does not
  exist).

## Open questions

- **Per-kind slot arity at the type level** — tuple-encoded slot capacities
  are doable but noisy; likely Schema-enforced with `filter`s first, type-level
  later if it earns it.
- **`@2x/@3x` generation** — auto-downscale from a single source via an
  optional `ImageOps` service, or stay explicit? Leaning explicit.
- **Live Activities / Smart Tap** — both platforms' NFC stories
  (`Apple.nfc` needs entitlement; Google Smart Tap needs collector id) are
  unifiable under a `Pass.nfc` primitive but shippable as target extensions
  first.
- **v4 beta drift** — `Context.Service` / httpapi are still `unstable`;
  signatures here track beta.97 idioms and will move with the beta.
