/**
 * `session_restart` on a sandboxed agent session — the box re-attach path.
 *
 * Regression: `restartAgentSession` used to have no remote/sandbox branch, so
 * restarting a session that ran inside a sandbox resolved the adapter
 * LOCALLY and spawned it with `cwd = prev.cwd` — a path INSIDE the box
 * (`/home/user`) — on the host (`spawn ... ENOENT, cwd '/home/user' does not
 * exist`). The fixed path resolves the box's provider, `connect()`s the
 * EXISTING `sandboxId` (never boots a fresh box), and re-spawns the adapter
 * on the box's own `agent_start` — exercised here over the real wire: a fake
 * `SandboxProvider.connect` wraps an in-process daemon (`createGateway`), the
 * same harness `agent-start-sandbox.test.ts` uses for the boot path.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { SandboxBoxGoneError, type SandboxExecOpts, type SandboxProvider, type SandboxSpec } from "@agentproto/sandbox"

import { createGateway, type GatewayHandle } from "../index.js"
import { createSessionsRegistry, type SessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { restartAgentSession } from "../session-restart-core.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import type { SandboxDeliveryTarget } from "../sandbox-delivery.js"
import { sessionTranscriptDir, setDefaultSessionsBaseDir } from "../transcript-writer.js"
import { setMcpCredentialDeps } from "../mcp-credential-deps.js"
import { readTarTarget, tarArchivePath, writePendingTarRecord } from "../sandbox-tar-checkpoint.js"

const wsConfigState = vi.hoisted(() => ({
  value: { version: 1, workspaces: [] } as import("../workspaces-config.js").WorkspacesConfig,
}))
vi.mock("../workspaces-config.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../workspaces-config.js")>()
  return { ...actual, loadWorkspacesConfig: vi.fn(async () => wsConfigState.value) }
})

const deriveState = vi.hoisted(() => ({ isPublic: false }))
vi.mock("../sandbox-workspace-derive-remote.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../sandbox-workspace-derive-remote.js")>()
  return {
    ...actual,
    // No keychain and no network in unit tests.
    resolveSandboxWorkspaceSource: (ws: Parameters<typeof actual.resolveSandboxWorkspaceSource>[0]) =>
      actual.resolveSandboxWorkspaceSource(ws, {
        git: (args, opts) =>
          args.includes("ls-remote") ? Promise.resolve({ ok: false, stdout: "" }) : actual.runGit(args, opts),
        isPubliclyCloneable: async () => deriveState.isPublic,
      }),
  }
})

let acpCounter = 0
function fakeAgentSession(prefix: string): AgentSessionLike {
  return {
    sessionId: `${prefix}_${acpCounter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

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

function makeFakeCliResolver(): AgentAdapterResolver {
  return async slug => {
    if (slug !== "fake-cli") return null
    return {
      commandPreview: "fake-cli (host test double)",
      async startSession(): Promise<AgentSessionLike> {
        throw new Error("LOCAL SPAWN MUST NOT HAPPEN for a sandbox session restart")
      },
    }
  }
}

/** Boot a real in-process daemon (the "box") whose provider supports
 *  `connect()` — the re-attach path a sandbox restart must take. */
async function bootReconnectableBox(
  receivedStarts: Array<Record<string, unknown>>,
): Promise<{
  provider: SandboxProvider
  gateway: GatewayHandle
  workspace: string
  connectCalls: string[]
  connectSpecs: SandboxSpec[]
}> {
  const workspace = await mkdtemp(join(tmpdir(), "agentproto-sbx-restart-box-"))
  const port = await freePort()
  const gateway = await createGateway({
    workspace,
    specs: [],
    port,
    boot: false,
    persist: false,
    persistPath: join(workspace, "sessions.json"),
    resolveAgentAdapter: async slug => {
      if (slug !== "fake-cli") return null
      return {
        commandPreview: "fake-cli (box test double)",
        async startSession(args): Promise<AgentSessionLike> {
          receivedStarts.push(args as Record<string, unknown>)
          return fakeAgentSession("box")
        },
      }
    },
  })
  const connectCalls: string[] = []
  const connectSpecs: SandboxSpec[] = []
  const provider: SandboxProvider = {
    async boot(): Promise<never> {
      throw new Error("boot must never be called — a restart reconnects via connect()")
    },
    async connect(sandboxId: string, spec: SandboxSpec) {
      connectCalls.push(sandboxId)
      connectSpecs.push(spec)
      return {
        mcpUrl: `${gateway.url}/mcp`,
        sandboxId,
        async stop() {
          await gateway.stop()
        },
      }
    },
  }
  return { provider, gateway, workspace, connectCalls, connectSpecs }
}function makeResolver(
  box: Awaited<ReturnType<typeof bootReconnectableBox>>,
): { resolver: AgentAdapterResolver; providerResolver: (slug: string) => Promise<SandboxProviderHandle | null> } {
  const resolver: AgentAdapterResolver = makeFakeCliResolver()
  const providerResolver = async (slug: string): Promise<SandboxProviderHandle | null> => {
    if (slug !== "fake") return null
    return {
      provider: box.provider,
      slug: "fake",
      name: "Fake",
      version: "test",
      description: "test double exposing a connect() to an in-process daemon",
      requiresSetup: false,
      capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
      async check() {
        return true
      },
    }
  }
  return { resolver, providerResolver }
}

describe("restartAgentSession on a sandboxed session", () => {
  const receivedStarts: Array<Record<string, unknown>> = []
  let box: Awaited<ReturnType<typeof bootReconnectableBox>>
  let registry: SessionsRegistry
  let hostWorkspace: string
  let prev: ReturnType<SessionsRegistry["spawnAgent"]>

  afterEach(async () => {
    registry.shutdown()
    await box.gateway.stop()
    await rm(hostWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(box.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  async function setup(opts: {
    prevAgentSession?: AgentSessionLike
    killPrev?: boolean
    deliveryTarget?: SandboxDeliveryTarget
    workspaceSlug?: string
  } = {}): Promise<{
    resolver: AgentAdapterResolver
    providerResolver: (slug: string) => Promise<SandboxProviderHandle | null>
  }> {
    receivedStarts.length = 0
    box = await bootReconnectableBox(receivedStarts)
    hostWorkspace = await mkdtemp(join(tmpdir(), "agentproto-sbx-restart-host-"))
    registry = createSessionsRegistry({
      persist: false,
      transcriptDir: join(hostWorkspace, "transcripts"),
    })
    prev = registry.spawnAgent({
      workspaceSlug: opts.workspaceSlug ?? "default",
      cwd: "/home/user",
      agentSession: opts.prevAgentSession ?? fakeAgentSession("box"),
      adapterSlug: "fake-cli",
      commandPreview: "sandbox:fake → fake-cli",
      remote: true,
      sandboxId: "sbx_prev_1",
      sandboxTeardown: "pause",
      ...(opts.deliveryTarget ? { sandboxDeliveryTarget: opts.deliveryTarget } : {}),
    })
    if (opts.killPrev ?? true) registry.kill(prev.id)
    return makeResolver(box)
  }

  it("re-attaches the EXISTING box via connect() and re-spawns the adapter inside it — never a local spawn", async () => {
    const { resolver, providerResolver } = await setup()

    const result = await restartAgentSession(registry, resolver, prev, {
      resolveSandboxProvider: providerResolver,
    })

    expect(box.connectCalls).toEqual(["sbx_prev_1"])
    expect(receivedStarts).toHaveLength(1)
    expect(receivedStarts[0]?.cwd).toBe("/home/user")

    expect(result.resumedFrom).toBe(prev.id)
    expect(result.resumeFallback).toBe(true)
    expect(result.desc.remote).toBe(true)
    expect(result.desc.sandboxId).toBe("sbx_prev_1")
    expect(result.desc.sandboxTeardown).toBe("pause")
    expect(result.desc.command).toBe("sandbox:fake → fake-cli")
    expect(result.desc.command).toBe("sandbox:fake → fake-cli")
    expect(result.desc.resumeVia).toBe("")
    expect(result.desc.cwd).toBe("/home/user")
    expect(result.desc.adapterSlug).toBe("fake-cli")
  })

  it("forwards the overrides (model/effort) to the box's agent_start and stamps them on the fresh descriptor", async () => {
    const { resolver, providerResolver } = await setup()

    const result = await restartAgentSession(registry, resolver, prev, {
      resolveSandboxProvider: providerResolver,
      overrides: { model: "kimi/k2", effort: "high" },
    })

    expect(receivedStarts[0]?.model).toBe("kimi/k2")
    expect(receivedStarts[0]?.effort).toBe("high")
    expect(result.desc.model).toBe("kimi/k2")
    expect(result.desc.effort).toBe("high")
  })

  it("fails LOUD when the box is expired — never falls back to a local spawn", async () => {
    const { resolver, providerResolver } = await setup()
    // Reconnect failure = the box is gone.
    const failing: (slug: string) => Promise<SandboxProviderHandle | null> = async slug => {
      const handle = await providerResolver(slug)
      if (!handle) return null
      return {
        ...handle,
        provider: {
          async boot(): Promise<never> {
            throw new Error("boot must never be called — a restart reconnects via connect()")
          },
          async connect(): Promise<never> {
            throw new Error("sandbox not found")
          },
        },
      }
    }

    await expect(
      restartAgentSession(registry, resolver, prev, { resolveSandboxProvider: failing }),
    ).rejects.toThrow(/sbx_prev_1.*expired.*spawn a fresh session/i)
    // The decisive regression assertion: no local adapter spawn happened.
    expect(receivedStarts).toHaveLength(0)
  })

  it("fails LOUD when no sandbox provider resolver is wired (instead of spawning locally)", async () => {
    const { resolver } = await setup()

    await expect(restartAgentSession(registry, resolver, prev)).rejects.toThrow(
      /no sandbox provider resolver/,
    )
    expect(receivedStarts).toHaveLength(0)
  })

  // Regression guard for the fix that closes a superseded OLD row
  // (session-restart-core.ts "Close the superseded OLD row"): a sandbox
  // restart's `prev.agentSession` is a `SandboxAgentSessionProxy` over the
  // SAME remote `sandboxId` the fresh descriptor just reconnected to — a
  // blind `registry.kill(prev.id, ...)` would call that proxy's `close()`,
  // which tears down/pauses the underlying box (`host.stop()`/`pause()`),
  // destroying the box the NEW session now depends on. The fix must skip
  // closing `prev` for a sandbox restart specifically.
  it("restarting an ALIVE sandboxed session never closes the old row's agentSession — the shared box survives", async () => {
    // Unlike every other test in this file, `prev` is left ALIVE (not
    // killed) — exactly the production bug's precondition.
    let closed = false
    const { resolver, providerResolver } = await setup({
      killPrev: false,
      prevAgentSession: {
        sessionId: "box_alive",
        // eslint-disable-next-line require-yield
        async *send(): AsyncIterable<AgentStreamEvent> {
          return
        },
        async cancel() {},
        async close() {
          closed = true
        },
      },
    })
    expect(registry.get(prev.id)?.status).toBe("running")

    const result = await restartAgentSession(registry, resolver, prev, {
      resolveSandboxProvider: providerResolver,
    })

    expect(result.desc.sandboxId).toBe("sbx_prev_1")
    // The decisive assertions: the OLD row's session was never closed, and
    // it's still reported as running — never torn down out from under its
    // own replacement, which reconnected to the exact same box.
    expect(closed).toBe(false)
    expect(registry.get(prev.id)?.status).toBe("running")
  })

  // Regression (sess_6e3649d2, 2026-10-13): the prior row ended on a
  // host-side error, so its proxy never killed its box session — the old
  // adapter kept editing the checkout while the restart spawned a second one
  // next to it. The restart must stop the prior box session through the box's
  // own daemon before the new `agent_start`.
  it("stops the prior session inside the box (via the box daemon) before starting the new one", async () => {
    receivedStarts.length = 0
    box = await bootReconnectableBox(receivedStarts)
    hostWorkspace = await mkdtemp(join(tmpdir(), "agentproto-sbx-restart-host-"))
    registry = createSessionsRegistry({ persist: false, transcriptDir: join(hostWorkspace, "transcripts") })
    // The prior adapter, still alive on the BOX daemon.
    const priorInBox = box.gateway.sessions.spawnAgent({
      workspaceSlug: "default",
      cwd: box.workspace,
      agentSession: fakeAgentSession("box"),
      adapterSlug: "fake-cli",
    })
    // The host row that drove it ended in error; its proxy is gone and never
    // killed the box session (the incident's precondition).
    prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/home/user",
      agentSession: { ...fakeAgentSession("proxy"), sessionId: priorInBox.id },
      adapterSlug: "fake-cli",
      commandPreview: "sandbox:fake → fake-cli",
      remote: true,
      sandboxId: "sbx_prev_1",
      sandboxTeardown: "pause",
    })
    expect(prev.sandboxRemoteSessionId).toBe(priorInBox.id)
    registry.markCrashed(prev.id, "transport-closed")
    const { resolver, providerResolver } = makeResolver(box)
    const statusAtStart: Array<string | undefined> = []
    const startSession = box.gateway.sessions.spawnAgent.bind(box.gateway.sessions)
    vi.spyOn(box.gateway.sessions, "spawnAgent").mockImplementation(input => {
      statusAtStart.push(box.gateway.sessions.get(priorInBox.id)?.status)
      return startSession(input)
    })

    const result = await restartAgentSession(registry, resolver, registry.get(prev.id)!, {
      resolveSandboxProvider: providerResolver,
    })

    // Killed BEFORE the replacement was registered on the box.
    expect(statusAtStart).toEqual(["killed"])
    expect(box.gateway.sessions.get(priorInBox.id)?.status).toBe("killed")
    const replacement = result.desc.sandboxRemoteSessionId
    expect(replacement).toBeDefined()
    expect(replacement).not.toBe(priorInBox.id)
    expect(box.gateway.sessions.get(replacement!)?.status).toBe("running")
  })

  it("detaches an ALIVE prior proxy (box untouched) and then closes the old row", async () => {
    const calls: string[] = []
    let detached = false
    const { resolver, providerResolver } = await setup({
      killPrev: false,
      prevAgentSession: {
        sessionId: "box_alive",
        // eslint-disable-next-line require-yield
        async *send(): AsyncIterable<AgentStreamEvent> {
          return
        },
        async cancel() {},
        // Mirrors the real proxy: once detached, close() never touches the box.
        async close() {
          calls.push(detached ? "close:noop" : "close:teardown")
        },
        detach() {
          detached = true
          calls.push("detach")
          return { remoteSessionId: "box_alive", transcriptSeq: 0 }
        },
      },
    })

    const result = await restartAgentSession(registry, resolver, prev, {
      resolveSandboxProvider: providerResolver,
    })

    expect(result.desc.sandboxId).toBe("sbx_prev_1")
    expect(calls).toEqual(["detach", "close:noop"])
    expect(registry.get(prev.id)?.status).toBe("killed")
    expect(registry.get(prev.id)?.endedReason).toBe("restarted")
    // A restart is not a shutdown detach: never queued for the boot reattach pass.
    expect(registry.get(prev.id)?.hostDetached).toBeUndefined()
  })

  async function restartCloseAndCollectCommands(patch: Partial<typeof prev> = {}) {
    const sessionsDir = await mkdtemp(join(tmpdir(), "agentproto-sbx-restart-sessions-"))
    setDefaultSessionsBaseDir(sessionsDir)
    try {
      const target: SandboxDeliveryTarget = {
        checkoutDir: "/home/user/proj",
        branch: "wt/restart-me",
        baseSha: "c".repeat(40),
      }
      const { resolver, providerResolver } = await setup({ deliveryTarget: target })
      const commands: string[] = []
      const inner = box.provider
      const withExec: (slug: string) => Promise<SandboxProviderHandle | null> = async slug => {
        const handle = await providerResolver(slug)
        if (!handle) return null
        return {
          ...handle,
          provider: {
            boot: inner.boot.bind(inner),
            async connect(sandboxId: string, spec: SandboxSpec, connectOpts: Parameters<NonNullable<typeof inner.connect>>[2]) {
              const booted = await inner.connect!(sandboxId, spec, connectOpts)
              return {
                ...booted,
                async exec(o: { command: string }) {
                  commands.push(o.command)
                  return { exitCode: 0, stdout: "ahead=0\nuncommitted=0\n", stderr: "", durationMs: 1 }
                },
              }
            },
          },
        }
      }

      const result = await restartAgentSession(registry, resolver, { ...prev, ...patch }, {
        resolveSandboxProvider: withExec,
      })
      expect(result.desc.sandboxDeliveryTarget).toEqual(target)

      registry.kill(result.desc.id)
      await vi.waitFor(() => expect(registry.get(result.desc.id)?.sandboxDelivery).toBeDefined())

      expect(commands.some(c => c.includes("wt/restart-me") && c.includes("rev-list"))).toBe(true)
      expect(registry.get(result.desc.id)?.sandboxDelivery?.branch).toBe("wt/restart-me")
      return { commands, desc: registry.get(result.desc.id)! }
    } finally {
      setDefaultSessionsBaseDir(undefined)
      await rm(sessionsDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  }

  it("delivers the work branch when a restarted sandbox session closes", async () => {
    const { commands } = await restartCloseAndCollectCommands()
    expect(commands.some(c => c.includes("commit-tree"))).toBe(true)
  })

  it("keeps the spawn's sandboxCheckpoint:false override across a restart — teardown only counts uncommitted files", async () => {
    const { commands, desc } = await restartCloseAndCollectCommands({ sandboxCheckpointOverride: false })
    expect(commands.some(c => c.includes("commit-tree"))).toBe(false)
    expect(desc.sandboxCheckpointOverride).toBe(false)
  })

  it("a session with no work branch restarts without any delivery hook", async () => {
    const { resolver, providerResolver } = await setup()
    const result = await restartAgentSession(registry, resolver, prev, {
      resolveSandboxProvider: providerResolver,
    })
    expect(result.desc.sandboxDeliveryTarget).toBeUndefined()
  })

  describe("when the box is gone", () => {
    const target: SandboxDeliveryTarget = {
      checkoutDir: "/home/user/agentproto",
      branch: "wt/resume-me",
      baseSha: "c".repeat(40),
    }

    afterEach(() => {
      wsConfigState.value = { version: 1, workspaces: [] }
    })

    function goneBoxResolver(
      providerResolver: (slug: string) => Promise<SandboxProviderHandle | null>,
      execCalls: SandboxExecOpts[],
      boots: { count: number },
      files?: { writes: Array<{ path: string; bytes: number }> },
    ): (slug: string) => Promise<SandboxProviderHandle | null> {
      return async slug => {
        const handle = await providerResolver(slug)
        if (!handle) return null
        return {
          ...handle,
          defaultCwd: "/home/user",
          provider: {
            async connect(sandboxId: string): Promise<never> {
              throw new SandboxBoxGoneError(sandboxId, new Error("Sandbox not found"))
            },
            async boot() {
              boots.count++
              return {
                mcpUrl: `${box.gateway.url}/mcp`,
                sandboxId: "sbx_fresh_2",
                async stop() {},
                ...(files
                  ? {
                      async readFile() {
                        return new Uint8Array()
                      },
                      async writeFile(path: string, data: Uint8Array) {
                        files.writes.push({ path, bytes: data.byteLength })
                      },
                    }
                  : {}),
                async exec(o: SandboxExecOpts) {
                  execCalls.push(o)
                  const stdout = o.command.includes("rev-list")
                    ? "ahead=0\nuncommitted=0\n"
                    : o.command.includes("rev-parse --verify")
                      ? `${"e".repeat(40)}\n`
                      : ""
                  return { exitCode: 0, stdout, stderr: "", durationMs: 1 }
                },
              }
            },
          },
        }
      }
    }

    it("boots a FRESH box, re-clones the workspace remote and resumes the pushed work branch", async () => {
      wsConfigState.value = {
        version: 1,
        workspaces: [
          {
            slug: "agentproto",
            path: "/Users/op/projects/agentproto",
            addedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            remote: { url: "https://github.com/acme/agentproto.git" },
          },
        ],
      }
      let prevClosed = false
      const { resolver, providerResolver } = await setup({
        deliveryTarget: target,
        workspaceSlug: "agentproto",
        killPrev: false,
        prevAgentSession: {
          sessionId: "box_dead",
          // eslint-disable-next-line require-yield
          async *send(): AsyncIterable<AgentStreamEvent> {
            return
          },
          async cancel() {},
          async close() {
            prevClosed = true
          },
        },
      })
      const execCalls: SandboxExecOpts[] = []
      const boots = { count: 0 }

      const result = await restartAgentSession(registry, resolver, prev, {
        resolveSandboxProvider: goneBoxResolver(providerResolver, execCalls, boots),
      })

      expect(boots.count).toBe(1)
      expect(result.desc.sandboxId).toBe("sbx_fresh_2")
      expect(result.desc.cwd).toBe("/home/user/agentproto")
      expect(receivedStarts[0]?.cwd).toBe("/home/user/agentproto")
      expect(result.desc.sandboxDeliveryTarget).toMatchObject({ branch: "wt/resume-me", baseSha: "e".repeat(40) })
      const commands = execCalls.map(c => c.command)
      expect(commands.some(c => c.includes("git clone -- 'https://github.com/acme/agentproto.git'"))).toBe(true)
      expect(commands.some(c => c.includes("--track 'origin/wt/resume-me'"))).toBe(true)
      expect(commands.some(c => c.includes("agentproto-checkpoint/wt/resume-me"))).toBe(true)
      // The dead box's row is closed: nothing is shared with the new one.
      expect(prevClosed).toBe(true)
      expect(registry.get(prev.id)?.status).not.toBe("running")
    })

    const remoteWorkspace = {
      slug: "agentproto",
      path: "/Users/op/projects/agentproto",
      addedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      remote: { url: "https://github.com/acme/agentproto.git" },
    }

    it("with no recorded work branch but a workspace remote, restarts on a fresh box from the base branch", async () => {
      wsConfigState.value = { version: 1, workspaces: [remoteWorkspace] }
      const { resolver, providerResolver } = await setup({ workspaceSlug: "agentproto" })
      const execCalls: SandboxExecOpts[] = []
      const boots = { count: 0 }

      const result = await restartAgentSession(registry, resolver, prev, {
        resolveSandboxProvider: goneBoxResolver(providerResolver, execCalls, boots),
      })

      expect(boots.count).toBe(1)
      expect(result.desc.sandboxId).toBe("sbx_fresh_2")
      expect(result.desc.cwd).toBe("/home/user/agentproto")
      // a fresh default work branch is cut from the base and recorded for the next restart
      const branch = result.desc.sandboxDeliveryTarget?.branch
      expect(branch).toMatch(/^wt\/[0-9a-f]{8}$/)
      expect(execCalls.map(c => c.command).some(c => c.includes(`git checkout -b '${branch}' 'origin/main'`))).toBe(true)
    })

    it("a non-wt/ recorded branch is not resumed: the fresh box starts from the base branch", async () => {
      wsConfigState.value = { version: 1, workspaces: [remoteWorkspace] }
      const { resolver, providerResolver } = await setup({
        deliveryTarget: { ...target, branch: "feature/hand-made" },
        workspaceSlug: "agentproto",
      })
      const execCalls: SandboxExecOpts[] = []
      const result = await restartAgentSession(registry, resolver, prev, {
        resolveSandboxProvider: goneBoxResolver(providerResolver, execCalls, { count: 0 }),
      })
      expect(result.desc.sandboxDeliveryTarget?.branch).toMatch(/^wt\//)
      expect(execCalls.some(c => c.command.includes("feature/hand-made"))).toBe(false)
    })

    it("fails loud, saying why and how to fix it, when the workspace has no remote", async () => {
      wsConfigState.value = {
        version: 1,
        workspaces: [{ ...remoteWorkspace, remote: undefined }],
      }
      const { resolver, providerResolver } = await setup({ workspaceSlug: "agentproto" })
      const boots = { count: 0 }
      const run = restartAgentSession(registry, resolver, prev, {
        resolveSandboxProvider: goneBoxResolver(providerResolver, [], boots),
      })
      await expect(run).rejects.toThrow(/sbx_prev_1.*expired or is unreachable/i)
      await expect(run).rejects.toThrow(/workspace "agentproto" has no remote configured/)
      await expect(run).rejects.toThrow(/no work branch/)
      await expect(run).rejects.toThrow(/agentproto workspace remote set agentproto --url … --token-stdin/)
      expect(boots.count).toBe(0)
    })

    it("fails loud saying the workspace is no longer registered when it was removed", async () => {
      const { resolver, providerResolver } = await setup({ deliveryTarget: target })
      await expect(
        restartAgentSession(registry, resolver, prev, {
          resolveSandboxProvider: goneBoxResolver(providerResolver, [], { count: 0 }),
        }),
      ).rejects.toThrow(/workspace "default" is no longer registered.*workspace remote set default --url … --token-stdin/s)
    })

    function noRemoteWorkspace(path: string): void {
      wsConfigState.value = {
        version: 1,
        workspaces: [
          {
            slug: "scratch",
            path,
            addedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }
    }

    describe("workspace with no configured remote", () => {
      let repoDir: string
      afterEach(async () => {
        deriveState.isPublic = false
        setMcpCredentialDeps({})
        if (repoDir) await rm(repoDir, { recursive: true, force: true })
      })

      async function gitRepoWithOrigin(origin: string): Promise<string> {
        repoDir = await mkdtemp(join(tmpdir(), "agentproto-sbx-restart-repo-"))
        execFileSync("git", ["init", "-q"], { cwd: repoDir })
        execFileSync("git", ["remote", "add", "origin", origin], { cwd: repoDir })
        return repoDir
      }

      it("restores the last tarball checkpoint into a fresh box for a non-git workspace dir", async () => {
        noRemoteWorkspace("/Users/op/scratch")
        const { resolver, providerResolver } = await setup({ workspaceSlug: "scratch" })
        const prevDir = sessionTranscriptDir(prev.id)
        await writePendingTarRecord(prevDir, { dir: "/home/user/scratch" })
        await mkdir(prevDir, { recursive: true })
        await writeFile(tarArchivePath(prevDir), Buffer.from("fake-archive-bytes"))
        const execCalls: SandboxExecOpts[] = []
        const boots = { count: 0 }
        const files = { writes: [] as Array<{ path: string; bytes: number }> }

        const result = await restartAgentSession(registry, resolver, prev, {
          resolveSandboxProvider: goneBoxResolver(providerResolver, execCalls, boots, files),
        })

        expect(boots.count).toBe(1)
        expect(result.desc.sandboxId).toBe("sbx_fresh_2")
        expect(result.desc.cwd).toBe("/home/user/scratch")
        expect(receivedStarts[0]?.cwd).toBe("/home/user/scratch")
        expect(files.writes).toEqual([{ path: "/tmp/agentproto-workspace-restore.tar.gz", bytes: 18 }])
        const commands = execCalls.map(c => c.command)
        expect(commands.some(c => c.includes("tar --no-same-owner -xzf"))).toBe(true)
        expect(commands.some(c => c.includes("git clone"))).toBe(false)
        // The restarted session continues the tar chain (a second restart still works).
        const nextDir = sessionTranscriptDir(result.desc.id)
        expect(await readTarTarget(nextDir)).toEqual({ dir: "/home/user/scratch" })
        expect((await readFile(tarArchivePath(nextDir))).toString()).toBe("fake-archive-bytes")
      })

      it("fails loud, naming the missing checkpoint, when a tar-mode session never saved one", async () => {
        noRemoteWorkspace("/Users/op/scratch")
        const { resolver, providerResolver } = await setup({ workspaceSlug: "scratch" })
        await writePendingTarRecord(sessionTranscriptDir(prev.id), { dir: "/home/user/scratch" })
        const boots = { count: 0 }
        await expect(
          restartAgentSession(registry, resolver, prev, {
            resolveSandboxProvider: goneBoxResolver(providerResolver, [], boots, { writes: [] }),
          }),
        ).rejects.toThrow(/expired.*workspace "scratch" has no git remote and no tarball checkpoint was saved.*workspace remote set scratch/is)
        expect(boots.count).toBe(0)
      })

      it("fails loud with a hint when the session has neither a work branch nor a tar checkpoint", async () => {
        noRemoteWorkspace("/Users/op/scratch")
        const { resolver, providerResolver } = await setup({ workspaceSlug: "scratch" })
        const boots = { count: 0 }
        await expect(
          restartAgentSession(registry, resolver, prev, {
            resolveSandboxProvider: goneBoxResolver(providerResolver, [], boots),
          }),
        ).rejects.toThrow(/workspace "scratch" has no remote configured and the session recorded no work branch.*not a git repository/is)
        expect(boots.count).toBe(0)
      })

      it("re-clones the git origin (derived, https) and resumes the work branch when the workspace has no remote", async () => {
        deriveState.isPublic = true
        noRemoteWorkspace(await gitRepoWithOrigin("git@github.com:acme/derived.git"))
        const { resolver, providerResolver } = await setup({
          deliveryTarget: target,
          workspaceSlug: "scratch",
        })
        const execCalls: SandboxExecOpts[] = []
        const boots = { count: 0 }

        const result = await restartAgentSession(registry, resolver, prev, {
          resolveSandboxProvider: goneBoxResolver(providerResolver, execCalls, boots),
        })

        expect(boots.count).toBe(1)
        const commands = execCalls.map(c => c.command)
        expect(commands.some(c => c.includes("git clone -- 'https://github.com/acme/derived.git'"))).toBe(true)
        expect(commands.some(c => c.includes("--track 'origin/wt/resume-me'"))).toBe(true)
        expect(result.desc.sandboxDeliveryTarget).toMatchObject({ branch: "wt/resume-me" })
        expect(commands.some(c => c.includes("tar --no-same-owner"))).toBe(false)
      })

      it("a derived remote with no recorded work branch starts the fresh box on a default wt/ branch", async () => {
        deriveState.isPublic = true
        noRemoteWorkspace(await gitRepoWithOrigin("git@github.com:acme/derived.git"))
        const { resolver, providerResolver } = await setup({ workspaceSlug: "scratch" })
        const boots = { count: 0 }
        const result = await restartAgentSession(registry, resolver, prev, {
          resolveSandboxProvider: goneBoxResolver(providerResolver, [], boots),
        })
        expect(boots.count).toBe(1)
        expect(result.desc.sandboxDeliveryTarget?.branch).toMatch(/^wt\//)
      })

      it("fails loud, pointing at `workspace remote set`, when the origin is not publicly cloneable", async () => {
        deriveState.isPublic = false
        noRemoteWorkspace(await gitRepoWithOrigin("git@github.com:acme/private.git"))
        const { resolver, providerResolver } = await setup({
          deliveryTarget: target,
          workspaceSlug: "scratch",
        })
        const boots = { count: 0 }
        await expect(
          restartAgentSession(registry, resolver, prev, {
            resolveSandboxProvider: goneBoxResolver(providerResolver, [], boots),
          }),
        ).rejects.toThrow(/workspace "scratch" has no remote configured.*not publicly cloneable, and a derived remote never carries a credential/is)
        expect(boots.count).toBe(0)
      })
    })
  })
})
