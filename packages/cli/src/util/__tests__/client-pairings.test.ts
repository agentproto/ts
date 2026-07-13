import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, stat, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clientPairingsPath,
  loadClientPairings,
  upsertClientPairing,
  findClientPairing,
  removeClientPairing,
  type ClientPairing,
} from "../client-pairings.js"

function sample(overrides: Partial<ClientPairing> = {}): ClientPairing {
  const now = new Date("2026-07-13T00:00:00.000Z").toISOString()
  return {
    fingerprint: "0123456789abcdef",
    name: "my-laptop",
    daemonX25519Pub: "eDI1NTE5cHVi",
    daemonEd25519Pub: "ZWQyNTUxOXB1Yg==",
    rendezvousUrl: "wss://rv.example/v1",
    pairRoot: "cGFpci1yb290LXNlY3JldA==",
    createdAt: now,
    lastSeen: now,
    ...overrides,
  }
}

describe("client pairings store", () => {
  let tmp: string
  let prevHome: string | undefined

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-clientpair-"))
    prevHome = process.env["AGENTPROTO_HOME"]
    process.env["AGENTPROTO_HOME"] = tmp
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env["AGENTPROTO_HOME"]
    else process.env["AGENTPROTO_HOME"] = prevHome
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it("returns an empty file when nothing is persisted", async () => {
    const file = await loadClientPairings()
    expect(file.version).toBe(1)
    expect(file.pairings).toEqual([])
  })

  it("round-trips a pairing and writes 0600", async () => {
    await upsertClientPairing(sample())
    const file = await loadClientPairings()
    expect(file.pairings).toHaveLength(1)
    expect(file.pairings[0]?.name).toBe("my-laptop")

    const st = await stat(clientPairingsPath())
    expect(st.mode & 0o777).toBe(0o600)
  })

  it("upsert replaces by fingerprint (not append)", async () => {
    await upsertClientPairing(sample({ name: "old" }))
    await upsertClientPairing(sample({ name: "renamed" }))
    const file = await loadClientPairings()
    expect(file.pairings).toHaveLength(1)
    expect(file.pairings[0]?.name).toBe("renamed")
  })

  it("resolves by fingerprint and by name", async () => {
    await upsertClientPairing(sample())
    expect((await findClientPairing("0123456789abcdef"))?.name).toBe("my-laptop")
    expect((await findClientPairing("my-laptop"))?.fingerprint).toBe("0123456789abcdef")
    expect(await findClientPairing("nope")).toBeUndefined()
  })

  it("removes by name, returns the record, and unlinks the file when empty", async () => {
    await upsertClientPairing(sample())
    const removed = await removeClientPairing("my-laptop")
    expect(removed?.fingerprint).toBe("0123456789abcdef")

    // File is gone once the last pairing is dropped.
    await expect(access(clientPairingsPath())).rejects.toBeTruthy()
    expect((await loadClientPairings()).pairings).toEqual([])
  })

  it("keeps other pairings when removing one of several", async () => {
    await upsertClientPairing(sample({ fingerprint: "aaaa000000000000", name: "a" }))
    await upsertClientPairing(sample({ fingerprint: "bbbb000000000000", name: "b" }))
    expect(await removeClientPairing("a")).not.toBeNull()
    const file = await loadClientPairings()
    expect(file.pairings.map(p => p.name)).toEqual(["b"])
  })

  it("returns null removing an unknown pairing", async () => {
    expect(await removeClientPairing("ghost")).toBeNull()
  })
})
