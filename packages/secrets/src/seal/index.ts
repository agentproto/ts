/**
 * @agentproto/secrets/seal — anonymous public-key sealing for secret values.
 *
 * A "sealed box": encrypt a secret TO a recipient's public key such that only
 * the holder of the matching private key can open it. The sender needs only
 * the public key, and the sealed envelope reveals nothing about the sender.
 *
 * The point is custody. A secret value (a CLI subscription token, an API key)
 * can be sealed on the machine that holds it, then handed to ANY intermediary
 * — a relay, an agent, a log — as opaque ciphertext, because only the server's
 * private key can recover the plaintext. The plaintext never has to exist
 * anywhere but the origin machine and, transiently, inside the recipient's
 * unseal boundary.
 *
 * Construction (ECIES, no native dep):
 *   - X25519 ephemeral key agreement with the recipient's public key
 *   - HKDF-SHA256 over the shared secret, salted by both public keys
 *   - AES-256-GCM AEAD for the payload (authenticated; tampering fails closed)
 *
 * This is the same shape as libsodium's `crypto_box_seal`. The construction
 * lives once in ./core.ts against a `CryptoProvider`; this Node entry defaults
 * to `node:crypto`, and `@agentproto/secrets/pairing/browser` re-exports the
 * same code over WebCrypto. Every function is async (WebCrypto is) and takes an
 * optional trailing `crypto` to override the provider.
 *
 * Sealing (confidentiality) is NOT signing (authenticity): this hides the
 * value, it does not prove who sent it. Bind the sender separately (e.g. an
 * authenticated transport) when provenance matters.
 */

import { nodeCryptoProvider } from "../crypto/node.js"
import type { CryptoProvider } from "../crypto/types.js"
import * as core from "./core.js"

export { SEAL_ALG, SEAL_VERSION, SealError, type SealKeyPair } from "./core.js"
export type { CryptoProvider } from "../crypto/types.js"

/**
 * Mint a fresh sealing keypair. The recipient (e.g. a server) generates this
 * once, stores `privateKey` in its own secret store, and publishes
 * `publicKey` for senders to seal against.
 */
export function generateSealKeyPair(crypto: CryptoProvider = nodeCryptoProvider): Promise<core.SealKeyPair> {
  return core.generateSealKeyPair(crypto)
}

/**
 * Derive the publishable public key from a stored private key. Lets a
 * recipient hold only the private half (one secret) and serve the public
 * half on demand — the seal-key a sender needs.
 */
export function sealingPublicKey(privateKey: string, crypto: CryptoProvider = nodeCryptoProvider): Promise<string> {
  return core.sealingPublicKey(privateKey, crypto)
}

/**
 * Stable short identifier for a sealing key, derived from the public key.
 * Lets the seal-key endpoint and the sealed envelope name which key was used
 * so rotation is unambiguous. Not a secret.
 */
export function sealKeyId(publicKey: string, crypto: CryptoProvider = nodeCryptoProvider): Promise<string> {
  return core.sealKeyId(publicKey, crypto)
}

/**
 * Seal a plaintext value to a recipient's public key. Resolves to a single
 * base64 string (the envelope) that only the matching private key can open.
 * The sender needs nothing but the public key.
 */
export function seal(
  plaintext: string | Uint8Array,
  recipientPublicKey: string,
  crypto: CryptoProvider = nodeCryptoProvider,
): Promise<string> {
  return core.seal(plaintext, recipientPublicKey, crypto)
}

/**
 * Open a sealed envelope with the recipient's private key, resolving to the
 * original UTF-8 plaintext. Rejects with `SealError` on a malformed envelope,
 * an unsupported version/alg, the wrong key, or any tampering (the AEAD tag
 * fails closed — a modified ciphertext never decrypts to garbage, it throws).
 */
export function unseal(sealed: string, privateKey: string, crypto: CryptoProvider = nodeCryptoProvider): Promise<string> {
  return core.unseal(sealed, privateKey, crypto)
}
