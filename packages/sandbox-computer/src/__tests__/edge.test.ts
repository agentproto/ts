import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SandboxSpec } from "@agentproto/sandbox"
import { computerSandboxProvider } from "../provider.js"
import { ComputerControllerClient, sanitizeExtraHeaders } from "../client.js"
import { FakeController } from "./fake-controller.js"

const SERVICE_TOKEN = "svc-token-edge-0123456789abcdef"
const EDGE_ID = "edge-id.access"
const EDGE_SECRET = "edge-secret-0123456789abcdef"

function spec(controllerUrl: string, extra: Record<string, unknown> = {}): SandboxSpec {
  return {
    provider: "computer",
    config: { controllerUrl, token: SERVICE_TOKEN, tenantId: "tenant-a", ...extra },
  }
}
const bootOpts = { env: {} as Record<string, string> }

const ENV_KEYS = [
  "COMPUTER_ACCESS_CLIENT_ID",
  "COMPUTER_ACCESS_CLIENT_SECRET",
  "COMPUTER_EXTRA_HEADERS",
  "COMPUTER_DAEMON_ROUTE",
  "COMPUTER_GATEWAY_URL",
]

describe("sanitizeExtraHeaders", () => {
  it("keeps well-formed headers and drops reserved, malformed or multi-line ones", () => {
    expect(
      sanitizeExtraHeaders({
        "CF-Access-Client-Id": "a",
        Authorization: "Bearer x",
        "x-tenant-id": "other",
        "Content-Type": "text/plain",
        "bad name": "v",
        "X-Multi": "a\r\nb",
        "X-Empty": "",
      }),
    ).toEqual({ "CF-Access-Client-Id": "a" })
  })
})

describe("extra headers", () => {
  let controller: FakeController
  const saved: Record<string, string | undefined> = {}

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    controller = new FakeController({
      token: SERVICE_TOKEN,
      requireHeaders: { "cf-access-client-id": EDGE_ID, "cf-access-client-secret": EDGE_SECRET },
    })
    await controller.start()
  })
  afterEach(async () => {
    await controller.stop()
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    vi.restoreAllMocks()
  })

  it("the client sends them on every call but never overrides its own headers", async () => {
    const client = new ComputerControllerClient({
      baseUrl: controller.url,
      token: SERVICE_TOKEN,
      tenantId: "tenant-a",
      extraHeaders: {
        "CF-Access-Client-Id": EDGE_ID,
        "CF-Access-Client-Secret": EDGE_SECRET,
        Authorization: "Bearer hijack",
      },
    })
    await expect(client.getComputer("cmp-001")).resolves.toBeNull()
    const seen = controller.requestHeaders.at(-1)
    expect(seen?.["cf-access-client-id"]).toBe(EDGE_ID)
    expect(seen?.authorization).toBe(`Bearer ${SERVICE_TOKEN}`)
  })

  it("without them the edge refuses", async () => {
    const client = new ComputerControllerClient({
      baseUrl: controller.url,
      token: SERVICE_TOKEN,
      tenantId: "tenant-a",
    })
    await expect(client.getComputer("cmp-001")).rejects.toMatchObject({ status: 403 })
  })

  it("redacts them from error messages", async () => {
    controller.options.requireHeaders = undefined
    controller.options.createStatus = 500
    controller.options.createError = `echo ${EDGE_SECRET} and ${SERVICE_TOKEN}`
    const client = new ComputerControllerClient({
      baseUrl: controller.url,
      token: SERVICE_TOKEN,
      tenantId: "tenant-a",
      extraHeaders: { "CF-Access-Client-Secret": EDGE_SECRET },
    })
    const err = await client.createComputer({ template: "t", tenantId: "tenant-a" }).catch((e: unknown) => e)
    const blob = JSON.stringify([String((err as Error).message), (err as Error).stack])
    expect(blob).not.toContain(EDGE_SECRET)
    expect(blob).not.toContain(SERVICE_TOKEN)
  })

  it("the access env pair and COMPUTER_EXTRA_HEADERS reach the controller through the provider", async () => {
    process.env.COMPUTER_ACCESS_CLIENT_ID = EDGE_ID
    process.env.COMPUTER_ACCESS_CLIENT_SECRET = EDGE_SECRET
    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    expect(controller.requestHeaders.every((h) => h["cf-access-client-id"] === EDGE_ID)).toBe(true)
    await booted.stop()

    delete process.env.COMPUTER_ACCESS_CLIENT_ID
    delete process.env.COMPUTER_ACCESS_CLIENT_SECRET
    process.env.COMPUTER_EXTRA_HEADERS = JSON.stringify({
      "CF-Access-Client-Id": EDGE_ID,
      "CF-Access-Client-Secret": EDGE_SECRET,
    })
    const again = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    await again.stop()
  })

  it("a malformed COMPUTER_EXTRA_HEADERS is ignored without echoing it", async () => {
    controller.options.requireHeaders = undefined
    process.env.COMPUTER_EXTRA_HEADERS = "{not json secret-material"
    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    await booted.stop()
  })
})

describe("daemon route mode", () => {
  let controller: FakeController
  const saved: Record<string, string | undefined> = {}

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    controller = new FakeController({ token: SERVICE_TOKEN })
    await controller.start()
  })
  afterEach(async () => {
    await controller.stop()
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it("fronts the controller route with a local loopback proxy — the controller token and edge secret never leave this process", async () => {
    const booted = await computerSandboxProvider.boot(
      spec(controller.url, { daemonRoute: true, extraHeaders: { "CF-Access-Client-Id": "id-1" } }),
      bootOpts,
    )
    // mcpUrl is a local loopback address, not the controller's own URL.
    expect(booted.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(booted.mcpUrl).not.toContain(controller.url.replace(/^http:\/\//, ""))
    // The only header a caller gets is the box's own per-box bearer — never
    // the controller's tenant-wide token or the edge Access secret. This is
    // exactly what a caller would persist into a session descriptor or a
    // paste-ready .mcp.json (buildMcpConfigSnippet), so it is the whole
    // point of the fix.
    expect(booted.authHeaders).toEqual({ Authorization: `Bearer ${booted.token}` })
    const snippet = JSON.stringify(booted)
    expect(snippet).not.toContain(SERVICE_TOKEN)
    expect(snippet).not.toContain("id-1")
    expect(snippet).not.toContain("X-Controller-Authorization")

    // The local proxy still gets the request through to the real route,
    // with the controller credential and the edge secret attached there —
    // the daemon's own Authorization passes through untouched.
    const res = await fetch(`${booted.mcpUrl}?q=1`, { headers: booted.authHeaders })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { echoPath: string; sawAuthorization: string | null }
    expect(body.echoPath).toBe("/mcp?q=1")
    expect(body.sawAuthorization).toBe(`Bearer ${booted.token}`)
    const seen = controller.daemonProxyRequests.at(-1)
    expect(seen?.headers["x-controller-authorization"]).toBe(`Bearer ${SERVICE_TOKEN}`)
    expect(seen?.headers["x-tenant-id"]).toBe("tenant-a")
    expect(seen?.headers["cf-access-client-id"]).toBe("id-1")
    await booted.stop()
  })

  it("is enabled by COMPUTER_DAEMON_ROUTE and survives a reconnect, still never exposing the controller token", async () => {
    process.env.COMPUTER_DAEMON_ROUTE = "1"
    const shared = { maxSessions: 99 }
    const booted = await computerSandboxProvider.boot(spec(controller.url, shared), bootOpts)
    const again = await computerSandboxProvider.connect!(booted.sandboxId, spec(controller.url, shared), bootOpts)
    expect(again.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(again.authHeaders).toEqual({ Authorization: `Bearer ${again.token}` })
    await again.stop()
  })

  it("daemonRoute works without gatewayUrl", async () => {
    const booted = await computerSandboxProvider.boot(
      spec(controller.url, { daemonRoute: true }),
      bootOpts,
    )
    expect(booted.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(booted.authHeaders).toEqual({ Authorization: `Bearer ${booted.token}` })
    await booted.stop()
  })

  it("rejects an explicit gatewayUrl alongside daemonRoute as conflicting config", async () => {
    await expect(
      computerSandboxProvider.boot(
        spec(controller.url, { daemonRoute: true, gatewayUrl: "http://gw.test:{port}/{id}" }),
        bootOpts,
      ),
    ).rejects.toThrow(/mutually exclusive/)
    expect(controller.createBodies).toEqual([])
  })

  it("rejects extraPorts and expose() in true route mode instead of pointing them at the daemon", async () => {
    const booted = await computerSandboxProvider.boot(
      { ...spec(controller.url, { daemonRoute: true }), extraPorts: [9999] } as unknown as SandboxSpec,
      bootOpts,
    ).catch((err: unknown) => err as Error)
    expect((booted as Error).message).toMatch(/extraPorts are not reachable/)

    const ok = await computerSandboxProvider.boot(spec(controller.url, { daemonRoute: true }), bootOpts)
    await expect(ok.expose!(9999)).rejects.toThrow(/cannot expose arbitrary ports/)
    await ok.stop()
  })

  it("restarts a stale-origin daemon through the route on reconnect, same as the gatewayUrl path", async () => {
    const shared = { daemonRoute: true, maxSessions: 99 }
    const booted = await computerSandboxProvider.boot(spec(controller.url, shared), bootOpts)
    const first = controller.daemonOrigin
    expect(first).toBeTruthy()
    // Model the controller republishing under a route that resolves to a
    // different origin (e.g. a tunnel hostname change) by booting fresh and
    // reconnecting against a controller whose recorded origin no longer
    // matches what this reconnect would compute — same staleness check the
    // {hostPort} gatewayUrl path already relies on.
    controller.daemonOrigin = "http://stale.invalid"
    const again = await computerSandboxProvider.connect!(booted.sandboxId, spec(controller.url, shared), bootOpts)
    // A restart was forced: the recorded origin is the current one again,
    // not the stale value we injected.
    expect(controller.daemonOrigin).not.toBe("http://stale.invalid")
    expect(again.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    await again.stop()
  })

  it("leaves authHeaders unchanged when the route mode is off", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    expect(Object.keys(booted.authHeaders ?? {})).toEqual(["Authorization"])
    await booted.stop()
  })
})
