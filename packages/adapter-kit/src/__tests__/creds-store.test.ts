import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeCredsStore } from "../creds-store.js"

interface TestCreds {
  token: string
  accountId?: string
}

describe("makeCredsStore", () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "adapter-kit-creds-"))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it("read returns null when absent", async () => {
    const store = makeCredsStore<TestCreds>({ family: "tunnel", home })
    expect(await store.read("ngrok")).toBeNull()
  })

  it("exists is false before write, true after", async () => {
    const store = makeCredsStore<TestCreds>({ family: "tunnel", home })
    expect(await store.exists("ngrok")).toBe(false)
    await store.write("ngrok", { token: "secret-abc" })
    expect(await store.exists("ngrok")).toBe(true)
  })

  it("write/read round-trips the creds object", async () => {
    const store = makeCredsStore<TestCreds>({ family: "tunnel", home })
    const creds: TestCreds = { token: "secret-abc", accountId: "acct_1" }
    await store.write("cloudflare-named", creds)
    expect(await store.read("cloudflare-named")).toEqual(creds)
  })

  it("write creates the file with mode 0600", async () => {
    const store = makeCredsStore<TestCreds>({ family: "tunnel", home })
    await store.write("ngrok", { token: "secret-abc" })
    const path = join(home, "tunnel-creds", "ngrok.json")
    const st = await stat(path)
    expect(st.mode & 0o777).toBe(0o600)
  })

  it("isolates creds by family prefix", async () => {
    const tunnel = makeCredsStore<TestCreds>({ family: "tunnel", home })
    const agent = makeCredsStore<TestCreds>({ family: "agent-cli", home })
    await tunnel.write("ngrok", { token: "t" })
    expect(await agent.exists("ngrok")).toBe(false)
  })
})
