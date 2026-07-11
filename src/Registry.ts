/**
 * Storage abstraction for Apple Wallet device registrations (DESIGN.md §7).
 *
 * Implements the bookkeeping the Apple web-service protocol needs: which
 * devices are registered for which (passTypeIdentifier, serialNumber) pairs,
 * a push token per device to drive APNs, and a per-serial "last updated"
 * tag used to answer the incremental `passesUpdatedSince` polling query.
 *
 * `Registry.layerMemory` is an in-process `Ref`-backed implementation for
 * dev/tests. Bring your own (e.g. a SQL-backed one) for production by
 * providing the `Registry` service with the same shape.
 */
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"

// --- Errors ---

/** Raised when the underlying storage fails to read or write a registration. */
export class RegistryError extends Data.TaggedError("RegistryError")<{
  readonly cause?: unknown
  readonly message: string
}> {}

// --- Model ---

/** Identifies a single device's registration for a single pass. */
export interface RegistrationKey {
  readonly deviceLibraryId: string
  readonly pushToken: string
  readonly passTypeId: string
  readonly serial: string
}

/** The result of listing the serials a device is registered for. */
export interface SerialsForDevice {
  readonly serials: ReadonlyArray<string>
  /** Max `updatedAt` (epoch millis) across the returned serials, if any are registered. */
  readonly lastUpdated: number | undefined
}

// --- Registry service ---

/** The shape of the `Registry` service. */
export interface RegistryShape {
  /** Register a device for push updates to a pass. Idempotent. */
  readonly register: (
    args: RegistrationKey
  ) => Effect.Effect<void, RegistryError>

  /** Remove a device's registration for a pass. Idempotent. */
  readonly unregister: (
    args: { readonly deviceLibraryId: string; readonly passTypeId: string; readonly serial: string }
  ) => Effect.Effect<void, RegistryError>

  /**
   * List the serials a device is registered for under a pass type,
   * optionally filtered to those updated since `updatedSince` (an opaque
   * tag produced by `lastUpdated`, in practice epoch millis as a string).
   */
  readonly serialsForDevice: (
    args: {
      readonly deviceLibraryId: string
      readonly passTypeId: string
      readonly updatedSince?: number | undefined
    }
  ) => Effect.Effect<SerialsForDevice, RegistryError>

  /** Mark a serial as updated "now" — bumps it past any `updatedSince` filter. */
  readonly markUpdated: (serial: string) => Effect.Effect<void, RegistryError>
}

/**
 * The `Registry` service: device registration storage for the Apple
 * web-service protocol.
 */
export class Registry extends Context.Service<Registry, RegistryShape>()(
  "effect-passkit/Registry"
) {}

// --- layerMemory ---

interface MemoryState {
  /** deviceLibraryId|passTypeId|serial -> pushToken */
  readonly registrations: Map<string, string>
  /** serial -> updatedAt (epoch millis) */
  readonly updatedAt: Map<string, number>
}

const regKey = (deviceLibraryId: string, passTypeId: string, serial: string): string =>
  `${deviceLibraryId}|${passTypeId}|${serial}`

/**
 * An in-memory `Registry` backed by a `Ref`. Suitable for development and
 * tests; registrations do not survive process restart.
 */
export const layerMemory: Layer.Layer<Registry> = Layer.effect(
  Registry,
  Effect.gen(function*() {
    const state = yield* Ref.make<MemoryState>({
      registrations: new Map(),
      updatedAt: new Map()
    })

    const register: RegistryShape["register"] = (args) =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        yield* Ref.update(state, (s) => {
          const registrations = new Map(s.registrations)
          registrations.set(regKey(args.deviceLibraryId, args.passTypeId, args.serial), args.pushToken)
          const updatedAt = new Map(s.updatedAt)
          if (!updatedAt.has(args.serial)) updatedAt.set(args.serial, now)
          return { registrations, updatedAt }
        })
      })

    const unregister: RegistryShape["unregister"] = (args) =>
      Ref.update(state, (s) => {
        const registrations = new Map(s.registrations)
        registrations.delete(regKey(args.deviceLibraryId, args.passTypeId, args.serial))
        return { registrations, updatedAt: s.updatedAt }
      })

    const serialsForDevice: RegistryShape["serialsForDevice"] = (args) =>
      Effect.map(Ref.get(state), (s) => {
        const prefix = `${args.deviceLibraryId}|${args.passTypeId}|`
        const serials: Array<string> = []
        let lastUpdated: number | undefined = undefined

        for (const key of s.registrations.keys()) {
          if (!key.startsWith(prefix)) continue
          const serial = key.slice(prefix.length)
          const updatedAt = s.updatedAt.get(serial) ?? 0
          if (args.updatedSince !== undefined && updatedAt <= args.updatedSince) continue
          serials.push(serial)
          if (lastUpdated === undefined || updatedAt > lastUpdated) lastUpdated = updatedAt
        }

        return { serials, lastUpdated }
      })

    const markUpdated: RegistryShape["markUpdated"] = (serial) =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        yield* Ref.update(state, (s) => {
          const updatedAt = new Map(s.updatedAt)
          updatedAt.set(serial, now)
          return { registrations: s.registrations, updatedAt }
        })
      })

    return { register, unregister, serialsForDevice, markUpdated }
  })
)
