import { createServer } from "node:http"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { BrowserUnsupportedError, runConformance } from "@agentproto/driver-browser"
import { CamofoxHttpError, createCamofoxRestClient } from "../client.js"
import { createCamofoxProvider } from "../provider.js"
import type { SpawnFn } from "../launch.js"
import { startFakeCamofoxServer, type FakeCamofoxServer } from "./fake-camofox-server.js"

const noPersisted = async (): Promise<Record<string, string>> => ({})

function neverSpawn(): { spawn: SpawnFn; calls: () => number } {
  const spawn = vi.fn<SpawnFn>(() => {
    throw new Error("spawn must not be called")
  })
  return { spawn, calls: () => spawn.mock.calls.length }
}

describe("camofox provider: conformance against a fake camofox REST server", () => {
  let server: FakeCamofoxServer
  beforeAll(async () => {
    server = await startFakeCamofoxServer()
  })
  afterAll(async () => {
    await server.close()
  })

  it("passes core and interaction; network and download report the typed unsupported error", async () => {
    const { spawn, calls } = neverSpawn()
    const provider = createCamofoxProvider({ spawn, readPersistedEnv: noPersisted, behavior: "fast", nativeVideo: false })
    expect(provider.id).toBe("camofox")
    expect(provider.transport).toBe("http")
    expect(provider.capabilities.cdp).toBe(false)

    const report = await runConformance(provider, {
      levels: ["core", "interaction", "network", "download"],
      launch: { baseUrl: server.baseUrl, label: "conf" },
      checkTimeoutMs: 30_000,
    })
    expect(report.failed).toEqual([])
    expect(report.ok).toBe(true)
    const network = report.levels.find((l) => l.level === "network")
    expect(network?.status).toBe("skipped")
    expect(network?.checks.find((c) => c.name === "typed-unsupported")?.status).toBe("pass")
    expect(calls()).toBe(0)
    // every tab the runner opened is closed again
    expect([...server.tabs.values()].every((t) => !t.open)).toBe(true)
    expect(server.tabs.size).toBeGreaterThan(0)
  }, 120_000)

  it("throws BrowserUnsupportedError (cdp) for network capture on an attached driver", async () => {
    const provider = createCamofoxProvider({ spawn: neverSpawn().spawn, readPersistedEnv: noPersisted, behavior: "fast" })
    const instance = await provider.launch({ baseUrl: server.baseUrl }, {})
    const driver = await instance.attach()
    await expect(driver.listRequests?.({})).rejects.toBeInstanceOf(BrowserUnsupportedError)
    await driver.close()
    await instance.stop()
  })
})

describe("camofox provider: launch", () => {
  let server: FakeCamofoxServer
  beforeAll(async () => {
    server = await startFakeCamofoxServer()
  })
  afterAll(async () => {
    await server.close()
  })

  it("a healthy server on the port is reused: wasAlreadyRunning and no spawn", async () => {
    const { spawn, calls } = neverSpawn()
    const provider = createCamofoxProvider({ spawn, readPersistedEnv: noPersisted })
    const instance = await provider.launch({ port: server.port }, {})
    expect(instance.wasAlreadyRunning).toBe(true)
    expect(instance.endpoints.rest).toBe(server.baseUrl)
    expect(instance.pid).toBeUndefined()
    expect(calls()).toBe(0)
    await instance.stop()
  })

  it("an idle server (200, browserState idle) counts as running", async () => {
    const idle = await startFakeCamofoxServer({ health: "idle" })
    try {
      const { spawn, calls } = neverSpawn()
      const provider = createCamofoxProvider({ spawn, readPersistedEnv: noPersisted })
      const instance = await provider.launch({ baseUrl: idle.baseUrl }, {})
      expect(instance.wasAlreadyRunning).toBe(true)
      const health = await instance.health()
      expect(health.ok).toBe(true)
      expect(health.lifecycle?.browserState).toBe("idle")
      expect(calls()).toBe(0)
    } finally {
      await idle.close()
    }
  })

  it("does not kill a server it did not start", async () => {
    const provider = createCamofoxProvider({ spawn: neverSpawn().spawn, readPersistedEnv: noPersisted })
    const instance = await provider.launch({ baseUrl: server.baseUrl }, {})
    await instance.stop()
    await instance.stop()
    expect((await instance.health()).ok).toBe(false)
    const again = await provider.launch({ baseUrl: server.baseUrl }, {})
    expect(again.wasAlreadyRunning).toBe(true)
    expect((await again.health()).ok).toBe(true)
  })

  it("spawns the configured command when nothing answers and waits for /health", async () => {
    const late = await startFakeCamofoxServer()
    const port = late.port
    await late.close()
    const spawnCalls: Array<{ file: string; args: string[]; port: string | undefined }> = []
    let revived: { close(): Promise<void> } | undefined
    const spawn: SpawnFn = (file, args, options) => {
      spawnCalls.push({ file, args, port: options.env["CAMOFOX_PORT"] })
      void listenHealthOn(port).then((s) => {
        revived = s
      })
      return { pid: undefined, unref: () => {} }
    }
    const provider = createCamofoxProvider({
      spawn,
      readPersistedEnv: noPersisted,
      platform: "linux",
      pollIntervalMs: 25,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    })
    try {
      const instance = await provider.launch({ port, launchCmd: "camofox-serve", timeoutMs: 10_000 }, {})
      expect(instance.wasAlreadyRunning).toBe(false)
      expect(spawnCalls).toHaveLength(1)
      expect(spawnCalls[0]?.args).toEqual(["-c", "camofox-serve"])
      expect(spawnCalls[0]?.port).toBe(String(port))
      await instance.stop()
    } finally {
      await revived?.close()
    }
  })

  it("fails with a clear error when nothing answers and there is no launch command", async () => {
    const dead = await startFakeCamofoxServer()
    const port = dead.port
    await dead.close()
    const { spawn, calls } = neverSpawn()
    const provider = createCamofoxProvider({ spawn, readPersistedEnv: noPersisted, platform: "linux" })
    await expect(provider.launch({ port, env: { CAMOFOX_SERVE_CMD: "" } }, {})).rejects.toThrow(/no launch command/)
    expect(calls()).toBe(0)
  })

  it("never spawns for a cloud location", async () => {
    const dead = await startFakeCamofoxServer()
    const port = dead.port
    await dead.close()
    const { spawn, calls } = neverSpawn()
    const provider = createCamofoxProvider({ spawn, readPersistedEnv: noPersisted })
    await expect(provider.launch({ port, location: "cloud", launchCmd: "x" }, {})).rejects.toThrow(/nothing was started|does not answer/)
    expect(calls()).toBe(0)
  })
})

// A minimal camofox answering /health on a specific port (the "spawned" server coming up).
async function listenHealthOn(port: number): Promise<{ close(): Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true, engine: "camoufox", browserState: "running" }))
  })
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

describe("camofox client: errors and auth", () => {
  const envBackup = { ...process.env }
  afterEach(() => {
    process.env = { ...envBackup }
  })

  it("throws CamofoxHttpError on a non-2xx answer", async () => {
    const server = await startFakeCamofoxServer()
    try {
      const client = createCamofoxRestClient({ baseUrl: server.baseUrl })
      await expect(client.click("tab-does-not-exist", "#x")).rejects.toBeInstanceOf(CamofoxHttpError)
      await expect(client.click("tab-does-not-exist", "#x")).rejects.toMatchObject({ status: 404 })
    } finally {
      await server.close()
    }
  })

  it("sends the Bearer header when configured", async () => {
    const server = await startFakeCamofoxServer({ apiKey: "s3cret-key" })
    try {
      const client = createCamofoxRestClient({ baseUrl: server.baseUrl, apiKey: "s3cret-key" })
      await client.createSession()
      const tabsReq = server.requests.find((r) => r.path === "/tabs" && r.method === "POST")
      expect(tabsReq?.authorization).toBe("Bearer s3cret-key")

      const anon = createCamofoxRestClient({ baseUrl: server.baseUrl })
      delete process.env["CAMOFOX_API_KEY"]
      await expect(anon.createSession()).rejects.toMatchObject({ status: 401 })
    } finally {
      await server.close()
    }
  })

  it("reads the Bearer key from CAMOFOX_API_KEY", async () => {
    const server = await startFakeCamofoxServer({ apiKey: "env-key" })
    try {
      process.env["CAMOFOX_API_KEY"] = "env-key"
      const client = createCamofoxRestClient({ baseUrl: server.baseUrl })
      await expect(client.createSession()).resolves.toMatchObject({ id: expect.stringMatching(/^tab-/) })
    } finally {
      await server.close()
    }
  })

  it("never puts the API key in logs or error text", async () => {
    const key = "leak-me-not-123"
    const server = await startFakeCamofoxServer({ apiKey: key })
    const lines: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")))
    try {
      const provider = createCamofoxProvider({ apiKey: key, readPersistedEnv: noPersisted, behavior: "fast" })
      const instance = await provider.launch({ baseUrl: server.baseUrl }, { log: (l) => void lines.push(l) })
      const driver = await instance.attach({ initialUrl: "https://example.test/" })
      await driver.close()
      await instance.stop()

      const client = createCamofoxRestClient({ baseUrl: server.baseUrl, apiKey: key })
      const err = await client.click("nope", "#x").catch((e: unknown) => e)
      expect(err).toBeInstanceOf(CamofoxHttpError)
      lines.push((err as Error).message)

      expect(server.requests.some((r) => r.authorization === `Bearer ${key}`)).toBe(true)
      expect(lines.join("\n")).not.toContain(key)
    } finally {
      spy.mockRestore()
      await server.close()
    }
  })

  it("scrubs the key when the server echoes it back in an error body", async () => {
    const key = "echo-key-999"
    const echo = createServer((req, res) => {
      res.writeHead(500)
      res.end(`bad auth ${req.headers.authorization ?? ""}`)
    })
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r))
    const port = (echo.address() as { port: number }).port
    try {
      const client = createCamofoxRestClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key })
      const err = (await client.click("t", "#x").catch((e: unknown) => e)) as Error
      expect(err.message).toContain("HTTP 500")
      expect(err.message).not.toContain(key)
    } finally {
      echo.closeAllConnections()
      await new Promise<void>((r) => echo.close(() => r()))
    }
  })
})

describe("camofox health: lifecycle mapping", () => {
  it("maps a running /health onto the kit lifecycle fields", async () => {
    const server = await startFakeCamofoxServer()
    try {
      const provider = createCamofoxProvider({ spawn: neverSpawn().spawn, readPersistedEnv: noPersisted })
      const instance = await provider.launch({ baseUrl: server.baseUrl }, {})
      const health = await instance.health()
      expect(health.ok).toBe(true)
      expect(health.lifecycle).toMatchObject({ bootId: "boot-fake-1", browserState: "running", lastLaunchMs: 5000 })
    } finally {
      await server.close()
    }
  })

  it("treats 503 crash-looping as a state, not an error", async () => {
    const server = await startFakeCamofoxServer()
    try {
      const { spawn, calls } = neverSpawn()
      const provider = createCamofoxProvider({ spawn, readPersistedEnv: noPersisted })
      const instance = await provider.launch({ baseUrl: server.baseUrl }, {})
      server.setHealth("crash-looping")
      const health = await instance.health()
      expect(health.ok).toBe(false)
      expect(health.lifecycle?.browserState).toBe("crash-looping")
      expect(health.lifecycle?.lastRestartReason).toBe("launch-timeout")
      expect(health.reason).toMatch(/crash-looping/)

      // a crash-looping server is still a server: a fresh launch must not spawn a second one
      const again = await provider.launch({ baseUrl: server.baseUrl }, {})
      expect(again.wasAlreadyRunning).toBe(true)
      expect(calls()).toBe(0)

      server.setHealth("launching")
      const launching = await instance.health()
      expect(launching.ok).toBe(false)
      expect(launching.lifecycle?.browserState).toBe("launching")
    } finally {
      await server.close()
    }
  })

  it("reports an unreachable server as not ok without lifecycle", async () => {
    const server = await startFakeCamofoxServer()
    const provider = createCamofoxProvider({ spawn: neverSpawn().spawn, readPersistedEnv: noPersisted })
    const instance = await provider.launch({ baseUrl: server.baseUrl }, {})
    await server.close()
    const health = await instance.health()
    expect(health.ok).toBe(false)
    expect(health.lifecycle).toBeUndefined()
    expect(health.reason).toMatch(/unreachable/)
  })
})
