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
 * Construction (ECIES, Node built-ins only — no native dep):
 *   - X25519 ephemeral key agreement with the recipient's public key
 *   - HKDF-SHA256 over the shared secret, salted by both public keys
 *   - AES-256-GCM AEAD for the payload (authenticated; tampering fails closed)
 *
 * This is the same shape as libsodium's `crypto_box_seal`, expressed in terms
 * of Node's `crypto` so the package keeps its zero-native-dependency footprint.
 *
 * Sealing (confidentiality) is NOT signing (authenticity): this hides the
 * value, it does not prove who sent it. Bind the sender separately (e.g. an
 * authenticated transport) when provenance matters.
 */

import {
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  createHash,
  diffieHellman,
  hkdfSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto"

/** Versioned algorithm tag embedded in every envelope so the format can
 *  evolve without ambiguity at the unseal site. */
export const SEAL_ALG = "x25519-hkdf-sha256-aes256gcm" as const
export const SEAL_VERSION = 1 as const

const HKDF_INFO = "agentproto/secrets/seal v1"

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

/**
 * Mint a fresh sealing keypair. The recipient (e.g. a server) generates this
 * once, stores `privateKey` in its own secret store, and publishes
 * `publicKey` for senders to seal against.
 */
export function generateSealKeyPair(): SealKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519")
  return {
    publicKey: publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64"),
    privateKey: privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64"),
  }
}

/**
 * Derive the publishable public key from a stored private key. Lets a
 * recipient hold only the private half (one secret) and serve the public
 * half on demand — the seal-key a sender needs.
 */
export function sealingPublicKey(privateKey: string): string {
  let priv
  try {
    priv = createPrivateKey({
      key: Buffer.from(privateKey, "base64"),
      format: "der",
      type: "pkcs8",
    })
  } catch {
    throw new SealError("invalid private key")
  }
  return createPublicKey(priv)
    .export({ type: "spki", format: "der" })
    .toString("base64")
}

/**
 * Stable short identifier for a sealing key, derived from the public key.
 * Lets the seal-key endpoint and the sealed envelope name which key was used
 * so rotation is unambiguous. Not a secret.
 */
export function sealKeyId(publicKey: string): string {
  return createHash("sha256")
    .update(Buffer.from(publicKey, "base64"))
    .digest("hex")
    .slice(0, 16)
}

// The key-derivation salt binds the symmetric key to BOTH the ephemeral and
// the recipient public key (sealed-box style) so a derived key is unique to a
// single (ephemeral, recipient) pair and can't be transplanted.
function deriveKey(shared: Buffer, epkDer: Buffer, rpkDer: Buffer): Buffer {
  const salt = Buffer.concat([epkDer, rpkDer])
  return Buffer.from(hkdfSync("sha256", shared, salt, HKDF_INFO, 32))
}

/**
 * Seal a plaintext value to a recipient's public key. Returns a single
 * base64 string (the envelope) that only the matching private key can open.
 * The sender needs nothing but the public key.
 */
export function seal(
  plaintext: string | Uint8Array,
  recipientPublicKey: string
): string {
  let recipient
  try {
    recipient = createPublicKey({
      key: Buffer.from(recipientPublicKey, "base64"),
      format: "der",
      type: "spki",
    })
  } catch {
    throw new SealError("invalid recipient public key")
  }
  const ephemeral = generateKeyPairSync("x25519")
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipient,
  })
  const epkDer = ephemeral.publicKey.export({ type: "spki", format: "der" })
  const rpkDer = recipient.export({ type: "spki", format: "der" })
  const key = deriveKey(shared, epkDer, rpkDer)

  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const pt =
    typeof plaintext === "string"
      ? Buffer.from(plaintext, "utf8")
      : Buffer.from(plaintext)
  const ct = Buffer.concat([cipher.update(pt), cipher.final()])
  const tag = cipher.getAuthTag()

  const envelope: SealEnvelope = {
    v: SEAL_VERSION,
    alg: SEAL_ALG,
    epk: epkDer.toString("base64"),
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: tag.toString("base64"),
  }
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64")
}

/**
 * Open a sealed envelope with the recipient's private key, returning the
 * original UTF-8 plaintext. Throws `SealError` on a malformed envelope, an
 * unsupported version/alg, the wrong key, or any tampering (the AEAD tag
 * fails closed — a modified ciphertext never decrypts to garbage, it throws).
 */
export function unseal(sealed: string, privateKey: string): string {
  let envelope: SealEnvelope
  try {
    envelope = JSON.parse(Buffer.from(sealed, "base64").toString("utf8"))
  } catch {
    throw new SealError("malformed sealed envelope")
  }
  if (envelope.v !== SEAL_VERSION || envelope.alg !== SEAL_ALG) {
    throw new SealError(
      `unsupported sealed envelope (v=${envelope.v} alg=${envelope.alg})`
    )
  }

  let priv
  try {
    priv = createPrivateKey({
      key: Buffer.from(privateKey, "base64"),
      format: "der",
      type: "pkcs8",
    })
  } catch {
    throw new SealError("invalid private key")
  }
  let ephemeral
  try {
    ephemeral = createPublicKey({
      key: Buffer.from(envelope.epk, "base64"),
      format: "der",
      type: "spki",
    })
  } catch {
    throw new SealError("malformed ephemeral key in envelope")
  }

  const shared = diffieHellman({ privateKey: priv, publicKey: ephemeral })
  const rpkDer = createPublicKey(priv).export({ type: "spki", format: "der" })
  const key = deriveKey(shared, Buffer.from(envelope.epk, "base64"), rpkDer)

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64")
  )
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"))
  try {
    const pt = Buffer.concat([
      decipher.update(Buffer.from(envelope.ct, "base64")),
      decipher.final(),
    ])
    return pt.toString("utf8")
  } catch {
    throw new SealError("unseal failed — wrong key or tampered ciphertext")
  }
}
