/**
 * Test helper: generates a throwaway 2-cert chain (self-signed "WWDR" root
 * + a leaf "Pass Type ID" cert signed by it) using the system `openssl`
 * binary via `Bun.$`, plus a PKCS#12 bundle of the leaf.
 */
import { $ } from "bun"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface TestChain {
  readonly dir: string
  readonly wwdrPem: string
  readonly leafPem: string
  readonly leafKeyPem: string
  readonly p12Bytes: Uint8Array
  readonly p12Password: string
  /** The leaf private key, PKCS#8-encrypted with `encryptedLeafKeyPassword`. */
  readonly encryptedLeafKeyPem: string
  readonly encryptedLeafKeyPassword: string
}

export const makeTestChain = async (): Promise<TestChain> => {
  const dir = await mkdtemp(join(tmpdir(), "effect-passkit-apple-test-"))
  const p12Password = "test1234"
  const encryptedLeafKeyPassword = "test5678"

  await $`openssl req -x509 -newkey rsa:2048 -keyout ${dir}/wwdr_key.pem -out ${dir}/wwdr.pem -days 3650 -nodes -subj "/CN=Test WWDR"`.quiet()
  await $`openssl req -newkey rsa:2048 -keyout ${dir}/leaf_key.pem -out ${dir}/leaf.csr -nodes -subj "/CN=Test Pass Type"`.quiet()
  await $`openssl x509 -req -in ${dir}/leaf.csr -CA ${dir}/wwdr.pem -CAkey ${dir}/wwdr_key.pem -CAcreateserial -out ${dir}/leaf.pem -days 3650`.quiet()
  await $`openssl pkcs12 -export -out ${dir}/identity.p12 -inkey ${dir}/leaf_key.pem -in ${dir}/leaf.pem -passout pass:${p12Password}`.quiet()
  await $`openssl pkcs8 -topk8 -v2 aes-256-cbc -in ${dir}/leaf_key.pem -out ${dir}/leaf_key_encrypted.pem -passout pass:${encryptedLeafKeyPassword}`.quiet()

  const [wwdrPem, leafPem, leafKeyPem, p12Buf, encryptedLeafKeyPem] = await Promise.all([
    readFile(join(dir, "wwdr.pem"), "utf8"),
    readFile(join(dir, "leaf.pem"), "utf8"),
    readFile(join(dir, "leaf_key.pem"), "utf8"),
    readFile(join(dir, "identity.p12")),
    readFile(join(dir, "leaf_key_encrypted.pem"), "utf8")
  ])

  return {
    dir,
    wwdrPem,
    leafPem,
    leafKeyPem,
    p12Bytes: new Uint8Array(p12Buf),
    p12Password,
    encryptedLeafKeyPem,
    encryptedLeafKeyPassword
  }
}
