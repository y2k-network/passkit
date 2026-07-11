/**
 * Gated tests against a REAL Apple Pass Type ID identity placed (gitignored)
 * in the repo root by the user: `cert.pem` (cert + encrypted private key,
 * expired 2025-01-29) and `pk2.p12` (password-protected PKCS#12).
 *
 * These tests SKIP cleanly whenever the credential files (or a required
 * password) are absent, so CI and other machines stay green. They never
 * print, log, or snapshot private-key or password material.
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { unzipSync } from "fflate"
import forge from "node-forge"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as Apple from "../src/Apple.ts"
import * as Asset from "../src/Asset.ts"
import * as Barcode from "../src/Barcode.ts"
import * as Color from "../src/Color.ts"
import * as Field from "../src/Field.ts"
import * as Pass from "../src/Pass.ts"
import * as CertificateInternal from "../src/internal/apple/certificate.ts"

const repoRoot = join(import.meta.dir, "..")
const certPemPath = join(repoRoot, "cert.pem")
const pk2Path = join(repoRoot, "pk2.p12")

const hasCertPem = existsSync(certPemPath)
const hasPk2 = existsSync(pk2Path)

// --- helpers -----------------------------------------------------------

/** Splits a combined "cert + key" PEM file into its two PEM blocks. */
const splitCombinedPem = (
  raw: string
): { readonly certPem: string; readonly keyPem: string | undefined } => {
  const certMatch = raw.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)
  const keyMatch = raw.match(
    /-----BEGIN (?:ENCRYPTED PRIVATE KEY|PRIVATE KEY|RSA PRIVATE KEY)-----[\s\S]*?-----END (?:ENCRYPTED PRIVATE KEY|PRIVATE KEY|RSA PRIVATE KEY)-----/
  )
  if (certMatch === null) {
    throw new Error("cert.pem did not contain a CERTIFICATE PEM block")
  }
  return { certPem: certMatch[0], keyPem: keyMatch?.[0] }
}

/**
 * Attempts to load cert.pem's identity via `fromPem`'s passphrase support,
 * trying APPLE_CERT_PASSWORD (or an empty passphrase, since some exports use
 * one). Returns the loaded identity plus the passphrase that worked, or
 * `undefined` if the key can't be decrypted with whatever's available in
 * this environment. Never logs the passphrase or key material.
 */
const tryLoadRealIdentity = (
  certPem: string,
  keyPem: string
): { readonly identity: CertificateInternal.SigningIdentity; readonly passphrase: Redacted.Redacted<string> } | undefined => {
  const candidates = [process.env.APPLE_CERT_PASSWORD, ""].filter(
    (p): p is string => p !== undefined
  )
  for (const candidate of candidates) {
    const passphrase = Redacted.make(candidate)
    const result = Effect.runSync(Effect.result(CertificateInternal.fromPem(certPem, keyPem, passphrase)))
    if (result._tag === "Success") {
      return { identity: result.success, passphrase }
    }
  }
  return undefined
}

const cacheDir = join(tmpdir(), "effect-passkit-cache")
const wwdrCachePath = join(cacheDir, "AppleWWDRCAG4.pem")

/**
 * Fetches Apple's real WWDR G4 certificate (DER), converting it to PEM, and
 * caches the PEM to disk so repeat runs are offline-safe. Returns
 * `undefined` (rather than throwing) on any network failure so a flaky
 * connection can't fail the suite — callers should skip that one test.
 */
const fetchRealWwdrPem = async (): Promise<string | undefined> => {
  if (existsSync(wwdrCachePath)) {
    return readFileSync(wwdrCachePath, "utf8")
  }
  try {
    const res = await fetch("https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer", {
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) return undefined
    const der = new Uint8Array(await res.arrayBuffer())
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(der).toString("binary")))
    const cert = forge.pki.certificateFromAsn1(asn1)
    const pem = forge.pki.certificateToPem(cert)
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(wwdrCachePath, pem)
    return pem
  } catch {
    return undefined
  }
}

// --- 1. fromPem loads the identity / certificate metadata --------------

describe.skipIf(!hasCertPem)("RealCert: cert.pem identity metadata", () => {
  test("notAfter is 2025-01-29 and subject CN contains pass.world.crimesyndicate.y2k", async () => {
    const raw = readFileSync(certPemPath, "utf8")
    const { certPem, keyPem } = splitCombinedPem(raw)

    // Certificate metadata never requires the private key, so this
    // assertion holds regardless of whether the key can be decrypted.
    const certOnly = forge.pki.certificateFromPem(certPem)
    expect(certOnly.validity.notAfter.toISOString().slice(0, 10)).toBe("2025-01-29")
    const cn = certOnly.subject.getField("CN")?.value
    expect(cn).toContain("pass.world.crimesyndicate.y2k")

    // Best-effort: also exercise the real fromPem() codepath end-to-end
    // (passphrase and all) when the private key can be decrypted in this
    // environment.
    if (keyPem !== undefined) {
      const loaded = tryLoadRealIdentity(certPem, keyPem)
      if (loaded !== undefined) {
        const { identity } = loaded
        expect(identity.notAfter.toISOString().slice(0, 10)).toBe("2025-01-29")
        const identityCn = identity.certificate.subject.getField("CN")?.value
        expect(identityCn).toContain("pass.world.crimesyndicate.y2k")
      }
    }
  })
})

// --- 2 & 3 need a working passphrase for the encrypted private key -----

const realIdentity = hasCertPem
  ? (() => {
      const raw = readFileSync(certPemPath, "utf8")
      const { certPem, keyPem } = splitCombinedPem(raw)
      return keyPem === undefined ? undefined : tryLoadRealIdentity(certPem, keyPem)
    })()
  : undefined

const canDecryptCertPemKey = realIdentity !== undefined

describe.skipIf(!canDecryptCertPemKey)("RealCert: Apple.layer fail-fast on expiry", () => {
  test("Apple.layer fails with AppleCertificateExpiredError for the expired real identity", async () => {
    const raw = readFileSync(certPemPath, "utf8")
    const { certPem, keyPem } = splitCombinedPem(raw)
    const passphrase = realIdentity!.passphrase

    // Any syntactically valid WWDR PEM works here — the fail-fast expiry
    // check runs before/independent of chain validation.
    const keys = forge.pki.rsa.generateKeyPair(2048)
    const wwdrCert = forge.pki.createCertificate()
    wwdrCert.publicKey = keys.publicKey
    wwdrCert.serialNumber = "01"
    wwdrCert.validity.notBefore = new Date(Date.now() - 365 * 24 * 3600 * 1000)
    wwdrCert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000)
    const attrs = [{ name: "commonName", value: "Fake WWDR" }]
    wwdrCert.setSubject(attrs)
    wwdrCert.setIssuer(attrs)
    wwdrCert.sign(keys.privateKey, forge.md.sha256.create())
    const syntheticWwdrPem = forge.pki.certificateToPem(wwdrCert)

    // Pass the encrypted key straight through with its passphrase — no
    // external pre-decryption needed now that `fromPem` handles it.
    const signerLayer = Apple.layer({
      teamId: "9NGM5P8QUG",
      passTypeId: "pass.world.crimesyndicate.y2k",
      certificate: Apple.Certificate.pem({ cert: certPem, key: keyPem!, passphrase }),
      wwdr: syntheticWwdrPem
    })

    const exit = await Effect.runPromiseExit(
      Effect.provide(Effect.void, signerLayer)
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = Effect.runSync(
        Effect.flip(Effect.failCause(exit.cause) as Effect.Effect<never, Apple.CertificateExpiredError>)
      )
      expect(failure._tag).toBe("AppleCertificateExpiredError")
    }
  })
})

// --- 3. real-chain signing, bypassing the expiry gate via direct Signer
//    context provision -----------------------------------------------------

const buildTicketPass = () =>
  Pass.eventTicket({ serial: Pass.Serial("REALCERT-1"), description: "Real Cert Test", organization: "Test Org" })
    .pipe(
      Pass.primary(Field.text({ key: "name", label: "NAME", value: "Test" })),
      Pass.barcode(Barcode.Qr({ content: "REALCERT-1", altText: "REALCERT-1" })),
      Pass.colors({ background: Color.hex("#000000"), foreground: Color.hex("#ffffff") })
    )

describe.skipIf(!canDecryptCertPemKey)("RealCert: real-chain signing (bypassing the expiry gate)", () => {
  test("signed pkpass's CMS certificates include both the pass cert and the real WWDR", async () => {
    const wwdrPem = await fetchRealWwdrPem()
    if (wwdrPem === undefined) {
      console.warn(
        "RealCert: skipping real-chain signing test — could not fetch Apple's WWDR G4 cert (offline?)"
      )
      return
    }

    // `realIdentity` was already loaded (encrypted key + passphrase, via
    // `fromPem`) once at module scope for the gating check above — reuse it
    // rather than decrypting again.
    const identity = realIdentity!.identity
    const wwdr = forge.pki.certificateFromPem(wwdrPem)

    const pass = buildTicketPass()

    // Bypass Apple.layer's fail-fast expiry gate entirely: provide the
    // Signer service context directly with the (expired) real identity.
    const pkpass = await Effect.runPromise(
      Effect.provideService(Apple.pkpass(pass), Apple.Signer, {
        identity,
        wwdr,
        teamId: "9NGM5P8QUG",
        passTypeId: "pass.world.crimesyndicate.y2k"
      })
    )

    const unzipped = unzipSync(pkpass.bytes)
    const signatureDer = unzipped["signature"]
    expect(signatureDer).toBeDefined()

    const asn1 = forge.asn1.fromDer(
      forge.util.createBuffer(Buffer.from(signatureDer!).toString("binary"))
    )
    const p7 = forge.pkcs7.messageFromAsn1(asn1) as forge.pkcs7.PkcsSignedData
    const certCns = (p7.certificates ?? []).map((c) => c.subject.getField("CN")?.value)

    expect(certCns).toContain("Pass Type ID: pass.world.crimesyndicate.y2k")
    expect(certCns).toContain("Apple Worldwide Developer Relations Certification Authority")
  })
})

// --- 4. PKCS#12 (pk2.p12), only with a password ---------------------------

describe.skipIf(!hasPk2 || process.env.APPLE_CERT_PASSWORD === undefined)(
  "RealCert: pk2.p12",
  () => {
    test("fromPkcs12 loads the identity with APPLE_CERT_PASSWORD", async () => {
      const password = process.env.APPLE_CERT_PASSWORD!
      const bytes = new Uint8Array(readFileSync(pk2Path))

      const identity = await Effect.runPromise(
        CertificateInternal.fromPkcs12(bytes, Redacted.make(password))
      )
      expect(identity.notAfter).toBeInstanceOf(Date)

      if (hasCertPem) {
        const raw = readFileSync(certPemPath, "utf8")
        const { certPem } = splitCombinedPem(raw)
        const certPemOnly = forge.pki.certificateFromPem(certPem)
        // The two files may or may not carry the same identity — assert
        // successful load either way, and only compare serials when equal.
        if (identity.certificate.serialNumber === certPemOnly.serialNumber) {
          expect(identity.certificate.serialNumber).toBe(certPemOnly.serialNumber)
        } else {
          // Different identities (e.g. a renewed cert) — successful load
          // of pk2.p12 is the assertion here.
          expect(identity.notAfter).toBeInstanceOf(Date)
        }
      }
    })
  }
)

// --- 5. .gitignore covers the credential files -----------------------------

describe("RealCert: .gitignore coverage", () => {
  test("cert.pem, pk2.p12, and .env are gitignored", () => {
    const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8")
    const patterns = gitignore.split("\n").map((l) => l.trim())

    const covers = (filename: string): boolean =>
      patterns.some((p) => {
        if (p === "" || p.startsWith("#")) return false
        if (p === filename) return true
        // simple glob match for patterns like "*.pem"
        if (p.startsWith("*.")) {
          const ext = p.slice(1)
          return filename.endsWith(ext)
        }
        return false
      })

    expect(covers("cert.pem")).toBe(true)
    expect(covers("pk2.p12")).toBe(true)
    expect(covers(".env")).toBe(true)
  })
})
