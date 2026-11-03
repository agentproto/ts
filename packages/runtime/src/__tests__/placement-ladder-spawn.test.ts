/**
 * `agent_start({ placement: { ladder } })`: rungs are tried in order and a rung
 * is skipped only when the box could not be placed. The boxes are in-process
 * daemons behind two fake providers ("alpha" is rung 1, "beta" rung 2).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import type { SandboxProvider, SandboxSpec } from "@agentproto/sandbox"

import { createGateway, type GatewayHandle } from "../index.js"
import {
  spawnAgentSession as spawnRaw,
  type SpawnAgentSessionDeps,
  type SpawnAgentSessionInput,
} from "../session-spawn.js"
import { createSessionsRegistry, type SessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { setDefaultSessionsBaseDir } from "../transcript-writer.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import { defaultPreflightRegistry, type PreflightProbe } from "../sandbox-preflight.js"

const spawnAgentSession = (deps: SpawnAgentSessionDeps, input: SpawnAgentSessionInput) =>
  spawnRaw(deps, { cwd: "/home/user/project", ...input })

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

const coded = (code: string, message: string) => Object.assign(new Error(message), { code })

describe("agent_start placement ladder", () => {
  let receivedStarts: Array<Record<string, unknown>>
  let startImpl: (args: Record<string, unknown>) => Promise<AgentSessionLike>
  let gateway: GatewayHandle
  let boxWorkspace: string
  let hostDir: string
  let registry: SessionsRegistry
  let alphaBoot: ReturnType<typeof vi.fn>
  let betaBoot: ReturnType<typeof vi.fn>
  let alphaStop: ReturnType<typeof vi.fn>
  let alphaFails: () => Error | undefined
  let betaFails: () => Error | undefined
  const registered: string[] = []

  const registerProbe = (probe: PreflightProbe) => {
    defaultPreflightRegistry.register(probe)
    registered.push(probe.id)
  }

  const okAgent = (): AgentSessionLike => ({
    sessionId: "remote_sess_1",
    async *send(): AsyncIterable<AgentStreamEvent> {
      yield { kind: "text-delta", text: "ok" }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  })

  const resolver: AgentAdapterResolver = async slug => {
    if (slug !== "fake-cli") return null
    return {
      commandPreview: `${slug} (test double)`,
      async startSession(args): Promise<AgentSessionLike> {
        receivedStarts.push(args as Record<string, unknown>)
        return startImpl(args as Record<string, unknown>)
      },
    }
  }

  const handleFor = (slug: string, provider: SandboxProvider): SandboxProviderHandle => ({
    provider,
    slug,
    name: slug,
    version: "test",
    description: "test double booting an in-process daemon",
    requiresSetup: false,
    capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
    defaultCwd: "/home/user",
    async check() {
      return true
    },
  })

  let alpha: SandboxProvider
  let beta: SandboxProvider

  function makeDeps(): SpawnAgentSessionDeps {
    return {
      registry,
      resolveAgentAdapter: vi.fn(async () => null),
      resolveSandboxProvider: vi.fn(async (slug: string) => {
        if (slug === "alpha") return handleFor("alpha", alpha)
        if (slug === "beta") return handleFor("beta", beta)
        return null
      }),
      loadDefaultsConfig: async () => undefined,
      loadRoleRegistry: async () => ({}),
    }
  }

  beforeEach(async () => {
    receivedStarts = []
    startImpl = async () => okAgent()
    alphaFails = () => undefined
    betaFails = () => undefined
    alphaStop = vi.fn(async () => undefined)
    boxWorkspace = await mkdtemp(join(tmpdir(), "agentproto-ladder-box-"))
    hostDir = await mkdtemp(join(tmpdir(), "agentproto-ladder-host-"))
    setDefaultSessionsBaseDir(join(hostDir, "sessions"))
    gateway = await createGateway({
      workspace: boxWorkspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
      persistPath: join(boxWorkspace, "sessions.json"),
      resolveAgentAdapter: resolver,
    })
    const box = (id: string, stop: () => Promise<void>) => ({
      mcpUrl: `${gateway.url}/mcp`,
      sandboxId: id,
      stop,
      async exec() {
        return { exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 1 }
      },
    })
    alphaBoot = vi.fn(async (_spec: SandboxSpec) => {
      const err = alphaFails()
      if (err) throw err
      return box("sbx_alpha", alphaStop)
    })
    betaBoot = vi.fn(async (_spec: SandboxSpec) => {
      const err = betaFails()
      if (err) throw err
      return box("sbx_beta", async () => undefined)
    })
    alpha = { boot: alphaBoot, connect: alphaBoot } as unknown as SandboxProvider
    beta = { boot: betaBoot, connect: betaBoot } as unknown as SandboxProvider
    registry = createSessionsRegistry({ persist: false, transcriptDir: join(hostDir, "transcripts") })
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const id of registered.splice(0)) {
      defaultPreflightRegistry.register({ id, description: "removed", defaultTimeoutMs: 1, run: async () => ({ verdict: "unknown", detail: "removed" }) })
    }
    setDefaultSessionsBaseDir(undefined)
    registry.shutdown()
    await gateway.stop()
    await rm(hostDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(boxWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it("rung 1 passes: the session runs on it and the second rung is never booted", async () => {
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      placement: { ladder: [{ sandbox: "alpha" }, { sandbox: "beta" }] },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(betaBoot).not.toHaveBeenCalled()
    expect(res.descriptor.sandboxProvider).toBe("alpha")
    expect(res.descriptor.placement).toMatchObject({
      rung: 0,
      attempts: [{ rung: 0, provider: "alpha", outcome: "ok" }],
    })
    expect(registry.get(res.descriptor.id)?.placement?.rung).toBe(0)
  })

  it("a rung whose box never starts the adapter is abandoned after its agentStartTimeoutMs, and the next rung runs", async () => {
    let release: () => void = () => {}
    const hang = new Promise<void>(resolve => {
      release = resolve
    })
    let calls = 0
    startImpl = async () => {
      calls++
      if (calls === 1) await hang
      return okAgent()
    }
    try {
      // the first box's start never settles until `finally`, so only the rung budget can end the wait
      const res = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        placement: { ladder: [{ sandbox: "alpha", agentStartTimeoutMs: 300 }, { sandbox: "beta" }] },
      })
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(alphaStop).toHaveBeenCalledTimes(1)
      expect(res.descriptor.sandboxProvider).toBe("beta")
      expect(res.descriptor.placement?.attempts[0]).toMatchObject({
        rung: 0,
        provider: "alpha",
        outcome: "failed",
        errorClass: "sandbox_agent_start_timeout",
      })
      const warned = vi.mocked(console.warn).mock.calls.map(c => String(c[0]))
      expect(warned.some(w => w.includes("box diagnostics") && w.includes("sbx_alpha"))).toBe(true)
    } finally {
      release()
    }
  })

  it("rejects an agentStartTimeoutMs above the harness client's own ceiling", async () => {
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      placement: { ladder: [{ sandbox: "alpha", agentStartTimeoutMs: 900_000 }] },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe("placement_invalid")
    expect(alphaBoot).not.toHaveBeenCalled()
  })

  it("rung 1 preflight ko, then rung 2 ok: the failed box is stopped and the session lands on rung 2", async () => {
    registerProbe({
      id: "test-ko",
      description: "always ko",
      defaultTimeoutMs: 1000,
      run: async () => ({ verdict: "ko", errorClass: "usage-limit", detail: "capped" }),
    })
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      model: "top-model",
      placement: {
        ladder: [
          { sandbox: "alpha", preflight: ["test-ko"] },
          { sandbox: "beta", model: "rung-two-model" },
        ],
      },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(alphaStop).toHaveBeenCalledTimes(1)
    expect(receivedStarts).toHaveLength(1)
    expect(res.descriptor.sandboxProvider).toBe("beta")
    expect(res.descriptor.model).toBe("rung-two-model")
    expect(res.descriptor.placement).toMatchObject({
      rung: 1,
      attempts: [
        { rung: 0, provider: "alpha", model: "top-model", outcome: "failed", errorClass: "usage-limit" },
        { rung: 1, provider: "beta", model: "rung-two-model", outcome: "ok" },
      ],
    })
    expect(res.descriptor.placement?.attempts.every(a => typeof a.durationMs === "number")).toBe(true)
    expect(res.warnings?.some(w => w.includes("rung 1") || w.includes("#1"))).toBe(true)
    // the rung-2 session does not inherit rung 1's preflight
    expect(res.descriptor.preflight).toBeUndefined()
  })

  it.each(["sandbox_capacity", "sandbox_fleet_capacity", "sandbox_overflow_refused"])(
    "rung 1 refuses on capacity (%s), then rung 2: the typed code is the attempt's errorClass",
    async code => {
      alphaFails = () => coded(code, "no room")
      const res = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        placement: { ladder: [{ sandbox: "alpha" }, { sandbox: "beta" }] },
      })
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.descriptor.sandboxProvider).toBe("beta")
      expect(res.descriptor.placement?.attempts[0]).toMatchObject({ rung: 0, provider: "alpha", outcome: "failed", errorClass: code })
    },
  )

  it("a provider that is not set up is skipped like any other placement failure", async () => {
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      placement: { ladder: [{ sandbox: "nowhere" }, { sandbox: "beta" }] },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.descriptor.placement?.attempts[0]).toMatchObject({ provider: "nowhere", errorClass: "sandbox_provider_not_found" })
  })

  it("a labelled spawn with dedupe on still falls to rung 2: a failed boot settles its claim", async () => {
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      label: "ci-review",
      prompt: "review the PR",
      dedupe: true,
      placement: { ladder: [{ sandbox: "nowhere" }, { sandbox: "beta" }] },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.descriptor.placement?.attempts[0]).toMatchObject({ provider: "nowhere", errorClass: "sandbox_provider_not_found" })
  }, 15_000)

  it("every rung fails: a typed error listing every attempt, and nothing is left registered", async () => {
    alphaFails = () => coded("sandbox_capacity", "alpha is full")
    betaFails = () => coded("sandbox_overflow_refused", "beta refused")
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      placement: { ladder: [{ sandbox: "alpha" }, { sandbox: "beta" }] },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe("sandbox_placement_exhausted")
    const attempts = (res.details as { attempts: Array<Record<string, unknown>> }).attempts
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toMatchObject({ rung: 0, provider: "alpha", outcome: "failed", errorClass: "sandbox_capacity" })
    expect(attempts[1]).toMatchObject({ rung: 1, provider: "beta", outcome: "failed", errorClass: "sandbox_overflow_refused" })
    expect(res.message).toContain("alpha")
    expect(res.message).toContain("beta")
    expect(res.message).toContain("sandbox_capacity")
    expect(res.message).toContain("sandbox_overflow_refused")
    expect(registry.list()).toHaveLength(0)
    expect(receivedStarts).toHaveLength(0)
  })

  it("a failure AFTER the agent started never advances: the turn fails, the ladder is done", async () => {
    let turns = 0
    startImpl = async () => ({
      sessionId: "remote_sess_1",
      async *send(): AsyncIterable<AgentStreamEvent> {
        turns++
        yield { kind: "error", error: { message: "429 status code" } } as never
        yield { kind: "turn-end", reason: "error" } as never
      },
      async cancel() {},
      async close() {},
    })
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      placement: { ladder: [{ sandbox: "alpha" }, { sandbox: "beta" }] },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    await registry.enqueuePrompt(res.descriptor.id, "go")
    await vi.waitFor(() => expect(turns).toBeGreaterThan(0), { timeout: 5000 })
    expect(betaBoot).not.toHaveBeenCalled()
    expect(registry.get(res.descriptor.id)?.placement?.rung).toBe(0)
    expect(registry.get(res.descriptor.id)?.sandboxProvider).toBe("alpha")
  })

  it("a failure that would fail the same on every rung stops the walk with its own code", async () => {
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      placement: { ladder: [{ sandbox: "alpha", preflight: ["no-such-probe"] }, { sandbox: "beta" }] },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe("sandbox_preflight_invalid")
    expect(betaBoot).not.toHaveBeenCalled()
    expect((res.details as { attempts: unknown[] }).attempts).toHaveLength(1)
  })

  it("is refused alongside a top-level sandbox", async () => {
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      sandbox: "alpha",
      placement: { ladder: [{ sandbox: "beta" }] },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe("placement_invalid")
    expect(alphaBoot).not.toHaveBeenCalled()
    expect(betaBoot).not.toHaveBeenCalled()
  })

  it.each([
    ["an empty ladder", { ladder: [] }],
    ["a rung without a sandbox", { ladder: [{ model: "m" }] }],
    ["an unknown rung key", { ladder: [{ sandbox: "alpha", bogus: 1 }] }],
    ["a reuse rung", { ladder: [{ sandbox: { provider: "alpha", config: {}, reuse: "sbx_1" } }] }],
  ])("rejects %s with placement_invalid before any box boots", async (_name, placement) => {
    const res = await spawnAgentSession(makeDeps(), { adapter: "fake-cli", placement: placement as never })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe("placement_invalid")
    expect(alphaBoot).not.toHaveBeenCalled()
  })

  it("without `placement` a spawn is unchanged (no placement on the descriptor)", async () => {
    const res = await spawnAgentSession(makeDeps(), { adapter: "fake-cli", sandbox: "alpha" })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.descriptor.placement).toBeUndefined()
  })
})
