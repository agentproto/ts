/**
 * The AEAD seam behind `wrapE2E`: AES-256-GCM with a 16-byte tag, and nothing
 * else. `@agentproto/acp` never touches key agreement — it only receives the two
 * symmetric session keys — so this is the whole crypto surface it needs.
 *
 * Structurally a subset of `@agentproto/secrets`' `CryptoProvider`, so either
 * package's provider objects can be passed where an `E2eAead` is expected.
 *
 * Two implementations: `nodeAead` (./aead-node.ts, `node:crypto`; the default
 * through the `@agentproto/acp/tunnel` Node entry) and `webCryptoAead` (here;
 * the default through `@agentproto/acp/tunnel/browser`). Both produce
 * `ciphertext ‖ tag` — AES-GCM is deterministic, so for the same key, nonce,
 * AAD and plaintext they are byte-identical.
 *
 * Browser-safe: no `node:` import.
 */
export interface E2eAead {
  /** Returns `ciphertext ‖ 16-byte tag`. */
  aesGcmEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array>
  /** Opens `ciphertext ‖ tag`; rejects on any authentication failure. */
  aesGcmDecrypt(key: Uint8Array, iv: Uint8Array, sealed: Uint8Array, aad?: Uint8Array): Promise<Uint8Array>
}

const TAG_BITS = 128

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle
  if (!s) {
    throw new Error("WebCrypto (globalThis.crypto.subtle) is not available in this environment")
  }
  return s
}

/** Narrow to an ArrayBuffer-backed view, as WebCrypto's `BufferSource` wants. */
function buf(u8: Uint8Array): Uint8Array<ArrayBuffer> {
  return u8.buffer instanceof ArrayBuffer ? (u8 as Uint8Array<ArrayBuffer>) : new Uint8Array(u8)
}

type GcmParams = Parameters<SubtleCrypto["encrypt"]>[0]

function params(iv: Uint8Array, aad?: Uint8Array): GcmParams {
  return aad
    ? { name: "AES-GCM", iv: buf(iv), additionalData: buf(aad), tagLength: TAG_BITS }
    : { name: "AES-GCM", iv: buf(iv), tagLength: TAG_BITS }
}

/**
 * WebCrypto AES-GCM. Imported `CryptoKey`s are cached per key buffer, since
 * `wrapE2E` encrypts every frame under the same two keys.
 */
export function createWebCryptoAead(): E2eAead {
  const keys = new WeakMap<Uint8Array, Promise<CryptoKey>>()
  const keyFor = (raw: Uint8Array): Promise<CryptoKey> => {
    let k = keys.get(raw)
    if (!k) {
      k = subtle().importKey("raw", buf(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
      keys.set(raw, k)
    }
    return k
  }
  return {
    aesGcmEncrypt: async (key, iv, plaintext, aad) =>
      new Uint8Array(await subtle().encrypt(params(iv, aad), await keyFor(key), buf(plaintext))),
    aesGcmDecrypt: async (key, iv, sealed, aad) =>
      new Uint8Array(await subtle().decrypt(params(iv, aad), await keyFor(key), buf(sealed))),
  }
}

export const webCryptoAead: E2eAead = createWebCryptoAead()
