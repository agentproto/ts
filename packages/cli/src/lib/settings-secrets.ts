/**
 * Passphrase sealing for `agentproto settings export --include-secrets`.
 *
 * A settings bundle is plain JSON meant to be copied to another machine (or
 * shared with a paired device down the line). Auth-profile credentials never
 * ride in it in the clear — when the caller explicitly opts in with
 * `--include-secrets`, each requested profile's stored secret is sealed here
 * under a passphrase before it's embedded, so the bundle file itself is safe
 * to move over an untrusted channel; only someone who also has the
 * passphrase (communicated out of band) can recover the value.
 *
 * Construction: scrypt(passphrase, salt) → AES-256-GCM, the same primitive
 * pairing as `@agentproto/auth`'s `FileStore` (`store/file-store.ts`) uses
 * for its own at-rest secrets, just keyed by a passphrase instead of an env
 * var. Kept local to the CLI package (not `@agentproto/secrets`) — it's a
 * one-off envelope for this one export path, not a shared primitive yet.
 *
 * Sealing to a paired device's public key (AIP-59) instead of a passphrase
 * is deferred: it needs the device registry (a separate, parallel PR) to
 * resolve a device name to a public key first.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto"

const ALGORITHM = "aes-256-gcm"
const SALT_BYTES = 16
const IV_BYTES = 12
const KEY_BYTES = 32
// N=2**15 costs ~100ms on a modern laptop — deliberately expensive against
// offline guessing without making a one-off CLI invocation feel stuck.
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export interface SealedEnvelope {
  method: "passphrase"
  kdf: "scrypt"
  /** base64 */
  salt: string
  /** base64 */
  iv: string
  /** base64 */
  tag: string
  /** base64 */
  ciphertext: string
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_BYTES, SCRYPT_PARAMS)
}

/** Seal `plaintext` under `passphrase`. Fresh salt + IV every call. */
export function sealWithPassphrase(plaintext: string, passphrase: string): SealedEnvelope {
  const salt = randomBytes(SALT_BYTES)
  const key = deriveKey(passphrase, salt)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return {
    method: "passphrase",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }
}

/** Open an envelope sealed by {@link sealWithPassphrase}. Throws (AEAD tag
 *  failure) on the wrong passphrase or a tampered envelope. */
export function unsealWithPassphrase(envelope: SealedEnvelope, passphrase: string): string {
  if (envelope.method !== "passphrase" || envelope.kdf !== "scrypt") {
    throw new Error(
      `unsupported seal envelope (method=${envelope.method}, kdf=${envelope.kdf})`,
    )
  }
  const salt = Buffer.from(envelope.salt, "base64")
  const key = deriveKey(passphrase, salt)
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, "base64"))
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ])
  return plaintext.toString("utf8")
}
