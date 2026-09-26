/**
 * The daemon identity's crypto (mint, fingerprint, sign, verify), written once
 * against `CryptoProvider`. Browser-safe: no `node:` import, no `Buffer`. The
 * file-backed `loadOrCreateIdentity` stays in the Node entry (./index.ts).
 *
 * Every function takes an optional trailing `crypto` provider, defaulting to
 * WebCrypto here; the Node entry point (./index.ts) defaults to `node:crypto`.
 */

import { base64Decode, base64Encode, toHex } from "../crypto/bytes.js"
import type { CryptoProvider } from "../crypto/types.js"
import { webCryptoProvider } from "../crypto/webcrypto.js"

/** Current identity-file schema version. */
export const IDENTITY_VERSION = 1 as const

/** Raised for every identity load/generate/sign/verify failure. The message
 *  is safe to surface — it never contains private key material. */
export class IdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "IdentityError"
  }
}

/** One keypair, both halves base64-DER. Public = SPKI, private = PKCS8. */
export interface IdentityKeyPair {
  /** base64 DER (SPKI) public key — publishable. */
  pub: string
  /** base64 DER (PKCS8) private key — secret. */
  priv: string
}

/**
 * A daemon's persistent identity. Serialized verbatim to
 * `~/.agentproto/identity.json` (0600). The `x25519` public half is the key a
 * client seals its hello to; the `ed25519` public half is the key a client
 * verifies the daemon's transcript signature against. Both public halves are
 * carried in the offer URL.
 */
export interface DaemonIdentity {
  v: typeof IDENTITY_VERSION
  /** Encryption / key-agreement keypair. */
  x25519: IdentityKeyPair
  /** Signing / authenticity keypair. */
  ed25519: IdentityKeyPair
  /** ISO-8601 creation timestamp. */
  createdAt: string
}

/** Mint a fresh daemon identity: one X25519 keypair (encryption) and one
 *  Ed25519 keypair (signing). */
export async function generateIdentity(crypto: CryptoProvider = webCryptoProvider): Promise<DaemonIdentity> {
  const [x, ed] = await Promise.all([crypto.x25519GenerateKeyPair(), crypto.ed25519GenerateKeyPair()])
  return {
    v: IDENTITY_VERSION,
    x25519: { pub: base64Encode(x.publicKey), priv: base64Encode(x.privateKey) },
    ed25519: { pub: base64Encode(ed.publicKey), priv: base64Encode(ed.privateKey) },
    createdAt: new Date().toISOString(),
  }
}

/** First 16 hex of `sha256(x25519 pub DER)` — the same construction as
 *  `sealKeyId`. Not a secret. */
export async function identityFingerprint(x25519Pub: string, crypto: CryptoProvider = webCryptoProvider): Promise<string> {
  return toHex(await crypto.sha256(base64Decode(x25519Pub))).slice(0, 16)
}

/** Sign a handshake transcript with an Ed25519 private key → base64 signature. */
export async function signTranscript(
  ed25519Priv: string,
  transcript: Uint8Array,
  crypto: CryptoProvider = webCryptoProvider,
): Promise<string> {
  let sig: Uint8Array
  try {
    sig = await crypto.ed25519Sign(base64Decode(ed25519Priv), transcript)
  } catch {
    throw new IdentityError("invalid ed25519 private key")
  }
  return base64Encode(sig)
}

/** Verify a transcript signature. Resolves false on a bad signature; rejects
 *  (IdentityError) only on a structurally invalid public key. */
export async function verifyTranscript(
  ed25519Pub: string,
  transcript: Uint8Array,
  signature: string,
  crypto: CryptoProvider = webCryptoProvider,
): Promise<boolean> {
  const pub = base64Decode(ed25519Pub)
  try {
    await crypto.ed25519ValidatePublicKey(pub)
  } catch {
    throw new IdentityError("invalid ed25519 public key")
  }
  return crypto.ed25519Verify(pub, transcript, base64Decode(signature))
}
