import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { SandboxSpec } from "@agentproto/sandbox"
import { SandboxBoxGoneError } from "@agentproto/sandbox"
import { computerSandboxProvider } from "../provider.js"
import { ComputerControllerClient } from "../client.js"
import { FakeController } from "./fake-controller.js"

const SERVICE_TOKEN = "svc-secret-e2e-aaaaaaaaaaaaaaa"

function spec(controllerUrl: string, extra: Record<string, unknown> = {}): SandboxSpec {
  return {
    provider: "computer",
    config: {
      controllerUrl,
      token: SERVICE_TOKEN,
      tenantId: "tenant-a",
      template: "node",
      cpus: 4,
      memoryMiB: 8192,
      ...extra,
    },
  }
}

const bootOpts = { env: { OPENROUTER_API_KEY: "sk-test" } as Record<string, string> }

describe("ComputerControllerClient: empty success bodies", () => {
  it("treats 200/204 with an empty body as {} for suspend/resume/remove", async () => {
    const seen: string[] = []
    const client = new ComputerControllerClient({
      baseUrl: "http://controller.test",
      token: SERVICE_TOKEN,
      tenantId: "tenant-a",
      fetchImpl: (async (_url, init) => {
        seen.push(`${init?.method ?? "GET"}`)
        return new Response(null, { status: 204 }) as Response
      }) as typeof fetch,
    })
    await expect(client.suspend("cmp-1")).resolves.toEqual({})
    await expect(client.resume("cmp-1")).resolves.toEqual({})
    await expect(client.remove("cmp-1")).resolves.toBeUndefined()
    expect(seen).toEqual(["POST", "POST", "DELETE"])
  })
})

describe("FakeController", () => {
  let controller: FakeController

  beforeEach(async () => {
    controller = new FakeController({ token: SERVICE_TOKEN })
    await controller.start()
  })
  afterEach(async () => {
    await controller.stop()
  })

  it("rejects unauthenticated and missing-tenant requests", async () => {
    const client = new ComputerControllerClient({
      baseUrl: controller.url,
      token: "wrong",
      tenantId: "tenant-a",
    })
    await expect(client.getComputer("cmp-001")).rejects.toMatchObject({ status: 401 })
    const noTenant = new ComputerControllerClient({ baseUrl: controller.url, token: SERVICE_TOKEN, tenantId: "other" })
    await expect(noTenant.getComputer("cmp-001")).rejects.toMatchObject({ status: 403 })
  })
})

describe("computerSandboxProvider.boot", () => {
  let controller: FakeController

  beforeEach(async () => {
    controller = new FakeController({ token: SERVICE_TOKEN })
    await controller.start()
  })
  afterEach(async () => {
    await controller.stop()
    vi.restoreAllMocks()
  })

  it("creates a computer, waits for running, installs/starts the daemon and forwards the create payload", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)

    expect(booted.sandboxId).toMatch(/^cmp-/)
    expect(booted.mcpUrl).toBe(`http://${booted.sandboxId}:18790`)

    // create body: validated tenant + template + limits + only controller-shapable env
    expect(controller.createBodies[0]).toMatchObject({
      template: "node",
      tenantId: "tenant-a",
      cpus: 4,
      memoryMiB: 8192,
      env: { OPENROUTER_API_KEY: "sk-test" },
    })

    // exec flow: health probe → CLI install → detached serve → wait-healthy
    const scripts = controller.execs.map((e) => e.argv[2] ?? "")
    expect(scripts.some((s) => s.includes("http://127.0.0.1:18790/health") && !s.includes("sleep 1"))).toBe(true)
    expect(scripts.some((s) => s.includes("npm i -g @agentproto/cli@'latest'"))).toBe(true)
    const serve = scripts.find((s) => s.includes("agentproto serve"))
    expect(serve).toBeDefined()
    expect(serve).toContain("--bind 0.0.0.0")
    expect(serve).toContain("--workspace '/home/user'")
    expect(serve).toMatch(/--auth-token '[0-9a-f-]{36}'/)
    expect(serve).toContain("& echo started")
    expect(scripts.some((s) => s.includes("sleep 1"))).toBe(true)

    // booted handle exec maps onto POST exec
    const result = await booted.exec!({ command: "echo hi" })
    expect(result).toMatchObject({ exitCode: 0 })
    const last = controller.execs[controller.execs.length - 1] as { argv: string[] }
    expect(last.argv[0]).toBe("/bin/bash")
    expect(last.argv[1]).toBe("-lc")
  })

  it("drops env vars the controller would reject", async () => {
    await computerSandboxProvider.boot(
      spec(controller.url),
      { env: { GOOD_VAR: "kept", "bad-key-!dropped": "x", lower_case: "dropped", multiline: "a\nb" } },
    )
    expect((controller.createBodies[0] as { env: Record<string, string> }).env).toEqual({ GOOD_VAR: "kept" })
  })

  it("maps create errors and never leaks a computer on a failed boot", async () => {
    controller.options.createStatus = 400
    controller.options.createError = "unknown template"
    await expect(computerSandboxProvider.boot(spec(controller.url), bootOpts)).rejects.toThrow(
      /create rejected \(HTTP 400, "unknown template"\).*template is not registered/,
    )
    expect(controller.removed).toEqual([])
  })

  it("reclaims the computer when the daemon never becomes healthy", async () => {
    controller.serveFixesHealth = false
    await expect(computerSandboxProvider.boot(spec(controller.url), bootOpts)).rejects.toThrow(
      /daemon did not become healthy/,
    )
    expect(controller.removed).toHaveLength(1)
    expect(controller.removed[0]).toMatch(/^cmp-/)
  })

  it("surfaces controller exec failures during boot", async () => {
    controller.options.execStatus = 500
    await expect(computerSandboxProvider.boot(spec(controller.url), bootOpts)).rejects.toMatchObject({
      name: "ComputerApiError",
      status: 500,
    })
  })

  it("lifecycle: pause=suspend, stop=rm, exec works after boot", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    await booted.pause!()
    expect(controller.suspended).toEqual([booted.sandboxId])
    expect(controller.states.get(booted.sandboxId)).toBe("stopped")

    const booted2 = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    expect(booted2.sandboxId).not.toBe(booted.sandboxId)
    await booted2.stop()
    expect(controller.removed).toEqual([booted2.sandboxId])
    expect(controller.states.has(booted2.sandboxId)).toBe(false)
  })

  it("expose() and extraPorts resolve box URLs", async () => {
    const booted = await computerSandboxProvider.boot(
      spec(controller.url, { gatewayUrl: "http://gate.internal:{port}/computers/{id}" }),
      bootOpts,
    )
    expect(booted.mcpUrl).toBe(`http://gate.internal:18790/computers/${booted.sandboxId}`)
    const exposed = await booted.expose!(3000)
    expect(exposed.url).toBe(`http://gate.internal:3000/computers/${booted.sandboxId}`)
  })

  it("writeFile/readFile round-trips through chunked base64 execs", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    const payload = Buffer.from("x".repeat(20_000) + "y", "utf8")
    await booted.writeFile!("/home/user/data/blob.bin", new Uint8Array(payload))
    const stored = controller.fileSystem.get("/home/user/data/blob.bin")
    expect(stored).toBe(payload.toString("utf8"))

    const read = await booted.readFile!("/home/user/data/blob.bin")
    expect(Buffer.from(read).toString()).toBe(payload.toString())
  })

  it("readFile rejects for a missing file", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    await expect(booted.readFile!("/nope/missing")).rejects.toThrow(/no file at/)
  })

  it("readFile round-trips a multi-byte-block file (>700 KB) without truncation", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    const payload = Buffer.from("a".repeat(750_000) + "TAIL", "utf8")
    await booted.writeFile!("/home/user/data/big.bin", new Uint8Array(payload))

    const read = await booted.readFile!("/home/user/data/big.bin")
    const merged = Buffer.from(read)
    expect(merged.length).toBe(payload.length)
    expect(merged.subarray(-4).toString()).toBe("TAIL")
  })
})

describe("computerSandboxProvider.connect + probe", () => {
  let controller: FakeController

  beforeEach(async () => {
    controller = new FakeController({ token: SERVICE_TOKEN })
    await controller.start()
  })
  afterEach(async () => {
    await controller.stop()
  })

  it("resumes a suspended computer, adopts the controller's new id and aliases the old one", async () => {
    process.env.COMPUTER_CONTROLLER_URL = controller.url
    process.env.COMPUTER_CONTROLLER_TOKEN = SERVICE_TOKEN
    process.env.COMPUTER_TENANT_ID = "tenant-a"
    try {
      const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
      await booted.pause!()
      const oldId = booted.sandboxId

      const reconnected = await computerSandboxProvider.connect!(
        oldId,
        spec(controller.url),
        bootOpts,
      )
      expect(controller.resumed).toEqual([oldId])
      expect(reconnected.sandboxId).not.toBe(oldId)
      expect(controller.states.get(reconnected.sandboxId)).toBe("running")

      // the old id still resolves for liveness via the in-process alias
      const alive = await computerSandboxProvider.probe!(oldId)
      expect(alive).toEqual({ alive: true, state: "running" })
      const dead = await computerSandboxProvider.probe!("cmp-not-a-box")
      expect(dead).toEqual({ alive: false })
    } finally {
      delete process.env.COMPUTER_CONTROLLER_URL
      delete process.env.COMPUTER_CONTROLLER_TOKEN
      delete process.env.COMPUTER_TENANT_ID
    }
  })

  it("connect on an expired id throws SandboxBoxGoneError", async () => {
    await expect(
      computerSandboxProvider.connect!("cmp-gone", spec(controller.url), bootOpts),
    ).rejects.toBeInstanceOf(SandboxBoxGoneError)
  })

  it("probe uses the boot-time spec config (no env needed)", async () => {
    // No COMPUTER_CONTROLLER_* env: probe must still reach the controller
    // using the config captured at boot.
    delete process.env.COMPUTER_CONTROLLER_URL
    delete process.env.COMPUTER_CONTROLLER_TOKEN
    process.env.COMPUTER_TENANT_ID = "tenant-a"
    try {
      const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
      expect(await computerSandboxProvider.probe!(booted.sandboxId)).toEqual({ alive: true, state: "running" })
    } finally {
      delete process.env.COMPUTER_TENANT_ID
    }
  })
})
