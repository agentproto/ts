import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { SandboxSpec } from "@agentproto/sandbox"
import { computerSandboxProvider } from "../provider.js"
import { ComputerControllerClient } from "../client.js"
import { FakeController } from "./fake-controller.js"

const SERVICE_TOKEN = "svc-token-n0-leak-please-123456"
const DAEMON_TOKEN_RE = /--auth-token '([0-9a-f-]{36})'/

function spec(controllerUrl: string, extra: Record<string, unknown> = {}): SandboxSpec {
  return {
    provider: "computer",
    config: { controllerUrl, token: SERVICE_TOKEN, tenantId: "tenant-a", ...extra },
  }
}
const bootOpts = { env: { SESSION_CREDENTIAL: "sk-session" } }

describe("token hygiene", () => {
  let controller: FakeController
  let consoleSpies: ReturnType<typeof vi.spyOn>[]

  beforeEach(async () => {
    controller = new FakeController({ token: SERVICE_TOKEN })
    await controller.start()
    consoleSpies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")]
  })
  afterEach(async () => {
    await controller.stop()
    vi.restoreAllMocks()
  })

  it("the controller service token never appears in errors, the create env, or emitted output", async () => {
    // Make the controller fail with the token echoed back (a real leak class).
    controller.options.createStatus = 500
    controller.options.createError = `mystery failed for ${SERVICE_TOKEN}`

    let thrown: Error | undefined
    try {
      await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    } catch (err) {
      thrown = err as Error
    }
    expect(thrown).toBeDefined()
    const blob = JSON.stringify(thrown?.stack ?? "") + JSON.stringify([String(thrown?.message)])
    expect(blob).not.toContain(SERVICE_TOKEN)
    expect(blob).toContain("[redacted]")

    // The create payload (near "box env") never carries the service token.
    for (const body of controller.createBodies) {
      expect(JSON.stringify(body)).not.toContain(SERVICE_TOKEN)
    }

    // This package never logs.
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
  })

  it("the per-box daemon token only surfaces as the handle's token/authHeaders, never elsewhere or in errors", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    const serveScript = controller.execs.map((e) => e.argv[2] ?? "").find((s) => s.includes("agentproto serve"))
    expect(serveScript).toBeDefined()
    const daemonToken = DAEMON_TOKEN_RE.exec(serveScript as string)?.[1]
    expect(daemonToken).toBeDefined()

    // The host authenticates with it via token/authHeaders; no other handle
    // field (mcpUrl, ports, id, ...) may carry it.
    expect(booted.token).toBe(daemonToken)
    expect(booted.authHeaders).toEqual({ Authorization: `Bearer ${daemonToken}` })
    const surfaced = JSON.stringify({
      ...booted,
      token: undefined,
      authHeaders: undefined,
      exec: undefined,
      readFile: undefined,
      writeFile: undefined,
      expose: undefined,
    })
    expect(surfaced).not.toContain(daemonToken)

    // An exec failure message must not embed the serve command (the only
    // place the token exists) — errors quote ids, never downstream argv.
    let thrown: Error | undefined
    try {
      controller.serveFixesHealth = false
      // reconnect path: suspend then connect forces a fresh daemon start
      await booted.pause!()
      await computerSandboxProvider.connect!(booted.sandboxId, spec(controller.url), bootOpts)
    } catch (err) {
      thrown = err as Error
    }
    // After suspend the original box is replaced by a restored one whose
    // boot ALSO starts a daemon — either way the original token must never
    // appear anywhere in the surfaced error text.
    expect(String(thrown ?? "no-error")).not.toContain(daemonToken)
  })

  it("the client redacts the token from transport failures too", async () => {
    const client = new ComputerControllerClient({
      baseUrl: "http://127.0.0.1:1",
      token: SERVICE_TOKEN,
      tenantId: "tenant-a",
    })
    let message = ""
    try {
      await client.getComputer("cmp-x")
    } catch (err) {
      message = String((err as Error).message)
    }
    expect(message).not.toContain(SERVICE_TOKEN)
  })
})

describe("sharedSessions + maxSessions", () => {
  let controller: FakeController

  beforeEach(async () => {
    controller = new FakeController({ token: SERVICE_TOKEN })
    await controller.start()
  })
  afterEach(async () => {
    await controller.stop()
  })

  it("maxSessions: 1 — a second connect on the same computer is refused, another is fine", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url, { maxSessions: 1 }), bootOpts)
    await expect(
      computerSandboxProvider.connect!(booted.sandboxId, spec(controller.url, { maxSessions: 1 }), bootOpts),
    ).rejects.toThrow(/attach to the existing session instead/)

    const booted2 = await computerSandboxProvider.boot(spec(controller.url, { maxSessions: 1 }), bootOpts)
    expect(booted2.sandboxId).not.toBe(booted.sandboxId)
    await booted.stop!()
    await booted2.stop()
  })

  it("stop releases the slot: re-booting a fresh box always works", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url, { maxSessions: 1 }), bootOpts)
    await booted.stop!()
    const booted2 = await computerSandboxProvider.boot(spec(controller.url, { maxSessions: 1 }), bootOpts)
    await booted2.stop()
  })
})
