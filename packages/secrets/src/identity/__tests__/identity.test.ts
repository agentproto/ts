import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  generateIdentity,
  loadOrCreateIdentity,
  identityFingerprint,
  signTranscript,
  verifyTranscript,
  IdentityError,
  IDENTITY_VERSION,
} from "../index.js"
import { sealKeyId } from "../../seal/index.js"
import { nodeCryptoProvider } from "../../crypto/node.js"
import { webCryptoProvider } from "../../crypto/webcrypto.js"

describe.each([
  ["node", nodeCryptoProvider],
  ["webcrypto", webCryptoProvider],
])("@agentproto/secrets/identity (%s)", (_name, c) => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-identity-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("generates a versioned identity with both keypairs", async () => {
    const id = await generateIdentity(c)
    expect(id.v).toBe(IDENTITY_VERSION)
    expect(typeof id.x25519.pub).toBe("string")
    expect(typeof id.x25519.priv).toBe("string")
    expect(typeof id.ed25519.pub).toBe("string")
    expect(typeof id.ed25519.priv).toBe("string")
    expect(Date.parse(id.createdAt)).not.toBeNaN()
    // The two keypairs are distinct algorithms → distinct public halves.
    expect(id.x25519.pub).not.toBe(id.ed25519.pub)
  })

  it("each generated identity is unique", async () => {
    const a = await generateIdentity(c)
    const b = await generateIdentity(c)
    expect(a.x25519.priv).not.toBe(b.x25519.priv)
    expect(a.ed25519.priv).not.toBe(b.ed25519.priv)
  })

  it("fingerprint matches the sealKeyId construction and is stable", async () => {
    const id = await generateIdentity(c)
    const fp = await identityFingerprint(id.x25519.pub, c)
    expect(fp).toHaveLength(16)
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
    // Same construction as the seal key id — a daemon's fingerprint is its
    // x25519 seal-key id.
    expect(fp).toBe(await sealKeyId(id.x25519.pub, c))
    // Deterministic in the public key.
    expect(await identityFingerprint(id.x25519.pub, c)).toBe(fp)
  })

  it("loadOrCreateIdentity creates, persists 0600, and reloads identically", async () => {
    const file = join(dir, "identity.json")
    const created = await loadOrCreateIdentity(file)

    // File exists and is mode 0600 (owner read/write only).
    const st = await stat(file)
    expect(st.mode & 0o777).toBe(0o600)

    // Reload returns byte-identical material (no rotation on second call).
    const reloaded = await loadOrCreateIdentity(file)
    expect(reloaded).toEqual(created)

    // On-disk JSON matches what we returned.
    const onDisk: unknown = JSON.parse(await readFile(file, "utf8"))
    expect(onDisk).toEqual(created)
  })

  it("creates the parent directory if missing", async () => {
    const file = join(dir, "nested", "deep", "identity.json")
    const created = await loadOrCreateIdentity(file)
    expect(created.v).toBe(IDENTITY_VERSION)
    await expect(stat(file)).resolves.toBeDefined()
  })

  it("refuses to overwrite a malformed identity file", async () => {
    const file = join(dir, "identity.json")
    await writeFile(file, "{ not valid json")
    await expect(loadOrCreateIdentity(file)).rejects.toBeInstanceOf(IdentityError)
    // The bad file is left untouched — never silently rotated.
    expect(await readFile(file, "utf8")).toBe("{ not valid json")
  })

  it("refuses an identity file of an unsupported version", async () => {
    const file = join(dir, "identity.json")
    await writeFile(file, JSON.stringify({ v: 999, x25519: {}, ed25519: {} }))
    await expect(loadOrCreateIdentity(file)).rejects.toBeInstanceOf(IdentityError)
  })

  it("sign/verify round-trips a transcript", async () => {
    const id = await generateIdentity(c)
    const transcript = new Uint8Array([1, 2, 3, 4, 5])
    const sig = await signTranscript(id.ed25519.priv, transcript, c)
    expect(await verifyTranscript(id.ed25519.pub, transcript, sig, c)).toBe(true)
  })

  it("verify rejects a tampered transcript", async () => {
    const id = await generateIdentity(c)
    const transcript = new Uint8Array([1, 2, 3, 4, 5])
    const sig = await signTranscript(id.ed25519.priv, transcript, c)
    const tampered = new Uint8Array([1, 2, 3, 4, 6])
    expect(await verifyTranscript(id.ed25519.pub, tampered, sig, c)).toBe(false)
  })

  it("verify rejects a signature from a different key", async () => {
    const a = await generateIdentity(c)
    const b = await generateIdentity(c)
    const transcript = new Uint8Array([9, 9, 9])
    const sig = await signTranscript(a.ed25519.priv, transcript, c)
    expect(await verifyTranscript(b.ed25519.pub, transcript, sig, c)).toBe(false)
  })

  it("verify returns false (not throw) on a garbage signature", async () => {
    const id = await generateIdentity(c)
    const transcript = new Uint8Array([1, 2, 3])
    expect(await verifyTranscript(id.ed25519.pub, transcript, "not-base64-sig!!", c)).toBe(false)
  })

  it("sign throws IdentityError on an invalid private key", async () => {
    await expect(signTranscript("not-a-key", new Uint8Array([1]), c)).rejects.toThrow(IdentityError)
  })
})
