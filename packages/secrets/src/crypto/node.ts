/**
 * `CryptoProvider` over `node:crypto` — the default in every Node entry point.
 * These are the exact calls the pairing / seal / identity code made before the
 * provider seam existed, so Node output is unchanged.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto"
import { GCM_TAG_LEN, type CryptoProvider, type KeyPairDer } from "./types.js"

function pub(spki: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" })
}

function priv(pkcs8: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.from(pkcs8), format: "der", type: "pkcs8" })
}

function assertType(key: KeyObject, type: "x25519" | "ed25519"): KeyObject {
  if (key.asymmetricKeyType !== type) throw new Error(`expected an ${type} key`)
  return key
}

function generate(type: "x25519" | "ed25519"): KeyPairDer {
  // The overloads need a literal type argument.
  const kp = type === "x25519" ? generateKeyPairSync("x25519") : generateKeyPairSync("ed25519")
  return {
    publicKey: kp.publicKey.export({ type: "spki", format: "der" }),
    privateKey: kp.privateKey.export({ type: "pkcs8", format: "der" }),
  }
}

export const nodeCryptoProvider: CryptoProvider = {
  name: "node",

  randomBytes: n => randomBytes(n),

  sha256: async data => createHash("sha256").update(data).digest(),

  hmacSha256: async (key, data) => createHmac("sha256", key).update(data).digest(),

  hkdfSha256: async (ikm, salt, info, length) =>
    new Uint8Array(hkdfSync("sha256", ikm, salt, info, length)),

  x25519GenerateKeyPair: async () => generate("x25519"),

  x25519ValidatePublicKey: async spki => {
    assertType(pub(spki), "x25519")
  },

  x25519PublicKeyFromPrivate: async pkcs8 =>
    createPublicKey(assertType(priv(pkcs8), "x25519")).export({ type: "spki", format: "der" }),

  x25519: async (privatePkcs8, publicSpki) =>
    diffieHellman({
      privateKey: assertType(priv(privatePkcs8), "x25519"),
      publicKey: assertType(pub(publicSpki), "x25519"),
    }),

  ed25519GenerateKeyPair: async () => generate("ed25519"),

  ed25519ValidatePublicKey: async spki => {
    assertType(pub(spki), "ed25519")
  },

  // Ed25519 takes a null digest algorithm — it hashes internally.
  ed25519Sign: async (privatePkcs8, message) =>
    sign(null, message, assertType(priv(privatePkcs8), "ed25519")),

  ed25519Verify: async (publicSpki, message, signature) => {
    try {
      return verify(null, message, assertType(pub(publicSpki), "ed25519"), signature)
    } catch {
      return false
    }
  },

  aesGcmEncrypt: async (key, iv, plaintext, aad) => {
    const cipher = createCipheriv("aes-256-gcm", key, iv)
    if (aad) cipher.setAAD(aad)
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  },

  aesGcmDecrypt: async (key, iv, sealed, aad) => {
    if (sealed.length < GCM_TAG_LEN) throw new Error("ciphertext shorter than the GCM tag")
    const decipher = createDecipheriv("aes-256-gcm", key, iv)
    if (aad) decipher.setAAD(aad)
    decipher.setAuthTag(sealed.subarray(sealed.length - GCM_TAG_LEN))
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - GCM_TAG_LEN)), decipher.final()])
  },
}
