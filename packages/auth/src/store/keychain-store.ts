/**
 * KeychainStore — `CredentialStore` backed by the platform Keychain.
 *
 * Wraps the low-level `token-store.ts` helpers (macOS `security` CLI today).
 * The Keychain only holds one opaque string per entry, so `kind`/`expiresAt`/
 * `metadata` are packed into a small JSON envelope that IS that string.
 *
 * Back-compat: an entry written before this store existed (or by any other
 * tool) is a bare token string, not an envelope. `read` falls back to
 * treating the whole string as the value with kind `"pat"` — the only flow
 * that pre-dates this store — rather than failing on non-JSON content.
 */

import { z } from "zod"
import {
  deleteKeychainToken,
  readKeychainToken,
  writeKeychainToken,
} from "../token-store.js"
import type { CredentialStore, StoreRef, StoredCredential } from "./types.js"

const envelopeSchema = z.object({
  v: z.string(),
  k: z.enum(["pat", "assertion", "oat", "daemon"]),
  e: z.string().optional(),
  m: z.record(z.string(), z.unknown()).optional(),
})

export class KeychainStore implements CredentialStore {
  async read(ref: StoreRef): Promise<StoredCredential | undefined> {
    const account = ref.account ?? ref.path
    const raw = await readKeychainToken(ref.path, account)
    if (raw === undefined) return undefined

    try {
      const envelope = envelopeSchema.parse(JSON.parse(raw))
      return {
        value: envelope.v,
        kind: envelope.k,
        ...(envelope.e !== undefined ? { expiresAt: envelope.e } : {}),
        ...(envelope.m !== undefined ? { metadata: envelope.m } : {}),
      }
    } catch {
      return { value: raw, kind: "pat" }
    }
  }

  async write(ref: StoreRef, cred: StoredCredential): Promise<void> {
    const account = ref.account ?? ref.path
    const envelope: z.infer<typeof envelopeSchema> = {
      v: cred.value,
      k: cred.kind,
      ...(cred.expiresAt !== undefined ? { e: cred.expiresAt } : {}),
      ...(cred.metadata !== undefined ? { m: cred.metadata } : {}),
    }
    await writeKeychainToken(ref.path, account, JSON.stringify(envelope))
  }

  async delete(ref: StoreRef): Promise<void> {
    const account = ref.account ?? ref.path
    await deleteKeychainToken(ref.path, account)
  }
}
