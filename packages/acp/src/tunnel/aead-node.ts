/**
 * `E2eAead` over `node:crypto` — the default through the `@agentproto/acp/tunnel`
 * Node entry. The exact cipher calls `wrapE2E` made before the AEAD seam.
 */

import { createCipheriv, createDecipheriv } from "node:crypto"
import type { E2eAead } from "./aead.js"

const TAG_LEN = 16

export const nodeAead: E2eAead = {
  aesGcmEncrypt: async (key, iv, plaintext, aad) => {
    const cipher = createCipheriv("aes-256-gcm", key, iv)
    if (aad) cipher.setAAD(aad)
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  },
  aesGcmDecrypt: async (key, iv, sealed, aad) => {
    if (sealed.length < TAG_LEN) throw new Error("ciphertext shorter than the GCM tag")
    const decipher = createDecipheriv("aes-256-gcm", key, iv)
    if (aad) decipher.setAAD(aad)
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_LEN))
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_LEN)), decipher.final()])
  },
}
