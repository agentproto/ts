/**
 * `agent_start({ workspaceSlug, sandbox, worktree })` for a workspace with a
 * `remote`: the box is booted with the git token in its env, the repo is
 * cloned and `wt/<slug>` cut through the booted sandbox's `exec`, the session
 * lands in the checkout, and killing the session delivers the branch. The box
 * is an in-process daemon behind a fake provider; nothing leaves the machine.
 * The token is a fake value and must never appear in any exec call or in the
 * adapter's start args.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import type { SandboxExecOpts, SandboxExecResult, SandboxProvider } from "@agentproto/sandbox"

import { createGateway, type GatewayHandle } from "../index.js"
import { spawnAgentSession, type SandboxSpecInput, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type SessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { setDefaultSessionsBaseDir } from "../transcript-writer.js"
import { setMcpCredentialDeps } from "../mcp-credential-deps.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import { sandboxSpecWithReuseSchema } from "../sandbox-spec-schema.js"

const FAKE_TOKEN = "ghp_fake_spawn_token_0005"
const BASE_SHA = "c".repeat(40)

const keychain = vi.hoisted(() => ({ reads: [] as string[], values: {} as Record<string, string> }))
vi.mock("@agentproto/auth", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/auth")>()
  class FakeKeychainStore {
    async read(ref: { path: string }) {
      keychain.reads.push(ref.path)
      const value = keychain.values[ref.path]
      return value === undefined ? undefined : { value, kind: "pat" }
    }
  }
  return { ...actual, KeychainStore: FakeKeychainStore }
})

const wsConfigState = vi.hoisted(() => ({
  value: { version: 1, workspaces: [] } as import("../workspaces-config.js").WorkspacesConfig,
}))
vi.mock("../workspaces-config.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../workspaces-config.js")>()
  return { ...actual, loadWorkspacesConfig: vi.fn(async () => wsConfigState.value) }
})

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

function makeFakeCliResolver(receivedStarts: Array<Record<string, unknown>>): AgentAdapterResolver {
  return async slug => {
    if (slug !== "fake-cli") return null
    return {
      commandPreview: "fake-cli (test double)",
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

function ok(stdout = ""): SandboxExecResult {
  return { exitCode: 0, stdout, stderr: "", durationMs: 1 }
}

describe("agent_start sandbox — workspace remote checkout + delivery", () => {
  let receivedStarts: Array<Record<string, unknown>>
  let execCalls: SandboxExecOpts[]
  let execImpl: (opts: SandboxExecOpts) => Promise<SandboxExecResult>
  let bootEnvs: Array<Record<string, string> | undefined>
  let stopSpy: ReturnType<typeof vi.fn>
  let pauseSpy: ReturnType<typeof vi.fn>
  let gateway: GatewayHandle
  let boxWorkspace: string
  let hostDir: string
  let registry: SessionsRegistry
  let provider: SandboxProvider
  let withExec: boolean

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
    receivedStarts = []
    execCalls = []
    bootEnvs = []
    withExec = true
    stopSpy = vi.fn(async () => undefined)
    pauseSpy = vi.fn(async () => undefined)
    execImpl = async opts => {
      // The delivery probe also calls rev-parse (HEAD): match it first.
      if (opts.command.includes("rev-list")) return ok("ahead=2\nuncommitted=0\n")
      if (opts.command.includes("rev-parse")) return ok(`${BASE_SHA}\n`)
      return ok()
    }
    boxWorkspace = await mkdtemp(join(tmpdir(), "agentproto-sandbox-ws-box-"))
    hostDir = await mkdtemp(join(tmpdir(), "agentproto-sandbox-ws-host-"))
    setDefaultSessionsBaseDir(join(hostDir, "sessions"))
    gateway = await createGateway({
      workspace: boxWorkspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
      persistPath: join(boxWorkspace, "sessions.json"),
      resolveAgentAdapter: makeFakeCliResolver(receivedStarts),
    })
    const bootedFor = (env: Record<string, string> | undefined) => {
      bootEnvs.push(env)
      return {
        mcpUrl: `${gateway.url}/mcp`,
        sandboxId: "sbx_fake_ws",
        stop: stopSpy,
        pause: pauseSpy,
        ...(withExec
          ? {
              async exec(o: SandboxExecOpts) {
                execCalls.push(o)
                return execImpl(o)
              },
            }
          : {}),
      }
    }
    provider = {
      boot: vi.fn(async (_spec, opts) => bootedFor(opts?.env)),
      connect: vi.fn(async (_id, _spec, opts) => bootedFor(opts?.env)),
    }
    registry = createSessionsRegistry({ persist: false, transcriptDir: join(hostDir, "transcripts") })
    keychain.reads.length = 0
    keychain.values = {}
    setMcpCredentialDeps({ resolveSandboxSecret: async slug => (slug === "AGENTPROTO_GIT_TOKEN" ? FAKE_TOKEN : null) })
    wsConfigState.value = {
      version: 1,
      workspaces: [
        {
          slug: "agentproto",
          path: "/Users/op/projects/agentproto",
          addedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          remote: { url: "https://github.com/acme/agentproto.git", credentialRef: "agentproto.git.agentproto" },
        },
      ],
    }
  })

  afterEach(async () => {
    setMcpCredentialDeps({})
    setDefaultSessionsBaseDir(undefined)
    registry.shutdown()
    await gateway.stop()
    await rm(hostDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(boxWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it("checks the repo out on wt/<slug>, starts the session there, and keeps the token out of every command", async () => {
    const result = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      sandbox: "fake",
      workspaceSlug: "agentproto",
      worktree: { slug: "x", base: "origin/main" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(bootEnvs[0]?.AGENTPROTO_GIT_TOKEN).toBe(FAKE_TOKEN)
    // the same daemon-derived token, for `gh pr create` in the box
    expect(bootEnvs[0]?.GH_TOKEN).toBe(FAKE_TOKEN)
    expect(receivedStarts[0]?.cwd).toBe("/home/user/agentproto")
    expect(result.descriptor.cwd).toBe("/home/user/agentproto")

    const commands = execCalls.map(c => c.command)
    expect(commands.some(c => c.includes("git clone -- 'https://github.com/acme/agentproto.git'"))).toBe(true)
    expect(commands.some(c => c.includes("git checkout -b 'wt/x' 'origin/main'"))).toBe(true)
    expect(JSON.stringify(execCalls)).not.toContain(FAKE_TOKEN)
    expect(JSON.stringify(receivedStarts)).not.toContain(FAKE_TOKEN)
    expect(JSON.stringify(result.descriptor)).not.toContain(FAKE_TOKEN)
  })

  it("killing the session pushes the work branch and records the delivery before the box stops", async () => {
    const result = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      sandbox: "fake",
      workspaceSlug: "agentproto",
      worktree: { slug: "x" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const id = result.descriptor.id

    registry.kill(id)
    await vi.waitFor(() => expect(stopSpy).toHaveBeenCalled())

    const commands = execCalls.map(c => c.command)
    expect(commands.some(c => c.includes("push --no-verify -u origin 'wt/x'"))).toBe(true)
    const delivery = registry.get(id)?.sandboxDelivery
    expect(delivery).toMatchObject({ branch: "wt/x", baseSha: BASE_SHA, ahead: 2, push: { status: "pushed" } })
    const persisted = JSON.parse(await readFile(join(hostDir, "sessions", id, "delivery.json"), "utf8"))
    expect(persisted.push.status).toBe("pushed")
    expect(JSON.stringify(execCalls)).not.toContain(FAKE_TOKEN)
  })

  it("without a worktree a default wt/<slug> work branch is cut and recorded as the delivery target", async () => {
    const result = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      sandbox: "fake",
      workspaceSlug: "agentproto",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const id = result.descriptor.id
    const target = registry.get(id)?.sandboxDeliveryTarget
    expect(target).toMatchObject({ checkoutDir: "/home/user/agentproto", baseSha: BASE_SHA })
    expect(target?.branch).toMatch(/^wt\/[0-9a-f]{8}$/)
    expect(
      execCalls.map(c => c.command).some(c => c.includes(`git checkout -b '${target?.branch}' 'origin/main'`)),
    ).toBe(true)

    registry.kill(id)
    await vi.waitFor(() => expect(stopSpy).toHaveBeenCalled())
    expect(execCalls.some(c => c.command.includes(`push --no-verify -u origin '${target?.branch}'`))).toBe(true)
    expect(registry.get(id)?.sandboxDelivery).toMatchObject({ branch: target?.branch, push: { status: "pushed" } })
  })

  it("worktree: false opts out: the session works on the default branch and nothing is delivered", async () => {
    const result = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      sandbox: "fake",
      workspaceSlug: "agentproto",
      worktree: false,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(execCalls.map(c => c.command).some(c => c.includes("git -C '/home/user/agentproto' checkout 'main'"))).toBe(true)
    expect(registry.get(result.descriptor.id)?.sandboxDeliveryTarget).toBeUndefined()
    registry.kill(result.descriptor.id)
    await vi.waitFor(() => expect(stopSpy).toHaveBeenCalled())
    expect(execCalls.some(c => c.command.includes("push"))).toBe(false)
    expect(registry.get(result.descriptor.id)?.sandboxDelivery).toBeUndefined()
  })

  describe("turn-end safety net", () => {
    const HAND_SHA = "d".repeat(40)

    async function spawnAndRunTurn(learned: string) {
      execImpl = async opts => {
        if (opts.command.includes("--abbrev-ref")) return ok(`branch=${learned}\nbase=${HAND_SHA}\n`)
        if (opts.command.includes("rev-list")) return ok("ahead=2\nuncommitted=0\n")
        if (opts.command.includes("rev-parse")) return ok(`${BASE_SHA}\n`)
        return ok()
      }
      const result = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        sandbox: "fake",
        workspaceSlug: "agentproto",
        worktree: { slug: "x" },
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("spawn failed")
      await registry.sendPrompt(result.descriptor.id, "go")
      return result.descriptor.id
    }

    it("adopts a different wt/ branch the agent moved to as the delivery target, and delivers that branch", async () => {
      const id = await spawnAndRunTurn("wt/by-hand")
      await vi.waitFor(() =>
        expect(registry.get(id)?.sandboxDeliveryTarget).toEqual({
          checkoutDir: "/home/user/agentproto",
          branch: "wt/by-hand",
          baseSha: HAND_SHA,
        }),
      )
      registry.kill(id)
      await vi.waitFor(() => expect(stopSpy).toHaveBeenCalled())
      expect(execCalls.some(c => c.command.includes("push --no-verify -u origin 'wt/by-hand'"))).toBe(true)
      expect(execCalls.some(c => c.command.includes("push --no-verify -u origin 'wt/x'"))).toBe(false)
    })

    it("leaves the recorded target alone when the box is on a non-wt/ branch", async () => {
      const id = await spawnAndRunTurn("main")
      await vi.waitFor(() => expect(execCalls.some(c => c.command.includes("--abbrev-ref"))).toBe(true))
      expect(registry.get(id)?.sandboxDeliveryTarget?.branch).toBe("wt/x")
    })

    it("leaves the recorded target alone when the box is still on it", async () => {
      const id = await spawnAndRunTurn("wt/x")
      await vi.waitFor(() => expect(execCalls.some(c => c.command.includes("--abbrev-ref"))).toBe(true))
      expect(registry.get(id)?.sandboxDeliveryTarget).toMatchObject({ branch: "wt/x", baseSha: BASE_SHA })
    })
  })

  it("a failing setup step stops the box and returns sandbox_workspace_setup_failed", async () => {
    execImpl = async opts =>
      opts.command.includes("git clone")
        ? { exitCode: 128, stdout: "", stderr: "fatal: Authentication failed", durationMs: 1 }
        : ok(opts.command.includes("rev-parse") ? `${BASE_SHA}\n` : "")
    const result = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      sandbox: "fake",
      workspaceSlug: "agentproto",
      worktree: { slug: "x" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("sandbox_workspace_setup_failed")
    expect(result.message).toContain("git-clone")
    expect(result.message).not.toContain(FAKE_TOKEN)
    expect(stopSpy).toHaveBeenCalled()
    expect(receivedStarts).toHaveLength(0)
  })

  it("a failed setup on a REUSED box pauses it instead of killing it", async () => {
    execImpl = async opts =>
      opts.command.includes("git clone")
        ? { exitCode: 128, stdout: "", stderr: "fatal: unable to access", durationMs: 1 }
        : ok()
    const result = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      sandbox: { provider: "fake", config: {}, reuse: "sbx_prior_box" },
      workspaceSlug: "agentproto",
      worktree: { slug: "x" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("sandbox_workspace_setup_failed")
    expect(pauseSpy).toHaveBeenCalledTimes(1)
    expect(stopSpy).not.toHaveBeenCalled()
  })

  describe("reusing a box that holds a workspace's git token", () => {
    const secondWorkspace = {
      slug: "other",
      path: "/Users/op/projects/other",
      addedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      remote: { url: "https://github.com/acme/other.git", credentialRef: "agentproto.git.other" },
    }

    async function bootForAgentproto(): Promise<void> {
      wsConfigState.value.workspaces.push(secondWorkspace)
      keychain.values["agentproto.git.agentproto"] = FAKE_TOKEN
      const first = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        sandbox: "fake",
        workspaceSlug: "agentproto",
        worktree: { slug: "x" },
      })
      expect(first.ok).toBe(true)
      vi.mocked(provider.connect!).mockClear()
    }

    it("refuses a reuse from another workspace", async () => {
      await bootForAgentproto()
      const result = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        sandbox: { provider: "fake", config: {}, reuse: "sbx_fake_ws" },
        workspaceSlug: "other",
        worktree: { slug: "y" },
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe("sandbox_reuse_workspace_mismatch")
      expect(result.message).toContain('"agentproto"')
      expect(provider.connect).not.toHaveBeenCalled()
    })

    it("refuses a reuse with no workspace at all", async () => {
      await bootForAgentproto()
      const result = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        sandbox: { provider: "fake", config: {}, reuse: "sbx_fake_ws" },
        cwd: "/home/user",
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe("sandbox_reuse_workspace_mismatch")
      expect(provider.connect).not.toHaveBeenCalled()
    })

    it("allows the reuse from the same workspace", async () => {
      await bootForAgentproto()
      const result = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        sandbox: { provider: "fake", config: {}, reuse: "sbx_fake_ws" },
        workspaceSlug: "agentproto",
        worktree: { slug: "z" },
      })
      expect(result.ok).toBe(true)
      expect(provider.connect).toHaveBeenCalledTimes(1)
    })
  })

  it("a provider that cannot exec fails the spawn instead of starting in an empty box", async () => {
    withExec = false
    const result = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      sandbox: "fake",
      workspaceSlug: "agentproto",
      worktree: { slug: "x" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("sandbox_workspace_setup_failed")
    expect(stopSpy).toHaveBeenCalled()
  })

  it("an unusable worktree slug is rejected before any box boots", async () => {
    const result = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      sandbox: "fake",
      workspaceSlug: "agentproto",
      worktree: { slug: "x; rm -rf /" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("sandbox_workspace_setup_failed")
    expect(provider.boot).not.toHaveBeenCalled()
  })

  it("a workspace without a remote keeps the existing host-cwd behaviour", async () => {
    const [entry] = wsConfigState.value.workspaces
    if (!entry) throw new Error("fixture workspace missing")
    const { remote: _remote, ...bare } = entry
    wsConfigState.value = { version: 1, workspaces: [bare] }
    const result = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      sandbox: "fake",
      workspaceSlug: "agentproto",
    })
    expect(result.ok).toBe(true)
    expect(execCalls).toHaveLength(0)
    expect(receivedStarts[0]?.cwd).toBe("/home/user")
  })

  describe("cwd alongside workspaceSlug / without it", () => {
    const CHECKOUT = "/home/user/agentproto"

    function expectFullWorkspaceSetup(result: Extract<Awaited<ReturnType<typeof spawnAgentSession>>, { ok: true }>): void {
      const commands = execCalls.map(c => c.command)
      expect(commands.some(c => c.includes("git clone -- 'https://github.com/acme/agentproto.git'"))).toBe(true)
      expect(commands.some(c => c.includes("credential.https://github.com.helper"))).toBe(true)
      expect(bootEnvs[0]?.AGENTPROTO_GIT_TOKEN).toBe(FAKE_TOKEN)
      expect(bootEnvs[0]?.GH_TOKEN).toBe(FAKE_TOKEN)
      expect(result.descriptor.sandboxDeliveryTarget).toMatchObject({ checkoutDir: CHECKOUT })
      expect(result.descriptor.sandboxDeliveryTarget?.branch).toMatch(/^wt\//)
      expect(JSON.stringify(execCalls)).not.toContain(FAKE_TOKEN)
    }

    it("a cwd relative to the checkout still clones + tokens + delivers, and the session starts in that subdir", async () => {
      const result = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        sandbox: "fake",
        workspaceSlug: "agentproto",
        cwd: "packages/runtime",
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expectFullWorkspaceSetup(result)
      expect(receivedStarts[0]?.cwd).toBe(`${CHECKOUT}/packages/runtime`)
      expect(result.warnings ?? []).toEqual([])
    })

    it("an absolute in-box cwd under the box home is honoured, with the full workspace setup", async () => {
      const result = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        sandbox: "fake",
        workspaceSlug: "agentproto",
        cwd: `${CHECKOUT}/packages/runtime`,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expectFullWorkspaceSetup(result)
      expect(receivedStarts[0]?.cwd).toBe(`${CHECKOUT}/packages/runtime`)
      expect(result.warnings ?? []).toEqual([])
    })

    it("the box home itself (the reported cwd: \"/home/user\") lands in the checkout instead of silencing the clone", async () => {
      const result = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        sandbox: "fake",
        workspaceSlug: "agentproto",
        cwd: "/home/user",
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expectFullWorkspaceSetup(result)
      expect(receivedStarts[0]?.cwd).toBe(CHECKOUT)
      expect(result.warnings ?? []).toEqual([])
    })

    it("a HOST cwd is ignored with a warning: full workspace setup, session in the checkout", async () => {
      const result = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        sandbox: "fake",
        workspaceSlug: "agentproto",
        cwd: "/Users/op/projects/agentproto",
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expectFullWorkspaceSetup(result)
      expect(receivedStarts[0]?.cwd).toBe(CHECKOUT)
      expect(result.warnings?.join("\n")).toMatch(/cwd "\/Users\/op\/projects\/agentproto" ignored.*HOST path/)
    })

    it("an absolute cwd outside the box home is ignored with a warning", async () => {
      const result = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        sandbox: "fake",
        workspaceSlug: "agentproto",
        cwd: "/opt/elsewhere",
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expectFullWorkspaceSetup(result)
      expect(receivedStarts[0]?.cwd).toBe(CHECKOUT)
      expect(result.warnings?.join("\n")).toMatch(/ignored.*outside the box home/)
    })

    it("a cwd with an UNKNOWN workspaceSlug keeps its old meaning (no checkout to be relative to)", async () => {
      const result = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        sandbox: "fake",
        workspaceSlug: "nope",
        cwd: "/home/user/tmp",
      })
      expect(result.ok).toBe(true)
      expect(execCalls).toHaveLength(0)
      expect(receivedStarts[0]?.cwd).toBe("/home/user/tmp")
    })

    it("sandbox + cwd WITHOUT workspaceSlug: no clone / token, and the spawn result says so", async () => {
      const result = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        sandbox: "fake",
        cwd: "/home/user",
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(execCalls).toHaveLength(0)
      expect(bootEnvs[0] ?? {}).not.toHaveProperty("AGENTPROTO_GIT_TOKEN")
      expect(result.descriptor.sandboxDeliveryTarget).toBeUndefined()
      expect(receivedStarts[0]?.cwd).toBe("/home/user")
      expect(result.warnings?.join("\n")).toMatch(/no workspace remote.*no repo clone, no git token.*Pass `workspaceSlug`/)
    })

    it("sandbox with neither cwd nor workspaceSlug stays silent", async () => {
      const result = await spawnAgentSession(makeDeps(), { adapter: "fake-cli", sandbox: "fake" })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.warnings ?? []).toEqual([])
    })
  })

  describe("keychain refs are daemon-derived only", () => {
    const ATTACKER_SLOT = "agentproto.auth.victim"
    const WORKSPACE_SLOT = "agentproto.git.agentproto"

    it("a caller-supplied credentialRefs payload is rejected by the schema and never read from the keychain", async () => {
      keychain.values[ATTACKER_SLOT] = "victim-secret-value"
      setMcpCredentialDeps({ resolveSandboxSecret: async () => null })
      keychain.values[WORKSPACE_SLOT] = FAKE_TOKEN
      const sandbox = {
        provider: "fake",
        config: {},
        credentialRefs: [{ name: "STOLEN", credentialRef: ATTACKER_SLOT }],
      }
      expect(sandboxSpecWithReuseSchema.safeParse(sandbox).success).toBe(false)

      const result = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        sandbox: sandbox as unknown as SandboxSpecInput,
        workspaceSlug: "agentproto",
        worktree: { slug: "x" },
      })
      expect(result.ok).toBe(true)
      expect(keychain.reads).not.toContain(ATTACKER_SLOT)
      expect(bootEnvs[0]).not.toHaveProperty("STOLEN")
      expect(JSON.stringify(bootEnvs)).not.toContain("victim-secret-value")
    })

    it("a caller cannot override AGENTPROTO_GIT_TOKEN: it always resolves from the workspace's own ref", async () => {
      keychain.values[ATTACKER_SLOT] = "attacker-chosen-value"
      keychain.values[WORKSPACE_SLOT] = FAKE_TOKEN
      setMcpCredentialDeps({ resolveSandboxSecret: async () => null })
      const result = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        sandbox: {
          provider: "fake",
          config: {},
          env: { passthrough: ["AGENTPROTO_GIT_TOKEN"] },
          credentialRefs: [{ name: "AGENTPROTO_GIT_TOKEN", credentialRef: ATTACKER_SLOT }],
        } as unknown as SandboxSpecInput,
        workspaceSlug: "agentproto",
        worktree: { slug: "x" },
      })
      expect(result.ok).toBe(true)
      expect(bootEnvs[0]?.AGENTPROTO_GIT_TOKEN).toBe(FAKE_TOKEN)
      // GH_TOKEN re-resolves the same workspace ref (no value is cached)
      expect(bootEnvs[0]?.GH_TOKEN).toBe(FAKE_TOKEN)
      expect(new Set(keychain.reads)).toEqual(new Set([WORKSPACE_SLOT]))
    })

    it("a caller cannot override GH_TOKEN: passthrough, credentialRefs and join.tokenEnv all yield the workspace token", async () => {
      keychain.values[ATTACKER_SLOT] = "attacker-chosen-value"
      keychain.values[WORKSPACE_SLOT] = FAKE_TOKEN
      setMcpCredentialDeps({ resolveSandboxSecret: async slug => (slug === "GH_TOKEN" ? "operator-gh-token" : null) })
      const result = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        sandbox: {
          provider: "fake",
          config: {},
          env: { passthrough: ["GH_TOKEN"] },
          join: { tokenEnv: "GH_TOKEN" },
          credentialRefs: [{ name: "GH_TOKEN", credentialRef: ATTACKER_SLOT }],
        } as unknown as SandboxSpecInput,
        workspaceSlug: "agentproto",
        worktree: { slug: "x" },
      })
      expect(result.ok).toBe(true)
      expect(bootEnvs[0]?.GH_TOKEN).toBe(FAKE_TOKEN)
      expect(JSON.stringify(bootEnvs)).not.toContain("operator-gh-token")
      expect(keychain.reads).not.toContain(ATTACKER_SLOT)
      expect(JSON.stringify(execCalls)).not.toContain(FAKE_TOKEN)
    })

    it("the workspace's credentialRef beats a daemon-level AGENTPROTO_GIT_TOKEN", async () => {
      keychain.values[WORKSPACE_SLOT] = FAKE_TOKEN
      setMcpCredentialDeps({
        resolveSandboxSecret: async slug => (slug === "AGENTPROTO_GIT_TOKEN" ? "daemon-wide-token" : null),
      })
      const result = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        sandbox: { provider: "fake", config: {} },
        workspaceSlug: "agentproto",
        worktree: { slug: "x" },
      })
      expect(result.ok).toBe(true)
      expect(bootEnvs[0]?.AGENTPROTO_GIT_TOKEN).toBe(FAKE_TOKEN)
    })

    it("env.passthrough naming AGENTPROTO_GIT_TOKEN cannot pull the token into a box with no workspace remote", async () => {
      const result = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        sandbox: { provider: "fake", config: {}, env: { passthrough: ["AGENTPROTO_GIT_TOKEN"] } },
        cwd: "/home/user",
      })
      expect(result.ok).toBe(true)
      expect(bootEnvs[0] ?? {}).not.toHaveProperty("AGENTPROTO_GIT_TOKEN")
      expect(keychain.reads).toEqual([])
    })

    it("env.passthrough naming GH_TOKEN cannot pull the daemon's own GH_TOKEN into a box with no workspace remote", async () => {
      setMcpCredentialDeps({ resolveSandboxSecret: async slug => (slug === "GH_TOKEN" ? "operator-gh-token" : null) })
      const result = await spawnAgentSession(makeDeps(), {
        adapter: "fake-cli",
        sandbox: { provider: "fake", config: {}, env: { passthrough: ["GH_TOKEN"] } },
        cwd: "/home/user",
      })
      expect(result.ok).toBe(true)
      expect(bootEnvs[0] ?? {}).not.toHaveProperty("GH_TOKEN")
      expect(JSON.stringify(bootEnvs)).not.toContain("operator-gh-token")
    })
  })
})
