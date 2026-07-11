import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fromPem } from "../../../src/internal/apple/certificate.ts"
import { makeManifest } from "../../../src/internal/apple/manifest.ts"
import { signManifest } from "../../../src/internal/apple/sign.ts"
import { loadWwdrCertificate } from "../../../src/internal/apple/wwdr.ts"
import { makeTestChain, type TestChain } from "./testCerts.ts"

let chain: TestChain | undefined

afterEach(async () => {
  if (chain !== undefined) {
    await rm(chain.dir, { recursive: true, force: true })
    chain = undefined
  }
})

describe("signManifest", () => {
  test("produces a detached CMS signature verifiable by openssl against the manifest bytes", async () => {
    chain = await makeTestChain()
    const identity = await Effect.runPromise(fromPem(chain.leafPem, chain.leafKeyPem))
    const wwdr = await Effect.runPromise(loadWwdrCertificate(chain.wwdrPem))

    const files = new Map<string, Uint8Array>([
      ["pass.json", new TextEncoder().encode('{"formatVersion":1,"serialNumber":"abc"}')],
      ["icon.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])]
    ])
    const manifestBytes = makeManifest(files)

    const signature = await Effect.runPromise(signManifest(identity, wwdr, manifestBytes))
    expect(signature.length).toBeGreaterThan(0)

    const sigPath = join(chain.dir, "signature.der")
    const manifestPath = join(chain.dir, "manifest.json")
    await writeFile(sigPath, signature)
    await writeFile(manifestPath, manifestBytes)

    // Verify with the system openssl: signature is over manifest.json,
    // signer cert + WWDR are embedded in the CMS certificates set.
    // -noverify skips CA trust-chain validation (our root is a throwaway
    // test cert, not in any trust store) but still cryptographically
    // verifies the signature over the content and the cert chain linkage.
    const result = await $`openssl cms -verify -in ${sigPath} -inform DER -content ${manifestPath} -certfile ${join(chain.dir, "leaf.pem")} -noverify -out /dev/null`
      .quiet()
      .nothrow()

    expect(result.exitCode).toBe(0)
  })

  test("verification fails against tampered manifest bytes", async () => {
    chain = await makeTestChain()
    const identity = await Effect.runPromise(fromPem(chain.leafPem, chain.leafKeyPem))
    const wwdr = await Effect.runPromise(loadWwdrCertificate(chain.wwdrPem))

    const manifestBytes = makeManifest(
      new Map([["pass.json", new TextEncoder().encode('{"formatVersion":1}')]])
    )
    const signature = await Effect.runPromise(signManifest(identity, wwdr, manifestBytes))

    const sigPath = join(chain.dir, "signature.der")
    const tamperedPath = join(chain.dir, "tampered.json")
    await writeFile(sigPath, signature)
    await writeFile(tamperedPath, new TextEncoder().encode('{"formatVersion":2}'))

    const result = await $`openssl cms -verify -in ${sigPath} -inform DER -content ${tamperedPath} -certfile ${join(chain.dir, "leaf.pem")} -noverify -out /dev/null`
      .quiet()
      .nothrow()

    expect(result.exitCode).not.toBe(0)
  })

  test("includes both signer and WWDR certificates in the CMS certificates set", async () => {
    chain = await makeTestChain()
    const identity = await Effect.runPromise(fromPem(chain.leafPem, chain.leafKeyPem))
    const wwdr = await Effect.runPromise(loadWwdrCertificate(chain.wwdrPem))

    const manifestBytes = makeManifest(
      new Map([["pass.json", new TextEncoder().encode("{}")]])
    )
    const signature = await Effect.runPromise(signManifest(identity, wwdr, manifestBytes))

    const sigPath = join(chain.dir, "signature.der")
    await writeFile(sigPath, signature)

    const output = await $`openssl pkcs7 -in ${sigPath} -inform DER -print_certs -noout`.quiet().text()
    // Both the leaf ("Test Pass Type") and the WWDR stand-in ("Test WWDR")
    // subjects should appear among the embedded certificates.
    expect(output).toContain("Test Pass Type")
    expect(output).toContain("Test WWDR")
  })
})
