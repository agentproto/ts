import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  LlmEndpointRegistry,
  assembleLlmEndpointEnv,
  DEFAULT_LLM_ENDPOINT_PORT,
  type EndpointProcess,
  type LaunchOptions,
} from "../llm-endpoint-registry.js"

/**
 * A real, existing path to hand the mocked-seam tests as `binPath`: `launch`
 * is overridden so the bin is never executed, but `start` still resolves +
 * VALIDATES the bin (existsSync), so it must point at something real. This
 * module's own file always exists.
 */
const EXISTING_BIN = fileURLToPath(import.meta.url)

/**
 * Test subclass overriding the `launch` / `probeHealth` seams so the state
 * machine is driven without a real spawned process — the same seam style
 * TunnelRegistry's tests use via `pickProviderForTest`.
 */
class MockRegistry extends LlmEndpointRegistry {
  launchCalls = 0
  stopCalls = 0
  capturedEnv: NodeJS.ProcessEnv | null = null
  capturedPort: number | null = null
  /** Queue of health results; falls back to `healthDefault` when empty. */
  healthQueue: boolean[] = []
  healthDefault = false
  /** When set, the first health probe fires an early child exit and fails. */
  crashOnFirstProbe = false

  private onExitCb: ((info: { code: number | null; signal: string | null }) => void) | undefined
  private crashed = false

  protected override async launch(opts: LaunchOptions): Promise<EndpointProcess> {
    this.launchCalls++
    this.capturedEnv = opts.env
    this.capturedPort = opts.port
    this.onExitCb = opts.onExit
    const self = this
    return {
      pid: 4242,
      async stop(): Promise<void> {
        self.stopCalls++
      },
    }
  }

  protected override async probeHealth(): Promise<boolean> {
    if (this.crashOnFirstProbe && !this.crashed) {
      this.crashed = true
      this.onExitCb?.({ code: 1, signal: null })
      return false
    }
    if (this.healthQueue.length > 0) return this.healthQueue.shift() as boolean
    return this.healthDefault
  }
}

function makeRegistry(
  over: ConstructorParameters<typeof MockRegistry>[0] = {},
): MockRegistry {
  return new MockRegistry({
    // Never touch the on-disk providers store in unit tests.
    injectKeys: async () => [],
    // `launch` is mocked, but `start` still validates the resolved bin path.
    binPath: EXISTING_BIN,
    readyTimeoutMs: 40,
    pollIntervalMs: 5,
    ...over,
  })
}

// ── env assembly ────────────────────────────────────────────────────────────

describe("assembleLlmEndpointEnv", () => {
  it("defaults the port to 18090 and sets LLM_ENDPOINT_PORT", async () => {
    const { env, port } = await assembleLlmEndpointEnv({
      baseEnv: {},
      injectKeys: async () => [],
    })
    expect(port).toBe(DEFAULT_LLM_ENDPOINT_PORT)
    expect(env.LLM_ENDPOINT_PORT).toBe("18090")
  })

  it("uses the port arg when provided", async () => {
    const { env, port } = await assembleLlmEndpointEnv({
      port: 19000,
      baseEnv: {},
      injectKeys: async () => [],
    })
    expect(port).toBe(19000)
    expect(env.LLM_ENDPOINT_PORT).toBe("19000")
  })

  it("lets an explicit LLM_ENDPOINT_PORT in env win, and keeps the descriptor port in sync", async () => {
    const { env, port } = await assembleLlmEndpointEnv({
      port: 19000,
      explicitEnv: { LLM_ENDPOINT_PORT: "20500" },
      baseEnv: {},
      injectKeys: async () => [],
    })
    expect(port).toBe(20500)
    expect(env.LLM_ENDPOINT_PORT).toBe("20500")
  })

  it("sets LLM_ENDPOINT_ACCESS_TOKENS only when supplied", async () => {
    const withTokens = await assembleLlmEndpointEnv({
      accessTokens: "tok-a,tok-b",
      baseEnv: {},
      injectKeys: async () => [],
    })
    expect(withTokens.env.LLM_ENDPOINT_ACCESS_TOKENS).toBe("tok-a,tok-b")

    const without = await assembleLlmEndpointEnv({
      baseEnv: {},
      injectKeys: async () => [],
    })
    expect(without.env.LLM_ENDPOINT_ACCESS_TOKENS).toBeUndefined()
  })

  it("injects provider keys via injectKeys and reports them", async () => {
    const { env, injectedProviders } = await assembleLlmEndpointEnv({
      baseEnv: {},
      injectKeys: async e => {
        e.MOONSHOT_API_KEY = "sk-injected"
        return ["moonshot"]
      },
    })
    expect(env.MOONSHOT_API_KEY).toBe("sk-injected")
    expect(injectedProviders).toEqual(["moonshot"])
  })

  it("explicit env wins over injected keys", async () => {
    const { env } = await assembleLlmEndpointEnv({
      explicitEnv: { MOONSHOT_API_KEY: "sk-explicit" },
      baseEnv: {},
      injectKeys: async e => {
        e.MOONSHOT_API_KEY = "sk-injected"
        return ["moonshot"]
      },
    })
    expect(env.MOONSHOT_API_KEY).toBe("sk-explicit")
  })
})

// ── start / status / stop lifecycle ─────────────────────────────────────────

describe("LlmEndpointRegistry", () => {
  it("start spawns the child and reaches running when healthy", async () => {
    const reg = makeRegistry({ injectKeys: async () => [] })
    reg.healthDefault = true

    const desc = await reg.start({ port: 18091 })

    expect(desc.status).toBe("running")
    expect(desc.pid).toBe(4242)
    expect(desc.port).toBe(18091)
    expect(desc.baseUrl).toBe("http://127.0.0.1:18091")
    expect(desc.startedAt).toBeTruthy()
    expect(reg.launchCalls).toBe(1)
  })

  it("start assembles env with port + access tokens", async () => {
    const reg = makeRegistry({ injectKeys: async () => [] })
    reg.healthDefault = true

    await reg.start({ port: 18095, accessTokens: "tok-1" })

    expect(reg.capturedPort).toBe(18095)
    expect(reg.capturedEnv?.LLM_ENDPOINT_PORT).toBe("18095")
    expect(reg.capturedEnv?.LLM_ENDPOINT_ACCESS_TOKENS).toBe("tok-1")
  })

  it("start is idempotent when already running + healthy (no second spawn)", async () => {
    const reg = makeRegistry({ injectKeys: async () => [] })
    reg.healthDefault = true

    const first = await reg.start({ port: 18092 })
    const second = await reg.start({ port: 18092 })

    expect(reg.launchCalls).toBe(1)
    expect(second.pid).toBe(first.pid)
    expect(second.status).toBe("running")
  })

  it("dedups two concurrent start() calls into a single spawn (Fix 1)", async () => {
    const reg = makeRegistry({ injectKeys: async () => [] })
    reg.healthDefault = true

    // Both calls are launched before either resolves — the pre-Fix code let
    // both pass the null-check and spawn a second, orphan-prone child.
    const [a, b] = await Promise.all([
      reg.start({ port: 18101 }),
      reg.start({ port: 18101 }),
    ])

    expect(reg.launchCalls).toBe(1)
    expect(a.pid).toBe(b.pid)
    // The joined caller learns it reused an in-flight start.
    expect(b.wasAlreadyRunning).toBe(true)
  })

  it("start leaves the endpoint 'starting' when health does not converge in the window", async () => {
    const reg = makeRegistry({ injectKeys: async () => [] })
    reg.healthDefault = false

    const desc = await reg.start({ port: 18093 })

    expect(desc.status).toBe("starting")
    expect(reg.launchCalls).toBe(1)
  })

  it("start throws and marks error when the child exits during startup", async () => {
    const reg = makeRegistry({ injectKeys: async () => [] })
    reg.crashOnFirstProbe = true

    await expect(reg.start({ port: 18094 })).rejects.toThrow(/exited/)
    expect(reg.get()?.status).toBe("error")
    expect(reg.get()?.lastError).toContain("exited")
  })

  it("status returns the {running,pid,port,baseUrl,healthy,startedAt} shape", async () => {
    const reg = makeRegistry({ injectKeys: async () => [] })
    reg.healthDefault = true
    await reg.start({ port: 18096 })

    const s = await reg.status()
    expect(s.running).toBe(true)
    expect(s.pid).toBe(4242)
    expect(s.port).toBe(18096)
    expect(s.baseUrl).toBe("http://127.0.0.1:18096")
    expect(s.healthy).toBe(true)
    expect(s.startedAt).toBeTruthy()
  })

  it("status reports never-started before any start", async () => {
    const reg = makeRegistry()
    const s = await reg.status()
    expect(s.status).toBe("never-started")
    expect(s.running).toBe(false)
    expect(s.pid).toBeNull()
    expect(s.port).toBeNull()
    expect(s.healthy).toBe(false)
  })

  it("stop SIGTERMs the child and marks stopped; idempotent", async () => {
    const reg = makeRegistry({ injectKeys: async () => [] })
    reg.healthDefault = true
    await reg.start({ port: 18097 })

    const ok = await reg.stop()
    expect(ok).toBe(true)
    expect(reg.stopCalls).toBe(1)
    expect(reg.get()?.status).toBe("stopped")
    expect(reg.get()?.stoppedAt).toBeTruthy()

    // Idempotent — no extra stop() call on the child.
    const again = await reg.stop()
    expect(again).toBe(true)
    expect(reg.stopCalls).toBe(1)
  })

  it("stop returns false when never started", async () => {
    const reg = makeRegistry()
    expect(await reg.stop()).toBe(false)
  })

  it("stopped status reports healthy=false without probing", async () => {
    const reg = makeRegistry({ injectKeys: async () => [] })
    reg.healthDefault = true
    await reg.start({ port: 18098 })
    await reg.stop()

    const s = await reg.status()
    expect(s.status).toBe("stopped")
    expect(s.healthy).toBe(false)
    expect(s.running).toBe(false)
  })

  it("shutdown stops a running child", async () => {
    const reg = makeRegistry({ injectKeys: async () => [] })
    reg.healthDefault = true
    await reg.start({ port: 18099 })

    await reg.shutdown()

    expect(reg.stopCalls).toBe(1)
    expect(reg.get()?.status).toBe("stopped")
  })

  it("re-start after a stale/unhealthy running descriptor respawns", async () => {
    const reg = makeRegistry({ injectKeys: async () => [] })
    // First start converges healthy → running.
    reg.healthQueue = [true]
    reg.healthDefault = true
    await reg.start({ port: 18100 })

    // Idempotent-path probe returns false (stale), then the respawn's
    // readiness probe returns true.
    reg.healthQueue = [false, true]
    await reg.start({ port: 18100 })

    expect(reg.launchCalls).toBe(2)
    expect(reg.stopCalls).toBe(1) // stale child torn down before respawn
    expect(reg.get()?.status).toBe("running")
  })
})

// ── real spawn / kill (drives launch(), spawn(), the log fd, onExit, and the
//    SIGTERM+SIGKILL backstop — the mocked-seam tests above never run these) ──

/**
 * These tests DON'T override `launch`/`probeHealth`(spawn) — they drive the
 * REAL `launch()` against a tiny `node -e`-style fake script (mirrors
 * cloudflared-spawn.test.ts). Only the network probe is stubbed, so a test
 * never depends on the fake actually binding a TCP port.
 */
describe("LlmEndpointRegistry (real spawn/kill)", () => {
  let dir: string
  const spawnedPids: number[] = []

  const isAlive = (pid: number | null | undefined): boolean => {
    if (pid == null) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  afterEach(() => {
    for (const pid of spawnedPids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        /* noop */
      }
    }
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /** Real launch/spawn; only the health probe is stubbed (controllable). */
  class RealLaunchRegistry extends LlmEndpointRegistry {
    healthResult = false
    protected override async probeHealth(): Promise<boolean> {
      return this.healthResult
    }
  }

  const writeFake = (name: string, body: string): string => {
    const p = join(dir, name)
    writeFileSync(p, body)
    return p
  }

  it("real spawn: stays alive → running, then stop() actually terminates the child", async () => {
    dir = mkdtempSync(join(tmpdir(), "llm-ep-real-"))
    const bin = writeFake("alive.mjs", "setInterval(() => {}, 1000)\n")
    const reg = new RealLaunchRegistry({
      workspace: dir,
      injectKeys: async () => [],
      binPath: bin,
      readyTimeoutMs: 4_000,
      pollIntervalMs: 20,
    })
    reg.healthResult = true

    const desc = await reg.start({ port: 18150 })
    if (desc.pid != null) spawnedPids.push(desc.pid)

    expect(desc.status).toBe("running")
    expect(desc.pid).toBeTruthy()
    expect(isAlive(desc.pid)).toBe(true)

    const s = await reg.status()
    expect(s.healthy).toBe(true)

    // Real SIGTERM path — the child is actually gone afterwards.
    await reg.stop()
    expect(reg.get()?.status).toBe("stopped")
    expect(isAlive(desc.pid)).toBe(false)
  })

  it("real spawn: child exits non-zero immediately → start() throws WITH the log tail (Fix 2)", async () => {
    dir = mkdtempSync(join(tmpdir(), "llm-ep-real-"))
    const bin = writeFake(
      "crash.mjs",
      `import { writeSync } from "node:fs"\n` +
        `writeSync(1, "llm-endpoint boot failed: EADDRINUSE 18151\\n")\n` +
        `process.exit(2)\n`,
    )
    const reg = new RealLaunchRegistry({
      workspace: dir,
      injectKeys: async () => [],
      binPath: bin,
      readyTimeoutMs: 4_000,
      pollIntervalMs: 20,
    })
    reg.healthResult = false

    // The surfaced error carries the captured child output, not a bare code=2.
    await expect(reg.start({ port: 18151 })).rejects.toThrow(
      /exited[\s\S]*EADDRINUSE 18151/,
    )
    expect(reg.get()?.status).toBe("error")
    expect(reg.get()?.lastError).toContain("EADDRINUSE 18151")
  })

  it("bin not found → start() throws a clean, actionable error (Fix 2)", async () => {
    dir = mkdtempSync(join(tmpdir(), "llm-ep-real-"))
    const reg = new RealLaunchRegistry({
      workspace: dir,
      injectKeys: async () => [],
      binPath: join(dir, "does-not-exist.mjs"),
    })

    await expect(reg.start({ port: 18152 })).rejects.toThrow(/not found/)
  })
})
