import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkSessionAlive, resolveDaemonToken } from "./daemon-client.js"

function fakeFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body?: unknown },
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const { status, body } = handler(url, init)
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

describe("checkSessionAlive", () => {
  it("returns ok for a running session", async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 200,
      body: { id: "sess_abc", status: "running", processAlive: true },
    }))
    const result = await checkSessionAlive("http://daemon.local", "my-session", fetchImpl)
    expect(result).toEqual({ ok: true, id: "sess_abc", status: "running" })
  })

  it("returns not-ok for a 404", async () => {
    const fetchImpl = fakeFetch(() => ({ status: 404 }))
    const result = await checkSessionAlive("http://daemon.local", "ghost", fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no session/)
  })

  it("returns not-ok for an exited session", async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 200,
      body: { id: "sess_abc", status: "exited", processAlive: false },
    }))
    const result = await checkSessionAlive("http://daemon.local", "my-session", fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.id).toBe("sess_abc")
    expect(result.reason).toMatch(/exited/)
  })

  it("returns not-ok for processAlive:false even with a live-looking status", async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 200,
      body: { id: "sess_abc", status: "running", processAlive: false },
    }))
    const result = await checkSessionAlive("http://daemon.local", "my-session", fetchImpl)
    expect(result.ok).toBe(false)
  })

  it("returns not-ok when the daemon is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED")
    }) as typeof fetch
    const result = await checkSessionAlive("http://daemon.local", "my-session", fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/could not reach daemon/)
  })

  it("returns not-ok on a non-2xx, non-404 status", async () => {
    const fetchImpl = fakeFetch(() => ({ status: 500 }))
    const result = await checkSessionAlive("http://daemon.local", "my-session", fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/500/)
  })
})

describe("resolveDaemonToken", () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "agentproto-relay-test-"))
  })

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it("reads the token from the central registry keyed by port", async () => {
    await mkdir(join(homeDir, ".agentproto", "daemons"), { recursive: true })
    await writeFile(
      join(homeDir, ".agentproto", "daemons", "18790.json"),
      JSON.stringify({ pid: process.pid, token: "registry-token" }),
    )
    const token = await resolveDaemonToken("http://127.0.0.1:18790", { homeDir })
    expect(token).toBe("registry-token")
  })

  it("ignores a registry entry whose pid is dead", async () => {
    await mkdir(join(homeDir, ".agentproto", "daemons"), { recursive: true })
    // pid 999999 is very unlikely to be alive in a test sandbox.
    await writeFile(
      join(homeDir, ".agentproto", "daemons", "18790.json"),
      JSON.stringify({ pid: 999999, token: "stale-token" }),
    )
    const fetchImpl = fakeFetch(() => ({ status: 500 }))
    const token = await resolveDaemonToken("http://127.0.0.1:18790", { homeDir, fetchImpl })
    expect(token).toBeUndefined()
  })

  it("falls back to /health + workspace runtime.json when the registry is absent", async () => {
    const workspace = join(homeDir, "workspace")
    await mkdir(join(workspace, ".agentproto"), { recursive: true })
    await writeFile(
      join(workspace, ".agentproto", "runtime.json"),
      JSON.stringify({ token: "workspace-token" }),
    )
    const fetchImpl = fakeFetch(() => ({ status: 200, body: { workspace } }))
    const token = await resolveDaemonToken("http://127.0.0.1:18790", { homeDir, fetchImpl })
    expect(token).toBe("workspace-token")
  })

  it("returns undefined when neither source has a token", async () => {
    const fetchImpl = fakeFetch(() => ({ status: 200, body: { workspace: join(homeDir, "nope") } }))
    const token = await resolveDaemonToken("http://127.0.0.1:18790", { homeDir, fetchImpl })
    expect(token).toBeUndefined()
  })
})
