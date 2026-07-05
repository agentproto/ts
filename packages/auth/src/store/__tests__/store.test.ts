import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { randomBytes } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runStoreContract } from "./contract.js"
import { MemoryStore } from "../memory-store.js"
import { FileStore } from "../file-store.js"

describe("MemoryStore", () => {
  runStoreContract(() => new MemoryStore())
})

describe("FileStore", () => {
  const testKey = randomBytes(32).toString("hex")
  let dir = ""

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-auth-filestore-"))
    process.env.AGENTPROTO_STORE_KEY = testKey
  })

  afterEach(async () => {
    delete process.env.AGENTPROTO_STORE_KEY
    await rm(dir, { recursive: true, force: true })
  })

  runStoreContract(() => new FileStore(join(dir, "credentials.json")))
})

describe("FileStore — key handling", () => {
  let dir = ""
  const origKey = process.env.AGENTPROTO_STORE_KEY

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-auth-filestore-"))
  })

  afterEach(async () => {
    if (origKey === undefined) delete process.env.AGENTPROTO_STORE_KEY
    else process.env.AGENTPROTO_STORE_KEY = origKey
    await rm(dir, { recursive: true, force: true })
  })

  it("throws when AGENTPROTO_STORE_KEY is missing", async () => {
    delete process.env.AGENTPROTO_STORE_KEY
    const store = new FileStore(join(dir, "credentials.json"))
    await expect(
      store.write({ path: "svc", account: "acct" }, { value: "t", kind: "pat" }),
    ).rejects.toThrow(/AGENTPROTO_STORE_KEY/)
  })

  it("throws when AGENTPROTO_STORE_KEY doesn't decode to 32 bytes", async () => {
    process.env.AGENTPROTO_STORE_KEY = "too-short"
    const store = new FileStore(join(dir, "credentials.json"))
    await expect(
      store.write({ path: "svc", account: "acct" }, { value: "t", kind: "pat" }),
    ).rejects.toThrow(/32 bytes/)
  })

  it("accepts a base64-encoded 32-byte key", async () => {
    process.env.AGENTPROTO_STORE_KEY = randomBytes(32).toString("base64")
    const store = new FileStore(join(dir, "credentials.json"))
    const ref = { path: "svc", account: "acct" }
    await store.write(ref, { value: "t", kind: "pat" })
    await expect(store.read(ref)).resolves.toEqual({ value: "t", kind: "pat" })
  })
})
