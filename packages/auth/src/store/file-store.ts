/**
 * FileStore — encrypted-JSON-file `CredentialStore`.
 *
 * Every entry is sealed independently with AES-256-GCM under a key read from
 * `AGENTPROTO_STORE_KEY` (hex or base64, 32 raw bytes). There is no plaintext
 * fallback: a missing or malformed key throws rather than writing credentials
 * to disk in the clear.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import type { CredentialStore, StoreRef, StoredCredential } from "./types.js"

const ALGORITHM = "aes-256-gcm"
const KEY_ENV_VAR = "AGENTPROTO_STORE_KEY"
const IV_BYTES = 12

const sealedEntrySchema = z.object({
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
})
type SealedEntry = z.infer<typeof sealedEntrySchema>

const sealedFileSchema = z.record(z.string(), sealedEntrySchema)

const storedCredentialSchema = z.object({
  value: z.string(),
  kind: z.enum(["pat", "assertion", "oat", "daemon"]),
  expiresAt: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

function keyOf(ref: StoreRef): string {
  return `${ref.path} ${ref.account ?? ref.path}`
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "ENOENT"
  )
}

/** Decode `AGENTPROTO_STORE_KEY` (hex or base64) into exactly 32 raw bytes. */
function loadKey(): Buffer {
  const raw = process.env[KEY_ENV_VAR]
  if (!raw) {
    throw new Error(
      `FileStore: missing ${KEY_ENV_VAR} — set a 32-byte key (64 hex chars, ` +
        `or base64) to use the encrypted file store. Refusing to store ` +
        `credentials in plaintext.`,
    )
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64")
  if (key.length !== 32) {
    throw new Error(
      `FileStore: ${KEY_ENV_VAR} must decode to exactly 32 bytes (got ` +
        `${key.length}). Provide a 64-char hex string or base64 encoding 32 bytes.`,
    )
  }
  return key
}

function seal(key: Buffer, plaintext: string): SealedEntry {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }
}

function unseal(key: Buffer, entry: SealedEntry): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(entry.iv, "base64"),
  )
  decipher.setAuthTag(Buffer.from(entry.tag, "base64"))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(entry.ciphertext, "base64")),
    decipher.final(),
  ])
  return plaintext.toString("utf8")
}

export class FileStore implements CredentialStore {
  constructor(private readonly filePath: string) {}

  async read(ref: StoreRef): Promise<StoredCredential | undefined> {
    const key = loadKey()
    const file = await this.readFile()
    const sealed = file[keyOf(ref)]
    if (!sealed) return undefined
    return storedCredentialSchema.parse(JSON.parse(unseal(key, sealed)))
  }

  async write(ref: StoreRef, cred: StoredCredential): Promise<void> {
    const key = loadKey()
    const file = await this.readFile()
    file[keyOf(ref)] = seal(key, JSON.stringify(cred))
    await this.writeFile(file)
  }

  async delete(ref: StoreRef): Promise<void> {
    const file = await this.readFile()
    delete file[keyOf(ref)]
    await this.writeFile(file)
  }

  private async readFile(): Promise<Record<string, SealedEntry>> {
    try {
      const raw = await readFile(this.filePath, "utf8")
      return sealedFileSchema.parse(JSON.parse(raw))
    } catch (err) {
      if (isEnoent(err)) return {}
      throw err
    }
  }

  private async writeFile(file: Record<string, SealedEntry>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(file, null, 2), "utf8")
  }
}
