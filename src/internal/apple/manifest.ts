/**
 * Apple .pkpass manifest.json construction.
 *
 * The manifest is a JSON object mapping every file in the pass bundle
 * (except manifest.json and signature) to the SHA-1 hex digest of its
 * bytes. This module is pure — no Effect, no I/O — so callers can build it
 * synchronously from an in-memory file map.
 */

/**
 * Computes the SHA-1 hex digest of a byte array using Bun's built-in
 * CryptoHasher (falls back to `node:crypto` if `Bun` is not present, e.g.
 * under a non-Bun test runner).
 */
const sha1Hex = (bytes: Uint8Array): string => {
  const BunGlobal = (globalThis as { Bun?: typeof Bun }).Bun
  if (BunGlobal !== undefined) {
    const hasher = new BunGlobal.CryptoHasher("sha1")
    hasher.update(bytes)
    return hasher.digest("hex")
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require("node:crypto") as typeof import("node:crypto")
  return nodeCrypto.createHash("sha1").update(bytes).digest("hex")
}

/**
 * The decoded shape of an Apple pass manifest: file name -> SHA-1 hex digest.
 */
export type ManifestJson = Readonly<Record<string, string>>

/**
 * Builds the manifest JSON object (file name -> SHA-1 hex digest) for a set
 * of pass bundle files. Pure — does not include manifest.json or signature
 * themselves; callers are expected to pass only the files that belong in the
 * signed bundle (pass.json, images, localization strings, etc).
 */
export const makeManifestJson = (files: ReadonlyMap<string, Uint8Array>): ManifestJson => {
  const entries: Array<[string, string]> = []
  for (const [name, bytes] of files) {
    entries.push([name, sha1Hex(bytes)])
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return Object.fromEntries(entries)
}

/**
 * Builds the manifest.json bytes (UTF-8 encoded JSON) for a set of pass
 * bundle files.
 */
export const makeManifest = (files: ReadonlyMap<string, Uint8Array>): Uint8Array => {
  const json = makeManifestJson(files)
  return new TextEncoder().encode(JSON.stringify(json))
}
