import { mkdtemp, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"

import {
  deleteTunnelCredentials,
  readTunnelCredentials,
  tunnelCredsDir,
  tunnelCredsPath,
  writeTunnelCredentials,
} from "./credentials.js"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentproto-tunnel-creds-"))
})

describe("tunnelCredsPath", () => {
  it("lives under the agentproto home", () => {
    expect(tunnelCredsDir({ home: "/home/me/.agentproto" })).toBe(
      "/home/me/.agentproto/tunnel-creds",
    )
    expect(tunnelCredsPath("agentik", { home: "/home/me/.agentproto" })).toBe(
      "/home/me/.agentproto/tunnel-creds/agentik.json",
    )
  })

  it("rejects traversal and invalid slugs", () => {
    expect(() => tunnelCredsPath("../evil", { dir })).toThrow(/invalid provider slug/)
    expect(() => tunnelCredsPath("a/b", { dir })).toThrow(/invalid provider slug/)
    expect(() => tunnelCredsPath("", { dir })).toThrow(/invalid provider slug/)
  })
})

describe("credential roundtrip", () => {
  it("writes 0600 and reads the same fields", async () => {
    const path = await writeTunnelCredentials("agentik", { apiKey: "sk-abc", baseUrl: "https://x" }, { dir })
    expect(path).toBe(join(dir, "agentik.json"))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(readTunnelCredentials("agentik", { dir })).resolves.toEqual({
      apiKey: "sk-abc",
      baseUrl: "https://x",
    })
  })

  it("returns null for a missing file and ignores non-string values", async () => {
    await expect(readTunnelCredentials("missing", { dir })).resolves.toBeNull()
    await writeTunnelCredentials("mixed", { apiKey: "sk" }, { dir })
    const fs = await import("node:fs/promises")
    await fs.writeFile(join(dir, "mixed.json"), JSON.stringify({ apiKey: "sk", n: 1 }))
    await expect(readTunnelCredentials("mixed", { dir })).resolves.toEqual({ apiKey: "sk" })
  })

  it("deletes idempotently", async () => {
    await writeTunnelCredentials("agentik", { apiKey: "sk-abc" }, { dir })
    await deleteTunnelCredentials("agentik", { dir })
    await expect(readTunnelCredentials("agentik", { dir })).resolves.toBeNull()
    await expect(deleteTunnelCredentials("agentik", { dir })).resolves.toBeUndefined()
  })
})
