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

  it("points the daemon URL at the controller route and carries both credentials", async () => {
    const booted = await computerSandboxProvider.boot(
      spec(controller.url, { daemonRoute: true, extraHeaders: { "CF-Access-Client-Id": "id-1" } }),
      bootOpts,
    )
    expect(booted.mcpUrl).toBe(`${controller.url}/v1/computers/${booted.sandboxId}/daemon/mcp`)
    expect(booted.authHeaders?.["X-Controller-Authorization"]).toBe(`Bearer ${SERVICE_TOKEN}`)
    expect(booted.authHeaders?.["X-Tenant-Id"]).toBe("tenant-a")
    expect(booted.authHeaders?.["CF-Access-Client-Id"]).toBe("id-1")
    // The daemon keeps its own bearer in Authorization.
    expect(booted.authHeaders?.Authorization).toBe(`Bearer ${booted.token}`)
    expect(booted.authHeaders?.Authorization).not.toContain(SERVICE_TOKEN)
    await booted.stop()
  })

  it("is enabled by COMPUTER_DAEMON_ROUTE and survives a reconnect", async () => {
    process.env.COMPUTER_DAEMON_ROUTE = "1"
    const shared = { maxSessions: 99 }
    const booted = await computerSandboxProvider.boot(spec(controller.url, shared), bootOpts)
    const again = await computerSandboxProvider.connect!(booted.sandboxId, spec(controller.url, shared), bootOpts)
    expect(again.mcpUrl).toBe(`${controller.url}/v1/computers/${booted.sandboxId}/daemon/mcp`)
    expect(again.authHeaders?.["X-Controller-Authorization"]).toBe(`Bearer ${SERVICE_TOKEN}`)
    await again.stop()
  })

  it("an explicit gatewayUrl wins over the route", async () => {
    const booted = await computerSandboxProvider.boot(
      spec(controller.url, { daemonRoute: true, gatewayUrl: "http://gw.test:{port}/{id}" }),
      bootOpts,
    )
    expect(booted.mcpUrl).toBe(`http://gw.test:18790/${booted.sandboxId}/mcp`)
    await booted.stop()
  })

  it("leaves authHeaders unchanged when the route mode is off", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    expect(Object.keys(booted.authHeaders ?? {})).toEqual(["Authorization"])
    await booted.stop()
  })
})
