import { describe, expect, it } from "vitest"
import { createMemoryCredentialStore, type PairCredential } from "@agentproto/pair-client"
import { daemonOrigin, ForeignDaemonError, pageMode, scopeCredentialStore } from "../lib/host"

const A = "ae5be03faa146dd7"
const B = "0123456789abcdef"

function cred(fp: string): PairCredential {
  return {
    id: fp,
    fingerprint: fp,
    name: `daemon ${fp}`,
    clientName: "test",
    daemonX25519Pub: "x",
    daemonEd25519Pub: "e",
    rendezvousUrl: "wss://rdv.example/v1",
    pairRoot: "cm9vdA==",
    createdAt: "2026-09-27T00:00:00.000Z",
    lastSeen: "2026-09-27T00:00:00.000Z",
  }
}

describe("pageMode", () => {
  it("is the daemon of the first label when it is a fingerprint", () => {
    expect(pageMode(`${A}.agentproto.cloud`)).toEqual({ kind: "daemon", fingerprint: A })
    expect(pageMode(`${A.toUpperCase()}.localhost`)).toEqual({ kind: "daemon", fingerprint: A })
  })

  it("is a preview anywhere else", () => {
    for (const host of ["localhost", "127.0.0.1", "agentproto-pair-page.x.workers.dev", A]) {
      expect(pageMode(host), host).toEqual({ kind: "preview" })
    }
  })
})

describe("daemonOrigin", () => {
  it("swaps the first label, keeping scheme, domain and port", () => {
    expect(daemonOrigin(B, { protocol: "https:", hostname: `${A}.agentproto.cloud`, port: "" })).toBe(
      `https://${B}.agentproto.cloud`,
    )
    expect(daemonOrigin(B, { protocol: "http:", hostname: `${A}.localhost`, port: "8788" })).toBe(
      `http://${B}.localhost:8788`,
    )
  })
})

describe("scopeCredentialStore", () => {
  it("on a daemon origin, holds only that daemon's credential", async () => {
    const raw = createMemoryCredentialStore([cred(B)])
    const store = scopeCredentialStore(raw, { kind: "daemon", fingerprint: A })
    await expect(store.put(cred(B))).rejects.toBeInstanceOf(ForeignDaemonError)
    expect(await store.get(B)).toBeUndefined()
    expect(await store.list()).toEqual([])
    expect(await store.delete(B)).toBe(false)
    expect(await raw.get(B)).toBeDefined()

    await store.put(cred(A))
    expect((await store.get(A))?.fingerprint).toBe(A)
    expect((await store.list()).map(c => c.id)).toEqual([A])
    expect(await store.delete(A)).toBe(true)
  })

  it("refuses a credential whose id and fingerprint disagree", async () => {
    const store = scopeCredentialStore(createMemoryCredentialStore(), { kind: "daemon", fingerprint: A })
    await expect(store.put({ ...cred(A), fingerprint: B })).rejects.toBeInstanceOf(ForeignDaemonError)
  })

  it("on a preview host, is the store unchanged", async () => {
    const raw = createMemoryCredentialStore()
    expect(scopeCredentialStore(raw, { kind: "preview" })).toBe(raw)
  })
})
