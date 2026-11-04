/**
 * `agent_start({ sandbox, preflight })`: probes run against the booted box
 * through its exec before the agent starts. A `ko` tears the box down and
 * fails the spawn with the typed `sandbox_preflight_failed`; an `unknown`
 * never blocks. The box is an in-process daemon behind a fake provider.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { SandboxEgressAllCoolingError } from "@agentproto/sandbox"
import type { SandboxExecOpts, SandboxExecResult, SandboxProvider, SandboxSpec } from "@agentproto/sandbox"

import { createGateway, type GatewayHandle } from "../index.js"
import {
  spawnAgentSession as spawnRaw,
  type SandboxSpecInput,
  type SpawnAgentSessionDeps,
  type SpawnAgentSessionInput,
} from "../session-spawn.js"
import { createSessionsRegistry, type SessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { setDefaultSessionsBaseDir } from "../transcript-writer.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import { commandPreflightProbe, defaultPreflightRegistry, type PreflightProbe } from "../sandbox-preflight.js"
import { egressHealthLedger } from "../egress-health.js"

const CI_USAGE_LIMIT =
  "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"

const spawnAgentSession = (deps: SpawnAgentSessionDeps, input: SpawnAgentSessionInput) =>
  spawnRaw(deps, { cwd: "/home/user/project", ...input })

const EGRESS = "203.0.113.7"

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

function makeFakeResolver(receivedStarts: Array<Record<string, unknown>>): AgentAdapterResolver {
  return async slug => {
    if (slug !== "fake-cli" && slug !== "opencode") return null
    return {
      commandPreview: `${slug} (test double)`,
      async startSession(args): Promise<AgentSessionLike> {
        receivedStarts.push(args as Record<string, unknown>)
        return {
          sessionId: "remote_sess_1",
          async *send(): AsyncIterable<AgentStreamEvent> {
            yield { kind: "text-delta", text: "ok" }
            yield { kind: "turn-end", reason: "completed" }
          },
          async cancel() {},
          async close() {},
        }
      },
    }
  }
}

const result = (over: Partial<SandboxExecResult> = {}): SandboxExecResult => ({
  exitCode: 0,
  stdout: "ok\n",
  stderr: "",
  durationMs: 1,
  ...over,
})

describe("agent_start sandbox preflight", () => {
  let receivedStarts: Array<Record<string, unknown>>
  let execCalls: SandboxExecOpts[]
  let execImpl: (opts: SandboxExecOpts) => Promise<SandboxExecResult>
  let bootCount: number
  let stopSpy: ReturnType<typeof vi.fn>
  let pauseSpy: ReturnType<typeof vi.fn>
  let gateway: GatewayHandle
  let boxWorkspace: string
  let hostDir: string
  let registry: SessionsRegistry
  let provider: SandboxProvider
  let withEgress: boolean
  const registered: string[] = []
  let prevEgressHealthPath: string | undefined

  const registerProbe = (probe: PreflightProbe) => {
    defaultPreflightRegistry.register(probe)
    registered.push(probe.id)
  }

  function makeDeps(): SpawnAgentSessionDeps {
    return {
      registry,
      resolveAgentAdapter: vi.fn(async () => null),
      resolveSandboxProvider: vi.fn(async (slug: string): Promise<SandboxProviderHandle | null> => {
        if (slug !== "fake") return null
        return {
          provider,
          slug: "fake",
          name: "Fake",
          version: "test",
          description: "test double booting an in-process daemon",
          requiresSetup: false,
          capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
          defaultCwd: "/home/user",
          async check() {
            return true
          },
        }
      }),
      loadDefaultsConfig: async () => undefined,
      loadRoleRegistry: async () => ({}),
    }
  }

  beforeEach(async () => {
    prevEgressHealthPath = process.env.AGENTPROTO_EGRESS_HEALTH
    process.env.AGENTPROTO_EGRESS_HEALTH = join(tmpdir(), `agentproto-egress-spawn-${process.pid}-${Date.now()}.json`)
    receivedStarts = []
    execCalls = []
    bootCount = 0
    withEgress = true
    stopSpy = vi.fn(async () => undefined)
    pauseSpy = vi.fn(async () => undefined)
    execImpl = async () => result()
    boxWorkspace = await mkdtemp(join(tmpdir(), "agentproto-preflight-box-"))
    hostDir = await mkdtemp(join(tmpdir(), "agentproto-preflight-host-"))
    setDefaultSessionsBaseDir(join(hostDir, "sessions"))
    gateway = await createGateway({
      workspace: boxWorkspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
      persistPath: join(boxWorkspace, "sessions.json"),
      resolveAgentAdapter: makeFakeResolver(receivedStarts),
    })
    const booted = () => {
      bootCount++
      return {
        mcpUrl: `${gateway.url}/mcp`,
        sandboxId: "sbx_fake_pf",
        stop: stopSpy,
        pause: pauseSpy,
        ...(withEgress ? { egressIp: { id: "slot1", publicIp: EGRESS } } : {}),
        async exec(o: SandboxExecOpts) {
          execCalls.push(o)
          return execImpl(o)
        },
      }
    }
    provider = {
      boot: vi.fn(async (_spec: SandboxSpec) => booted()),
      connect: vi.fn(async (_id: string, _spec: SandboxSpec) => booted()),
    }
    registry = createSessionsRegistry({ persist: false, transcriptDir: join(hostDir, "transcripts") })
  })

  afterEach(async () => {
    await rm(process.env.AGENTPROTO_EGRESS_HEALTH ?? "", { force: true })
    if (prevEgressHealthPath === undefined) delete process.env.AGENTPROTO_EGRESS_HEALTH
    else process.env.AGENTPROTO_EGRESS_HEALTH = prevEgressHealthPath
    for (const id of registered.splice(0)) {
      // the registry has no unregister: replace with an inert probe
      defaultPreflightRegistry.register({ id, description: "removed", defaultTimeoutMs: 1, run: async () => ({ verdict: "unknown", detail: "removed" }) })
    }
    setDefaultSessionsBaseDir(undefined)
    registry.shutdown()
    await gateway.stop()
    await rm(hostDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(boxWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it("ko (the CI usage-cap string): stops the box, fails typed, and never starts the agent", async () => {
    execImpl = async () => result({ exitCode: 1, stdout: "", stderr: CI_USAGE_LIMIT })
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "opencode",
      model: "opencode/glm-5.3-flash-free",
      sandbox: "fake",
      preflight: ["model-answers"],
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe("sandbox_preflight_failed")
    expect(res.details).toMatchObject({
      probe: "model-answers",
      errorClass: "usage-limit",
      egressIp: EGRESS,
      provider: "fake",
      sandboxId: "sbx_fake_pf",
    })
    expect(res.message).toContain(EGRESS)
    expect(execCalls[0]?.command).toBe("opencode run -m 'opencode/glm-5.3-flash-free' 'reply ok' < /dev/null")
    expect(stopSpy).toHaveBeenCalledTimes(1)
    expect(pauseSpy).not.toHaveBeenCalled()
    expect(receivedStarts).toHaveLength(0)
    expect(registry.list()).toHaveLength(0)
  })

  it("ok: the agent starts and the box stays up", async () => {
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "opencode",
      model: "opencode/glm-5.3-flash-free",
      sandbox: "fake",
      preflight: ["model-answers"],
    })
    expect(res.ok).toBe(true)
    expect(stopSpy).not.toHaveBeenCalled()
    expect(receivedStarts).toHaveLength(1)
  })

  it("unknown (probe cannot decide) never blocks the spawn and is surfaced as a warning", async () => {
    execImpl = async () => result({ exitCode: 127, stdout: "", stderr: "opencode: command not found" })
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "opencode",
      sandbox: "fake",
      preflight: ["model-answers"],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(stopSpy).not.toHaveBeenCalled()
    expect(receivedStarts).toHaveLength(1)
    expect(res.warnings?.some(w => w.includes('preflight "model-answers" inconclusive'))).toBe(true)
  })

  it("a credentialed spawn skips a probe that does not declare runsWithSpawnAuth (model-answers): it cannot present the credential", async () => {
    execImpl = async () => result({ exitCode: 1, stdout: "", stderr: CI_USAGE_LIMIT })
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "opencode",
      model: "opencode/glm-5.3-flash-free",
      sandbox: "fake",
      auth: { mode: "api-key", apiKey: "sk-test-credential-1234567890" },
      preflight: ["model-answers"],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(execCalls).toHaveLength(0)
    expect(stopSpy).not.toHaveBeenCalled()
    expect(receivedStarts).toHaveLength(1)
    expect(res.warnings?.some(w => w.includes("preflight model-answers skipped") && w.includes("credentials"))).toBe(true)
  })

  it("a credentialed spawn still runs a probe that declares runsWithSpawnAuth, and its ko fails the spawn", async () => {
    registerProbe(
      commandPreflightProbe({
        id: "zen-free-answers",
        command: "opencode run -m opencode/glm-5.3-flash-free 'reply ok' < /dev/null",
        koWhen: [{ match: "Free usage limit reached", errorClass: "usage-limit" }],
        runsWithSpawnAuth: true,
      }),
    )
    execImpl = async () => result({ exitCode: 1, stdout: "", stderr: CI_USAGE_LIMIT })
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "opencode",
      model: "opencode/glm-5.3-flash-free",
      sandbox: "fake",
      auth: { mode: "api-key", apiKey: "sk-test-credential-1234567890" },
      preflight: ["zen-free-answers"],
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe("sandbox_preflight_failed")
    expect(execCalls).toHaveLength(1)
    expect(JSON.stringify(execCalls)).not.toContain("sk-test-credential")
    expect(stopSpy).toHaveBeenCalledTimes(1)
    expect(receivedStarts).toHaveLength(0)
  })

  it("an unregistered probe id is rejected before any box boots", async () => {
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      sandbox: "fake",
      preflight: ["no-such-probe"],
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe("sandbox_preflight_invalid")
    expect(res.details).toMatchObject({ unknown: ["no-such-probe"] })
    expect(bootCount).toBe(0)
  })

  it("without `preflight` nothing is probed", async () => {
    const res = await spawnAgentSession(makeDeps(), { adapter: "fake-cli", sandbox: "fake" })
    expect(res.ok).toBe(true)
    expect(execCalls).toHaveLength(0)
  })

  it("a registered probe's ko fails the spawn, and probes after it do not run", async () => {
    const after = vi.fn(async () => ({ verdict: "ok" as const, detail: "fine" }))
    registerProbe({
      id: "test-ko",
      description: "always ko",
      defaultTimeoutMs: 1000,
      run: async () => ({ verdict: "ko", errorClass: "rate-limit", detail: "nope" }),
    })
    registerProbe({ id: "test-after", description: "never reached", defaultTimeoutMs: 1000, run: after })
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      sandbox: "fake",
      preflight: ["test-ko", "test-after"],
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe("sandbox_preflight_failed")
    expect(res.details).toMatchObject({ probe: "test-ko", errorClass: "rate-limit" })
    expect(after).not.toHaveBeenCalled()
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  it("omits egressIp from the failure when the provider brokers none", async () => {
    withEgress = false
    registerProbe({
      id: "test-ko",
      description: "always ko",
      defaultTimeoutMs: 1000,
      run: async () => ({ verdict: "ko", errorClass: "usage-limit", detail: "capped" }),
    })
    const res = await spawnAgentSession(makeDeps(), { adapter: "fake-cli", sandbox: "fake", preflight: ["test-ko"] })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.details).not.toHaveProperty("egressIp")
  })

  it("a reused box is paused on ko, not destroyed", async () => {
    registerProbe({
      id: "test-ko",
      description: "always ko",
      defaultTimeoutMs: 1000,
      run: async () => ({ verdict: "ko", errorClass: "usage-limit", detail: "capped" }),
    })
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      sandbox: { provider: "fake", config: {}, reuse: "sbx_fake_pf" } as unknown as SandboxSpecInput,
      preflight: ["test-ko"],
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe("sandbox_preflight_failed")
    expect(pauseSpy).toHaveBeenCalledTimes(1)
    expect(stopSpy).not.toHaveBeenCalled()
  })
  it("a usage-cap ko cools the box's egress address down for the model", async () => {
    execImpl = async () => result({ exitCode: 1, stdout: "", stderr: CI_USAGE_LIMIT })
    const model = "opencode/glm-5.3-flash-free"
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "opencode",
      model,
      sandbox: "fake",
      preflight: ["model-answers"],
    })
    expect(res.ok).toBe(false)
    const [entry] = egressHealthLedger.list()
    expect(entry).toMatchObject({
      publicIp: EGRESS,
      model,
      errorClass: "usage-limit",
      slot: "slot1",
      source: "preflight:model-answers",
    })
  })

  it("a ko that is not a usage or rate limit does not cool the address", async () => {
    registerProbe({
      id: "test-ko",
      description: "always ko",
      defaultTimeoutMs: 1000,
      run: async () => ({ verdict: "ko", errorClass: "auth", detail: "bad key" }),
    })
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      model: "opencode/big-pickle",
      sandbox: "fake",
      preflight: ["test-ko"],
    })
    expect(res.ok).toBe(false)
    expect(egressHealthLedger.list()).toEqual([])
  })

  it("hands the provider a cooldown view for the model and stamps the egress address on the session", async () => {
    const model = "opencode/big-pickle"
    egressHealthLedger.mark({ publicIp: "198.51.100.5", model, errorClass: "usage-limit" })
    const res = await spawnAgentSession(makeDeps(), { adapter: "fake-cli", model, sandbox: "fake" })
    expect(res.ok).toBe(true)
    const opts = (provider.boot as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      egressHealth?: { model: string; cooling: (ip: string) => unknown }
    }
    expect(opts.egressHealth?.model).toBe(model)
    expect(opts.egressHealth?.cooling("198.51.100.5")).toMatchObject({ errorClass: "usage-limit" })
    expect(opts.egressHealth?.cooling(EGRESS)).toBeUndefined()
    expect(registry.list()[0]).toMatchObject({ sandboxEgressIp: EGRESS, sandboxEgressSlot: "slot1" })
  })

  it("maps every-slot-cooling to the typed sandbox_egress_all_cooling without starting anything", async () => {
    const slots = [{ slot: "a", publicIp: "198.51.100.5", until: "2026-01-01T01:00:00.000Z", errorClass: "usage-limit" }]
    provider = {
      boot: vi.fn(async () => {
        throw new SandboxEgressAllCoolingError("opencode/big-pickle", slots)
      }),
      connect: vi.fn(),
    } as unknown as SandboxProvider
    const res = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      model: "opencode/big-pickle",
      sandbox: "fake",
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe("sandbox_egress_all_cooling")
    expect(res.details).toMatchObject({ model: "opencode/big-pickle", slots })
    expect(receivedStarts).toHaveLength(0)
    expect(registry.list()).toHaveLength(0)
  })
})
