/**
 * Zip archive assembly for the .pkpass bundle.
 *
 * Uses fflate's synchronous zip writer (`zipSync`) — small, dependency-free,
 * and Bun-compatible. Pure — no I/O.
 */
import { zipSync } from "fflate"

/**
 * Builds a zip archive (as raw bytes) from a map of entry name -> bytes.
 * Entries are stored with fflate's default DEFLATE compression. The
 * resulting archive is suitable for use as a .pkpass file once it contains
 * pass.json, manifest.json, signature, and any images.
 */
export const makeZip = (files: ReadonlyMap<string, Uint8Array>): Uint8Array => {
  const zippable: Record<string, Uint8Array> = {}
  for (const [name, bytes] of files) {
    zippable[name] = bytes
  }
  return zipSync(zippable, { level: 6 })
}
