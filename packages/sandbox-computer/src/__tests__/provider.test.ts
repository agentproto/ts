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
    expect(booted.mcpUrl).toBe(`http://${booted.sandboxId}:18790/mcp`)

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
    expect(scripts.some((s) => s.includes(`npm i -g --prefix "$HOME/.local" @agentproto/cli@'latest'`))).toBe(true)
    const serve = scripts.find((s) => s.includes("agentproto serve"))
    expect(serve).toBeDefined()
    expect(serve).toContain(`export PATH="$HOME/.local/bin:$PATH"; `)
    expect(serve).toContain("--bind 0.0.0.0")
    expect(serve).toContain("--workspace '/home/user'")
    expect(serve).toMatch(/--auth-token '[0-9a-f-]{36}'/)
    expect(serve).toContain("& echo started")
    // uid 1000 cannot write /var/log: the daemon log must live under $HOME
    expect(serve).toContain(`> "$HOME/.agentproto-daemon.log" 2>&1`)
    expect(serve).not.toContain("/var/log")
    expect(scripts.some((s) => s.includes("sleep 1"))).toBe(true)

    // booted handle exec maps onto POST exec
    const result = await booted.exec!({ command: "echo hi" })
    expect(result).toMatchObject({ exitCode: 0 })
    const last = controller.execs[controller.execs.length - 1] as { argv: string[] }
    expect(last.argv[0]).toBe("/bin/bash")
    expect(last.argv[1]).toBe("-lc")
  })

  it("returns the per-box daemon token and auth headers, and persists the token in the box", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    const serve = controller.execs.map((e) => e.argv[2] ?? "").find((s) => s.includes("agentproto serve")) ?? ""
    const inBox = /--auth-token '([^']*)'/.exec(serve)?.[1]
    expect(inBox).toMatch(/^[0-9a-f-]{36}$/)
    expect(booted.token).toBe(inBox)
    expect(booted.authHeaders).toEqual({ Authorization: `Bearer ${inBox}` })
    expect(serve).toContain(`umask 077; printf %s '${inBox}' > "$HOME/.agentproto-daemon.token"`)
    expect(serve.indexOf("printf %s")).toBeLessThan(serve.indexOf("nohup"))
    // The controller service token is never what the host presents to the daemon.
    expect(JSON.stringify(booted.authHeaders)).not.toContain(SERVICE_TOKEN)
  })

  it("reads the daemon token back on connect when the daemon is already up", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url, { maxSessions: 99 }), bootOpts)
    const again = await computerSandboxProvider.connect!(booted.sandboxId, spec(controller.url, { maxSessions: 99 }), bootOpts)
    expect(again.token).toBe(booted.token)
    expect(again.authHeaders).toEqual(booted.authHeaders)
    expect(controller.serveCount).toBe(1)
  })

  it("omits the token for a healthy daemon the image autostarted without one", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url, { maxSessions: 99 }), bootOpts)
    controller.daemonToken = undefined
    const again = await computerSandboxProvider.connect!(booted.sandboxId, spec(controller.url, { maxSessions: 99 }), bootOpts)
    expect(again.token).toBeUndefined()
    expect(again.authHeaders).toBeUndefined()
  })

  it("forwards the egress allowlist as create egress.allow, defaulting to port 443", async () => {
    await computerSandboxProvider.boot(
      spec(controller.url, {
        egress: ["github.com", "registry.npmjs.org:443", { host: "opencode.ai" }, { host: "x.test", port: 8443 }, "", 7],
      }),
      bootOpts,
    )
    expect((controller.createBodies[0] as { egress: unknown }).egress).toEqual({
      allow: [
        { host: "github.com", port: 443 },
        { host: "registry.npmjs.org", port: 443 },
        { host: "opencode.ai", port: 443 },
        { host: "x.test", port: 8443 },
      ],
    })
  })

  it("omits egress from the create body when none is configured", async () => {
    await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    expect(controller.createBodies[0]).not.toHaveProperty("egress")
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
      /create rejected \(HTTP 400, "unknown template"\).*config\.template/,
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

  it("fails fast with the install error and reclaims the computer when the CLI install exits non-zero", async () => {
    controller.options.execOutcome = (argv) =>
      (argv[2] ?? "").includes("npm i -g")
        ? { exitCode: 243, stdout: "", stderr: "npm error EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@agentproto'" }
        : undefined
    await expect(computerSandboxProvider.boot(spec(controller.url), bootOpts)).rejects.toThrow(
      /CLI install failed on computer "cmp-[^"]+" \(exit 243\): npm error EACCES/,
    )
    expect(controller.removed).toHaveLength(1)
    expect(controller.execs.some((e) => (e.argv[2] ?? "").includes("agentproto serve"))).toBe(false)
  })

  it("skips the npm CLI install when the image already carries the agentproto CLI", async () => {
    controller.cliBaked = true
    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    const scripts = controller.execs.map((e) => e.argv[2] ?? "")
    expect(scripts.some((s) => s.includes("agentproto --version"))).toBe(true)
    expect(scripts.some((s) => s.includes("npm i -g"))).toBe(false)
    expect(scripts.some((s) => s.includes("agentproto serve"))).toBe(true)
    expect(booted.sandboxId).toMatch(/^cmp-/)
  })

  it("still installs when the baked CLI does not match a pinned cliVersion, or extra packages are requested", async () => {
    controller.cliBaked = true
    await computerSandboxProvider.boot(spec(controller.url, { cliVersion: "1.30.0" }), bootOpts)
    expect(controller.execs.some((e) => (e.argv[2] ?? "").includes("npm i -g"))).toBe(true)

    controller.execs.length = 0
    controller.serveSeen = false
    await computerSandboxProvider.boot(spec(controller.url, { cliVersion: "1.26.0" }), bootOpts)
    expect(controller.execs.some((e) => (e.argv[2] ?? "").includes("npm i -g"))).toBe(false)

    controller.execs.length = 0
    controller.serveSeen = false
    await computerSandboxProvider.boot(spec(controller.url, { installPackages: ["@agentproto/adapter-opencode"] }), bootOpts)
    expect(controller.execs.some((e) => (e.argv[2] ?? "").includes("npm i -g"))).toBe(true)
  })

  it("compares the pinned cliVersion exactly, not as a substring", async () => {
    controller.cliBaked = true
    const installsFor = async (cliVersion: string): Promise<boolean> => {
      controller.execs.length = 0
      controller.serveSeen = false
      await computerSandboxProvider.boot(spec(controller.url, { cliVersion }), bootOpts)
      return controller.execs.some((e) => (e.argv[2] ?? "").includes("npm i -g"))
    }
    expect(await installsFor("1.2")).toBe(true)
    expect(await installsFor("1.26")).toBe(true)
    expect(await installsFor("1.26.00")).toBe(true)
    expect(await installsFor("1.26.0-beta.1")).toBe(true)
    expect(await installsFor("1.26.0")).toBe(false)
    expect(await installsFor("v1.26.0")).toBe(false)
  })

  it("restarts a healthy daemon on connect when its recorded origin is stale", async () => {
    const gw = { gatewayUrl: "http://127.0.0.1:{hostPort}", maxSessions: 99 }
    controller.options.publishedPorts = [{ host: 20011, guest: 18790 }]
    const booted = await computerSandboxProvider.boot(spec(controller.url, gw), bootOpts)
    expect(controller.daemonOrigin).toBe("http://127.0.0.1:20011")
    const serves = controller.serveCount

    // Same origin: the running daemon is left alone.
    await computerSandboxProvider.connect!(booted.sandboxId, spec(controller.url, gw), bootOpts)
    expect(controller.killCount).toBe(0)
    expect(controller.serveCount).toBe(serves)

    // Host port changed: the daemon is restarted with the new origin.
    controller.options.publishedPorts = [{ host: 20012, guest: 18790 }]
    controller.execs.length = 0
    const again = await computerSandboxProvider.connect!(booted.sandboxId, spec(controller.url, gw), bootOpts)
    expect(again.mcpUrl).toBe("http://127.0.0.1:20012/mcp")
    expect(controller.killCount).toBe(1)
    expect(controller.serveCount).toBe(serves + 1)
    expect(controller.daemonOrigin).toBe("http://127.0.0.1:20012")
    // the restarted daemon has a fresh token, and the handle carries that one
    expect(again.token).toBe(controller.daemonToken)
    expect(again.token).not.toBe(booted.token)
    expect(controller.execs.some((e) => (e.argv[2] ?? "").includes("npm i -g"))).toBe(false)
  })

  it("recovers the published host port from the in-box origin marker when GET omits ports", async () => {
    const gw = { gatewayUrl: "http://127.0.0.1:{hostPort}", maxSessions: 99 }
    controller.options.publishedPorts = [{ host: 20031, guest: 18790 }]
    const booted = await computerSandboxProvider.boot(spec(controller.url, gw), bootOpts)
    controller.options.getOmitsPorts = true
    const again = await computerSandboxProvider.connect!(booted.sandboxId, spec(controller.url, gw), bootOpts)
    expect(again.mcpUrl).toBe("http://127.0.0.1:20031/mcp")
    expect(again.token).toBe(booted.token)
    expect(controller.killCount).toBe(0)
  })

  it("still fails clearly when GET omits ports and the box has no origin marker", async () => {
    const gw = { gatewayUrl: "http://127.0.0.1:{hostPort}", maxSessions: 99 }
    controller.options.publishedPorts = [{ host: 20041, guest: 18790 }]
    const booted = await computerSandboxProvider.boot(spec(controller.url, gw), bootOpts)
    controller.options.getOmitsPorts = true
    controller.daemonOrigin = undefined
    await expect(
      computerSandboxProvider.connect!(booted.sandboxId, spec(controller.url, gw), bootOpts),
    ).rejects.toThrow(/published no host port/)
  })

  it("falls back to COMPUTER_GATEWAY_URL when the spec carries no gatewayUrl (daemon re-attach path)", async () => {
    const previous = process.env.COMPUTER_GATEWAY_URL
    process.env.COMPUTER_GATEWAY_URL = "http://127.0.0.1:{hostPort}"
    try {
      controller.options.publishedPorts = [{ host: 20051, guest: 18790 }]
      const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
      expect(booted.mcpUrl).toBe("http://127.0.0.1:20051/mcp")
      const explicit = await computerSandboxProvider.boot(
        spec(controller.url, { gatewayUrl: "http://gw.test:{port}/{id}" }),
        bootOpts,
      )
      expect(explicit.mcpUrl).toBe(`http://gw.test:18790/${explicit.sandboxId}/mcp`)
    } finally {
      if (previous === undefined) delete process.env.COMPUTER_GATEWAY_URL
      else process.env.COMPUTER_GATEWAY_URL = previous
    }
  })

  it("leaves a healthy daemon without an origin marker alone on connect", async () => {
    const gw = { gatewayUrl: "http://127.0.0.1:{hostPort}", maxSessions: 99 }
    controller.options.publishedPorts = [{ host: 20021, guest: 18790 }]
    const booted = await computerSandboxProvider.boot(spec(controller.url, gw), bootOpts)
    controller.daemonOrigin = undefined
    controller.options.publishedPorts = [{ host: 20022, guest: 18790 }]
    await computerSandboxProvider.connect!(booted.sandboxId, spec(controller.url, gw), bootOpts)
    expect(controller.killCount).toBe(0)
  })

  it("resolves {hostPort} in gatewayUrl from the published ports, and allows that origin on the daemon", async () => {
    controller.options.publishedPorts = [{ host: 20003, guest: 18790 }]
    const booted = await computerSandboxProvider.boot(
      spec(controller.url, { gatewayUrl: "http://127.0.0.1:{hostPort}" }),
      bootOpts,
    )
    expect(booted.mcpUrl).toBe("http://127.0.0.1:20003/mcp")
    const serve = controller.execs.map((e) => e.argv[2] ?? "").find((s) => s.includes("agentproto serve"))
    expect(serve).toContain("--allow-origin 'http://127.0.0.1:20003'")
    expect((await booted.expose!(18790)).url).toBe("http://127.0.0.1:20003")
  })

  it("fails the boot and reclaims the computer when {hostPort} has no published port", async () => {
    await expect(
      computerSandboxProvider.boot(spec(controller.url, { gatewayUrl: "http://127.0.0.1:{hostPort}" }), bootOpts),
    ).rejects.toThrow(/published no host port for guest port 18790/)
    expect(controller.removed).toHaveLength(1)
  })

  it("connect re-resolves {hostPort} from the controller's status", async () => {
    controller.options.publishedPorts = [{ host: 20007, guest: 18790 }]
    const gw = { gatewayUrl: "http://127.0.0.1:{hostPort}", maxSessions: 99 }
    const booted = await computerSandboxProvider.boot(spec(controller.url, gw), bootOpts)
    const again = await computerSandboxProvider.connect!(booted.sandboxId, spec(controller.url, gw), bootOpts)
    expect(again.mcpUrl).toBe("http://127.0.0.1:20007/mcp")
  })

  it("fails the boot when a setup command exits non-zero", async () => {
    controller.options.execOutcome = (argv) =>
      (argv[2] ?? "").includes("make-it-fail") ? { exitCode: 2, stdout: "", stderr: "boom" } : undefined
    await expect(
      computerSandboxProvider.boot(spec(controller.url, { setupCommands: ["make-it-fail"] }), bootOpts),
    ).rejects.toThrow(/setup command failed on computer "cmp-[^"]+" \(exit 2\): boom/)
    expect(controller.removed).toHaveLength(1)
  })

  it("hints at the template registry when the controller answers invalid body", async () => {
    controller.options.createStatus = 400
    controller.options.createError = "invalid body"
    await expect(computerSandboxProvider.boot(spec(controller.url), bootOpts)).rejects.toThrow(
      /create rejected \(HTTP 400, "invalid body"\).*config\.template/,
    )
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
    expect(booted.mcpUrl).toBe(`http://gate.internal:18790/computers/${booted.sandboxId}/mcp`)
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

describe("computerSandboxProvider shared sessions", () => {
  let controller: FakeController
  // The ambient AGENTPROTO_SESSION_ID (present whenever the tests run inside
  // a spawned agent session) would resolve as the holder; pin it away so the
  // no-holder tests are deterministic.
  const savedSessionId = process.env.AGENTPROTO_SESSION_ID

  beforeEach(async () => {
    delete process.env.AGENTPROTO_SESSION_ID
    controller = new FakeController({ token: SERVICE_TOKEN })
    await controller.start()
  })
  afterEach(async () => {
    await controller.stop()
    if (savedSessionId === undefined) delete process.env.AGENTPROTO_SESSION_ID
    else process.env.AGENTPROTO_SESSION_ID = savedSessionId
  })

  it("forwards maxSessions at create and attaches the booting session", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url, { maxSessions: 3 }), bootOpts)
    expect(controller.createBodies[0]?.maxSessions).toBe(3)
    expect(controller.sessions.get(booted.sandboxId)).toBe(1)
  })

  it("stop detaches, then removes the computer when it was the last session", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    await booted.stop()
    expect(controller.sessions.get(booted.sandboxId)).toBe(0)
    expect(controller.removed).toEqual([booted.sandboxId])
  })

  it("stop leaves the computer in place while another session is attached", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url, { maxSessions: 2 }), bootOpts)
    controller.sessions.set(booted.sandboxId, 2)
    await booted.stop()
    expect(controller.sessions.get(booted.sandboxId)).toBe(1)
    expect(controller.removed).toEqual([])
    expect(controller.states.get(booted.sandboxId)).toBe("running")
  })

  it("two sessions on one computer in this process each release their own slot", async () => {
    const first = await computerSandboxProvider.boot(spec(controller.url, { maxSessions: 2 }), bootOpts)
    const second = await computerSandboxProvider.connect!(first.sandboxId, spec(controller.url, { maxSessions: 2 }), bootOpts)
    expect(controller.sessions.get(first.sandboxId)).toBe(2)
    await first.stop()
    expect(controller.sessions.get(first.sandboxId)).toBe(1)
    expect(controller.removed).toEqual([])
    await second.stop()
    expect(controller.sessions.get(first.sandboxId)).toBe(0)
    expect(controller.removed).toEqual([first.sandboxId])
  })

  it("runs an exec on a box whose only session slot is held, without probing or re-tokening the daemon", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url, { maxSessions: 1 }), bootOpts)
    const token = booted.token
    const serves = controller.serveCount
    const attaches = controller.attachBodies.length
    controller.execs.length = 0

    const execBox = await computerSandboxProvider.connectForExec!(
      booted.sandboxId,
      spec(controller.url, { maxSessions: 1 }),
      bootOpts,
    )

    expect(controller.sessions.get(booted.sandboxId)).toBe(1)
    expect(controller.serveCount).toBe(serves)
    expect(controller.daemonToken).toBe(token)
    expect(controller.attachBodies.length).toBe(attaches)

    const result = await execBox.exec!({ command: "echo hi" })
    expect(result.exitCode).toBe(0)
    // Only the caller's command: no health probe, token read or serve.
    expect(controller.execs).toHaveLength(1)
    expect(controller.execs[0]!.argv[2]).toContain("echo hi")
    expect(controller.sessions.get(booted.sandboxId)).toBe(1)
    await booted.stop()
  })

  it("stop keeps the computer when the detach is not answered", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    controller.options.detachStatus = 500
    await expect(booted.stop()).rejects.toThrow(/left in place/)
    expect(controller.removed).toEqual([])
    expect(controller.states.get(booted.sandboxId)).toBe("running")
    controller.options.detachStatus = undefined
    await booted.stop()
    expect(controller.removed).toEqual([booted.sandboxId])
  })

  it("pause detaches before suspending, and connect attaches again", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    await booted.pause!()
    expect(controller.sessions.get(booted.sandboxId)).toBe(0)
    const again = await computerSandboxProvider.connect!(booted.sandboxId, spec(controller.url), bootOpts)
    expect(controller.sessions.get(again.sandboxId) ?? 0).toBe(1)
    await again.stop()
  })

  it("connect is refused when the controller reports the computer full", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url, { maxSessions: 1 }), bootOpts)
    // A second process: the local count is not shared, the controller's is.
    await expect(
      computerSandboxProvider.connect!(booted.sandboxId, spec(controller.url, { maxSessions: 5 }), bootOpts),
    ).rejects.toThrow(/maximum number of sessions/)
    expect(controller.sessions.get(booted.sandboxId)).toBe(1)
  })

  it("works against a controller without the attach routes", async () => {
    controller.options.noSessionRoutes = true
    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    await booted.stop()
    expect(controller.removed).toEqual([booted.sandboxId])
  })

  it("attach and detach carry the configured holder", async () => {
    const booted = await computerSandboxProvider.boot(
      spec(controller.url, { sessionHolder: "sess_holder_1" }),
      bootOpts,
    )
    expect(controller.attachBodies).toEqual([{ id: booted.sandboxId, holder: "sess_holder_1" }])
    await booted.stop()
    expect(controller.detachBodies.at(-1)).toEqual({ id: booted.sandboxId, holder: "sess_holder_1" })
  })

  it("re-attaching the same holder at maxSessions answers 200 without taking another slot", async () => {
    const booted = await computerSandboxProvider.boot(
      spec(controller.url, { maxSessions: 1, sessionHolder: "sess_holder_1" }),
      bootOpts,
    )
    const client = new ComputerControllerClient({
      baseUrl: controller.url,
      token: SERVICE_TOKEN,
      tenantId: "tenant-a",
    })
    await expect(client.attach(booted.sandboxId, { holder: "sess_holder_1" })).resolves.toMatchObject({
      sessions: 1,
      maxSessions: 1,
    })
    expect(controller.sessions.get(booted.sandboxId)).toBe(1)
    await booted.stop()
  })

  it("a different holder at maxSessions is refused with 409", async () => {
    const booted = await computerSandboxProvider.boot(
      spec(controller.url, { maxSessions: 1, sessionHolder: "sess_holder_1" }),
      bootOpts,
    )
    const client = new ComputerControllerClient({
      baseUrl: controller.url,
      token: SERVICE_TOKEN,
      tenantId: "tenant-a",
    })
    await expect(client.attach(booted.sandboxId, { holder: "sess_holder_2" })).rejects.toMatchObject({
      status: 409,
    })
    expect(controller.sessions.get(booted.sandboxId)).toBe(1)
    await booted.stop()
  })

  it("the holder falls back to AGENTPROTO_SESSION_ID when the config names none", async () => {
    const saved = process.env.AGENTPROTO_SESSION_ID
    process.env.AGENTPROTO_SESSION_ID = "sess_from_env"
    try {
      const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
      expect(controller.attachBodies).toEqual([{ id: booted.sandboxId, holder: "sess_from_env" }])
      await booted.stop()
      expect(controller.detachBodies.at(-1)?.holder).toBe("sess_from_env")
    } finally {
      if (saved === undefined) delete process.env.AGENTPROTO_SESSION_ID
      else process.env.AGENTPROTO_SESSION_ID = saved
    }
  })

  it("an overlong or malformed holder is dropped, keeping the legacy body-less attach", async () => {
    const booted = await computerSandboxProvider.boot(
      spec(controller.url, { sessionHolder: `x`.repeat(129) }),
      bootOpts,
    )
    expect(controller.attachBodies).toEqual([{ id: booted.sandboxId, holder: undefined }])
    await booted.stop()
  })

  it("no holder configured sends the body-less legacy attach", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    expect(controller.attachBodies).toEqual([{ id: booted.sandboxId, holder: undefined }])
    await booted.stop()
  })

  it("daemonRoute relays every request with the holder header, HTTP and upgrade", async () => {
    const booted = await computerSandboxProvider.boot(
      spec(controller.url, { daemonRoute: true, sessionHolder: "sess_holder_1" }),
      bootOpts,
    )
    expect(booted.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const res = await fetch(booted.mcpUrl, { headers: booted.authHeaders })
    expect(res.status).toBe(200)
    expect(controller.daemonProxyRequests.at(-1)?.headers["x-computer-session-holder"]).toBe("sess_holder_1")
    await booted.stop()
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
