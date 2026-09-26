import { describe, it, expect } from "vitest"
import { importPairRootKey } from "@agentproto/secrets/pairing"
import { createIndexedDbCredentialStore, createMemoryCredentialStore, type PairCredential } from "../credential.js"

async function cred(id: string, name = id): Promise<PairCredential> {
  return {
    id,
    fingerprint: id,
    name,
    clientName: "phone",
    daemonX25519Pub: "x",
    daemonEd25519Pub: "e",
    rendezvousUrl: "wss://rdv.example/v1",
    pairRoot: await importPairRootKey(Buffer.alloc(32, 1).toString("base64")),
    createdAt: "2026-09-26T00:00:00.000Z",
    lastSeen: "2026-09-26T00:00:00.000Z",
  }
}

describe("createMemoryCredentialStore", () => {
  it("get / put (upsert by id) / list / delete", async () => {
    const store = createMemoryCredentialStore()
    expect(await store.list()).toEqual([])
    expect(await store.get("a")).toBeUndefined()

    const a = await cred("a")
    await store.put(a)
    await store.put(await cred("b"))
    expect(await store.get("a")).toBe(a)
    expect((await store.list()).map(c => c.id).sort()).toEqual(["a", "b"])

    const renamed = { ...a, name: "renamed" }
    await store.put(renamed)
    expect((await store.get("a"))?.name).toBe("renamed")
    expect(await store.list()).toHaveLength(2)

    expect(await store.delete("a")).toBe(true)
    expect(await store.delete("a")).toBe(false)
    expect((await store.list()).map(c => c.id)).toEqual(["b"])
  })

  it("keeps the pair root a non-extractable CryptoKey", async () => {
    const store = createMemoryCredentialStore([await cred("a")])
    const root = (await store.get("a"))!.pairRoot as CryptoKey
    expect(root.extractable).toBe(false)
    await expect(globalThis.crypto.subtle.exportKey("raw", root)).rejects.toThrow()
  })
})

describe("createIndexedDbCredentialStore", () => {
  it("fails with a clear error where IndexedDB is unavailable", async () => {
    const store = createIndexedDbCredentialStore()
    await expect(store.list()).rejects.toThrow(/IndexedDB is not available/)
  })
})
