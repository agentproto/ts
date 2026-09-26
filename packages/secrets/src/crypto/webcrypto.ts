/**
 * `CryptoProvider` over WebCrypto (`globalThis.crypto.subtle`) — the default in
 * the browser-safe entry. Browser-safe: no `node:` import, no `Buffer`.
 *
 * Needs X25519 + Ed25519 in `SubtleCrypto` (Chrome 133+, Safari 17+, Firefox
 * 130+, Node ≥ 20). The subtle instance is resolved lazily, per call, so merely
 * importing this module never throws in an environment without WebCrypto.
 */

import { base64Decode, concatBytes } from "./bytes.js"
import { GCM_TAG_LEN, type CryptoProvider, type KeyPairDer } from "./types.js"

// Local names for the WebCrypto dictionary types: this package compiles without
// the DOM lib, and @types/node only declares the interfaces.
type KeyUsage = "sign" | "verify" | "deriveBits" | "encrypt" | "decrypt"
type AesGcmParams = Parameters<SubtleCrypto["encrypt"]>[0]
type CryptoKeyPair = { publicKey: CryptoKey; privateKey: CryptoKey }

/** The DOM `BufferSource` excludes SharedArrayBuffer-backed views; our inputs
 *  are always plain `Uint8Array`s, so copy into a fresh ArrayBuffer-backed view
 *  when the static type can't prove it (a no-op for the common case). */
function buf(u8: Uint8Array): Uint8Array<ArrayBuffer> {
  return u8.buffer instanceof ArrayBuffer
    ? (u8 as Uint8Array<ArrayBuffer>)
    : new Uint8Array(u8)
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle
  if (!s) {
    throw new Error("WebCrypto (globalThis.crypto.subtle) is not available in this environment")
  }
  return s
}

// X25519 / Ed25519 public-key SPKI prefixes (RFC 8410): SEQUENCE { SEQUENCE {
// OID }, BIT STRING (0 unused bits) 32 bytes }. Used only to rebuild a public
// key from a JWK `x`; this is the exact DER both Node and WebCrypto emit.
const X25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
])

async function importPublic(spki: Uint8Array, name: "X25519" | "Ed25519", usages: KeyUsage[]): Promise<CryptoKey> {
  return subtle().importKey("spki", buf(spki), { name }, true, usages)
}

async function importPrivate(pkcs8: Uint8Array, name: "X25519" | "Ed25519", usages: KeyUsage[]): Promise<CryptoKey> {
  return subtle().importKey("pkcs8", buf(pkcs8), { name }, true, usages)
}

async function generate(name: "X25519" | "Ed25519"): Promise<KeyPairDer> {
  const usages: KeyUsage[] = name === "X25519" ? ["deriveBits"] : ["sign", "verify"]
  // Extractable: the provider contract hands private keys around as PKCS#8.
  const kp = (await subtle().generateKey({ name }, true, usages)) as unknown as CryptoKeyPair
  const [publicKey, privateKey] = await Promise.all([
    subtle().exportKey("spki", kp.publicKey),
    subtle().exportKey("pkcs8", kp.privateKey),
  ])
  return { publicKey: new Uint8Array(publicKey), privateKey: new Uint8Array(privateKey) }
}

async function aesKey(key: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return subtle().importKey("raw", buf(key), { name: "AES-GCM" }, false, [usage])
}

function gcmParams(iv: Uint8Array, aad?: Uint8Array): AesGcmParams {
  return aad
    ? { name: "AES-GCM", iv: buf(iv), additionalData: buf(aad), tagLength: GCM_TAG_LEN * 8 }
    : { name: "AES-GCM", iv: buf(iv), tagLength: GCM_TAG_LEN * 8 }
}

export const webCryptoProvider: CryptoProvider = {
  name: "webcrypto",

  randomBytes: n => {
    const out = new Uint8Array(n)
    // getRandomValues caps a single call at 65536 bytes.
    for (let off = 0; off < n; off += 65536) {
      globalThis.crypto.getRandomValues(out.subarray(off, Math.min(n, off + 65536)))
    }
    return out
  },

  sha256: async data => new Uint8Array(await subtle().digest("SHA-256", buf(data))),

  hmacSha256: async (key, data) => {
    const k = await subtle().importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    return new Uint8Array(await subtle().sign("HMAC", k, buf(data)))
  },

  hkdfSha256: async (ikm, salt, info, length) => {
    const k = await subtle().importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"])
    const bits = await subtle().deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(info) },
      k,
      length * 8,
    )
    return new Uint8Array(bits)
  },

  x25519GenerateKeyPair: () => generate("X25519"),

  x25519ValidatePublicKey: async spki => {
    await importPublic(spki, "X25519", [])
  },

  x25519PublicKeyFromPrivate: async pkcs8 => {
    // WebCrypto can't derive a public CryptoKey from a private one directly,
    // but the private JWK carries the public `x` coordinate.
    const jwk = await subtle().exportKey("jwk", await importPrivate(pkcs8, "X25519", ["deriveBits"]))
    if (typeof jwk.x !== "string") throw new Error("X25519 private key JWK has no public component")
    return concatBytes(X25519_SPKI_PREFIX, base64Decode(jwk.x))
  },

  x25519: async (privatePkcs8, publicSpki) => {
    const [privateKey, publicKey] = await Promise.all([
      importPrivate(privatePkcs8, "X25519", ["deriveBits"]),
      importPublic(publicSpki, "X25519", []),
    ])
    return new Uint8Array(await subtle().deriveBits({ name: "X25519", public: publicKey }, privateKey, 256))
  },

  ed25519GenerateKeyPair: () => generate("Ed25519"),

  ed25519ValidatePublicKey: async spki => {
    await importPublic(spki, "Ed25519", ["verify"])
  },

  ed25519Sign: async (privatePkcs8, message) => {
    const k = await importPrivate(privatePkcs8, "Ed25519", ["sign"])
    return new Uint8Array(await subtle().sign({ name: "Ed25519" }, k, buf(message)))
  },

  ed25519Verify: async (publicSpki, message, signature) => {
    try {
      const k = await importPublic(publicSpki, "Ed25519", ["verify"])
      return await subtle().verify({ name: "Ed25519" }, k, buf(signature), buf(message))
    } catch {
      return false
    }
  },

  aesGcmEncrypt: async (key, iv, plaintext, aad) =>
    new Uint8Array(await subtle().encrypt(gcmParams(iv, aad), await aesKey(key, "encrypt"), buf(plaintext))),

  aesGcmDecrypt: async (key, iv, sealed, aad) => {
    if (sealed.length < GCM_TAG_LEN) throw new Error("ciphertext shorter than the GCM tag")
    return new Uint8Array(await subtle().decrypt(gcmParams(iv, aad), await aesKey(key, "decrypt"), buf(sealed)))
  },
}
