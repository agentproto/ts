import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { camofox } from "@agentproto/adapter-browser-camofox"
import { browserAdapters, getBrowserAdapter, toAdapterHandle } from "../index.js"
import { chromium } from "@agentproto/adapter-browser-chromium"
import { chromiumProvider } from "../adapters/chromium.js"

const servers: Server[] = []

async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return (server.address() as AddressInfo).port
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections()
          s.close(() => resolve())
        }),
    ),
  )
})

const json = (body: unknown): Parameters<typeof createServer>[1] => (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

describe("adapter-browser facade", () => {
  it("keeps the public registry shape for camofox, bureau and chromium", () => {
    expect(Object.keys(browserAdapters).sort()).toEqual(["bureau", "camofox", "chromium"])
    const expected = {
      camofox: { defaultPort: 9377, healthPath: "/health" },
      bureau: { defaultPort: 8830, healthPath: "/health" },
      chromium: { defaultPort: 3200, healthPath: "/healthz" },
    }
    for (const [id, want] of Object.entries(expected)) {
      const handle = getBrowserAdapter(id)
      expect(handle?.id).toBe(id)
      expect(handle?.defaultPort).toBe(want.defaultPort)
      expect(handle?.healthPath).toBe(want.healthPath)
      expect(handle?.location).toBe("local")
      expect(typeof handle?.name).toBe("string")
      expect(typeof handle?.description).toBe("string")
      expect(typeof handle?.ensure).toBe("function")
    }
    expect(getBrowserAdapter("nope")).toBeUndefined()
  })

  it("keeps the declarative manifest fields", () => {
    expect(getBrowserAdapter("camofox")?.requires?.nativeLaunchOs).toEqual(["darwin"])
    expect(getBrowserAdapter("camofox")?.config?.[0]?.persist?.env).toBe("CAMOFOX_SERVE_CMD")
    expect(getBrowserAdapter("bureau")?.config?.map((c) => c.persist?.env)).toEqual(["BUREAU_SERVE_CMD", "BUREAU_PORT"])
    expect(getBrowserAdapter("chromium")?.config?.map((c) => c.persist?.env)).toEqual(["CHROMIUM_EXECUTABLE_PATH"])
  })

  it("camofox.ensure reuses a healthy server: wasAlreadyRunning, no pid, healthy", async () => {
    const port = await listen(json({ ok: true, engine: "camoufox", browserState: "running" }))
    const instance = await getBrowserAdapter("camofox")!.ensure({ port, launchCmd: "exit 1" })
    expect(instance).toMatchObject({
      id: "camofox",
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      wasAlreadyRunning: true,
      healthy: true,
    })
    expect(instance.pid).toBeUndefined()
    await instance.stop()
  })

  it("bureau.ensure brings camofox up first and reuses a healthy bureau", async () => {
    const camofoxPort = await listen(json({ ok: true, engine: "camoufox", browserState: "idle" }))
    const bureauPort = await listen(json({ ok: true }))
    const instance = await getBrowserAdapter("bureau")!.ensure({ port: bureauPort, camofoxPort })
    expect(instance).toMatchObject({ id: "bureau", port: bureauPort, wasAlreadyRunning: true, healthy: true })
    await instance.stop()
  })

  it("chromium is backed by the real Playwright provider, not a service process", () => {
    expect(chromiumProvider).toBe(chromium)
    expect(chromiumProvider.capabilities).toMatchObject({ cdp: true, persistentProfile: true, stealth: false })
    expect(getBrowserAdapter("chromium")?.install).toEqual([{ method: "path" }])
  })

  it("chromium.ensure refuses location=cloud and reports a missing binary clearly", async () => {
    const handle = getBrowserAdapter("chromium")!
    await expect(handle.ensure({ location: "cloud", baseUrl: "https://example.test" })).rejects.toThrow(/runs locally/)
    await expect(handle.ensure({ binPath: "/nonexistent/chromium-binary", timeoutMs: 10_000 })).rejects.toThrow()
  }, 30_000)

  it("toAdapterHandle maps a kit provider onto the legacy handle", async () => {
    const handle = toAdapterHandle(camofox, { defaultPort: 9377, healthPath: "/health" })
    expect(handle.id).toBe("camofox")
    expect(handle.name).toBe(camofox.name)
    const port = await listen(json({ ok: true, engine: "camoufox", browserState: "running" }))
    expect((await handle.ensure({ port })).wasAlreadyRunning).toBe(true)
  })
})
