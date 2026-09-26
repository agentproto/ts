/**
 * The crypto seam behind the pairing handshake, the seal box and the daemon
 * identity: the handful of primitives they need, and nothing else.
 *
 * Two implementations:
 *   - `nodeCryptoProvider` (`./node.ts`) — `node:crypto`; the default in every
 *     Node entry point (`@agentproto/secrets/pairing`, `/seal`, `/identity`).
 *   - `webCryptoProvider` (`./webcrypto.ts`) — `globalThis.crypto.subtle`; the
 *     default in the browser-safe entry (`@agentproto/secrets/pairing/browser`).
 *     Works in current Chrome / Safari / Firefox and in Node ≥ 20.
 *
 * The protocol code on top is written once against this interface, so both
 * runtimes run the same key schedule. The methods are Promise-based because
 * WebCrypto is; `randomBytes` stays synchronous (`getRandomValues` is).
 *
 * Key encoding: keys cross this seam as DER bytes — SPKI for public keys,
 * PKCS#8 for private keys — which is exactly what travels on the wire and in
 * `identity.json` (base64 of the same bytes). Both implementations import and
 * export the same DER, so keys minted by one are usable by the other.
 */
export interface CryptoProvider {
  /** Implementation label, for diagnostics and tests ("node" | "webcrypto"). */
  readonly name: string

  /** `n` cryptographically-random bytes. */
  randomBytes(n: number): Uint8Array
  sha256(data: Uint8Array): Promise<Uint8Array>
  hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array>
  /** RFC 5869 HKDF with SHA-256; `length` output bytes. */
  hkdfSha256(
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    length: number,
  ): Promise<Uint8Array>

  /** Fresh X25519 keypair: `publicKey` SPKI DER, `privateKey` PKCS#8 DER. */
  x25519GenerateKeyPair(): Promise<KeyPairDer>
  /** Throws if `spki` is not an importable X25519 public key. */
  x25519ValidatePublicKey(spki: Uint8Array): Promise<void>
  /** The SPKI DER public half of a PKCS#8 X25519 private key. */
  x25519PublicKeyFromPrivate(pkcs8: Uint8Array): Promise<Uint8Array>
  /** X25519 ECDH → 32-byte shared secret. */
  x25519(privatePkcs8: Uint8Array, publicSpki: Uint8Array): Promise<Uint8Array>

  /** Fresh Ed25519 keypair: `publicKey` SPKI DER, `privateKey` PKCS#8 DER. */
  ed25519GenerateKeyPair(): Promise<KeyPairDer>
  /** Throws if `spki` is not an importable Ed25519 public key. */
  ed25519ValidatePublicKey(spki: Uint8Array): Promise<void>
  ed25519Sign(privatePkcs8: Uint8Array, message: Uint8Array): Promise<Uint8Array>
  /** Never throws on a bad signature — resolves false. */
  ed25519Verify(publicSpki: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean>

  /** AES-256-GCM, 16-byte tag. Returns `ciphertext ‖ tag`. */
  aesGcmEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array>
  /** Opens `ciphertext ‖ tag`. Rejects on any authentication failure. */
  aesGcmDecrypt(key: Uint8Array, iv: Uint8Array, sealed: Uint8Array, aad?: Uint8Array): Promise<Uint8Array>
}

export interface KeyPairDer {
  /** SPKI DER. */
  publicKey: Uint8Array
  /** PKCS#8 DER. */
  privateKey: Uint8Array
}

/** AES-GCM tag length used throughout (bytes). */
export const GCM_TAG_LEN = 16
