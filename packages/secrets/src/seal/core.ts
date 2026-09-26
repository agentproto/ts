/**
 * The seal box, written once against `CryptoProvider` — see ./index.ts for the
 * construction and the Node entry, and `@agentproto/secrets/pairing/browser`
 * for the browser one. Browser-safe: no `node:` import, no `Buffer`.
 *
 * Every function takes an optional trailing `crypto` provider, defaulting to
 * WebCrypto here; the Node entry point (./index.ts) defaults to `node:crypto`.
 */

import {
  base64Decode,
  base64Encode,
  concatBytes,
  toHex,
  utf8Decode,
  utf8Encode,
} from "../crypto/bytes.js"
import type { CryptoProvider } from "../crypto/types.js"
import { webCryptoProvider } from "../crypto/webcrypto.js"

/** Versioned algorithm tag embedded in every envelope so the format can
 *  evolve without ambiguity at the unseal site. */
export const SEAL_ALG = "x25519-hkdf-sha256-aes256gcm" as const
export const SEAL_VERSION = 1 as const

const HKDF_INFO = utf8Encode("agentproto/secrets/seal v1")
const IV_LEN = 12
const TAG_LEN = 16

/** Raised for every seal/unseal failure. The message is safe to surface —
 *  it never contains key material or plaintext. */
export class SealError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SealError"
  }
}

/** An X25519 keypair for sealing. Both halves are base64-encoded DER so they
 *  travel as plain strings (env vars, JSON, config). The public half is safe
 *  to publish; the private half must stay with the unseal boundary. */
export interface SealKeyPair {
  /** base64 DER (SPKI) X25519 public key — publishable. */
  publicKey: string
  /** base64 DER (PKCS8) X25519 private key — secret. */
  privateKey: string
}

interface SealEnvelope {
  v: number
  alg: string
  /** ephemeral public key, base64 DER (SPKI) */
  epk: string
  /** AES-GCM iv, base64 (12 bytes) */
  iv: string
  /** ciphertext, base64 */
  ct: string
  /** AES-GCM auth tag, base64 (16 bytes) */
  tag: string
}

/** Mint a fresh sealing keypair. */
export async function generateSealKeyPair(crypto: CryptoProvider = webCryptoProvider): Promise<SealKeyPair> {
  const kp = await crypto.x25519GenerateKeyPair()
  return { publicKey: base64Encode(kp.publicKey), privateKey: base64Encode(kp.privateKey) }
}

/** Derive the publishable public key from a stored private key. */
export async function sealingPublicKey(privateKey: string, crypto: CryptoProvider = webCryptoProvider): Promise<string> {
  try {
    return base64Encode(await crypto.x25519PublicKeyFromPrivate(base64Decode(privateKey)))
  } catch {
    throw new SealError("invalid private key")
  }
}

/** Stable short identifier for a sealing key: first 16 hex of
 *  `sha256(public DER)`. Not a secret. */
export async function sealKeyId(publicKey: string, crypto: CryptoProvider = webCryptoProvider): Promise<string> {
  return toHex(await crypto.sha256(base64Decode(publicKey))).slice(0, 16)
}

// The key-derivation salt binds the symmetric key to BOTH the ephemeral and
// the recipient public key (sealed-box style) so a derived key is unique to a
// single (ephemeral, recipient) pair and can't be transplanted.
function deriveKey(
  crypto: CryptoProvider,
  shared: Uint8Array,
  epkDer: Uint8Array,
  rpkDer: Uint8Array,
): Promise<Uint8Array> {
  return crypto.hkdfSha256(shared, concatBytes(epkDer, rpkDer), HKDF_INFO, 32)
}

/** Seal a plaintext value to a recipient's public key. */
export async function seal(
  plaintext: string | Uint8Array,
  recipientPublicKey: string,
  crypto: CryptoProvider = webCryptoProvider,
): Promise<string> {
  const rpkDer = base64Decode(recipientPublicKey)
  try {
    await crypto.x25519ValidatePublicKey(rpkDer)
  } catch {
    throw new SealError("invalid recipient public key")
  }
  const ephemeral = await crypto.x25519GenerateKeyPair()
  const shared = await crypto.x25519(ephemeral.privateKey, rpkDer)
  const key = await deriveKey(crypto, shared, ephemeral.publicKey, rpkDer)

  const iv = crypto.randomBytes(IV_LEN)
  const pt = typeof plaintext === "string" ? utf8Encode(plaintext) : plaintext
  const sealed = await crypto.aesGcmEncrypt(key, iv, pt)

  const envelope: SealEnvelope = {
    v: SEAL_VERSION,
    alg: SEAL_ALG,
    epk: base64Encode(ephemeral.publicKey),
    iv: base64Encode(iv),
    ct: base64Encode(sealed.subarray(0, sealed.length - TAG_LEN)),
    tag: base64Encode(sealed.subarray(sealed.length - TAG_LEN)),
  }
  return base64Encode(utf8Encode(JSON.stringify(envelope)))
}

/** Open a sealed envelope with the recipient's private key. */
export async function unseal(sealed: string, privateKey: string, crypto: CryptoProvider = webCryptoProvider): Promise<string> {
  let envelope: SealEnvelope
  try {
    envelope = JSON.parse(utf8Decode(base64Decode(sealed)))
  } catch {
    throw new SealError("malformed sealed envelope")
  }
  if (envelope.v !== SEAL_VERSION || envelope.alg !== SEAL_ALG) {
    throw new SealError(`unsupported sealed envelope (v=${envelope.v} alg=${envelope.alg})`)
  }

  const priv = base64Decode(privateKey)
  let rpkDer: Uint8Array
  try {
    rpkDer = await crypto.x25519PublicKeyFromPrivate(priv)
  } catch {
    throw new SealError("invalid private key")
  }
  const epkDer = base64Decode(envelope.epk)
  let shared: Uint8Array
  try {
    await crypto.x25519ValidatePublicKey(epkDer)
    shared = await crypto.x25519(priv, epkDer)
  } catch {
    throw new SealError("malformed ephemeral key in envelope")
  }
  const key = await deriveKey(crypto, shared, epkDer, rpkDer)

  try {
    const pt = await crypto.aesGcmDecrypt(
      key,
      base64Decode(envelope.iv),
      concatBytes(base64Decode(envelope.ct), base64Decode(envelope.tag)),
    )
    return utf8Decode(pt)
  } catch {
    throw new SealError("unseal failed — wrong key or tampered ciphertext")
  }
}
