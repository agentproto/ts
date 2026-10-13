/**
 * `agent_start({ workspaceSlug, sandbox })` for a workspace with NO `remote`
 * in workspaces.json: the clone source is derived from the checkout's git
 * `origin` (using the registered credential), or — when nothing can be derived
 * — the box's working dir is checkpointed to the host as a tarball. The box is
 * an in-process daemon behind a fake provider; nothing leaves the machine.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import type { SandboxExecOpts, SandboxExecResult, SandboxProvider } from "@agentproto/sandbox"

import { createGateway, type GatewayHandle } from "../index.js"
import { spawnAgentSession, type SandboxSpecInput, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type SessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { sessionTranscriptDir, setDefaultSessionsBaseDir } from "../transcript-writer.js"
import { readTarTarget, tarArchivePath } from "../sandbox-tar-checkpoint.js"
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

vi.mock("../sandbox-workspace-derive-remote.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../sandbox-workspace-derive-remote.js")>()
  return {
    ...actual,
    // Never touch the network: no origin is anonymously cloneable.
    resolveSandboxWorkspaceSource: (ws: Parameters<typeof actual.resolveSandboxWorkspaceSource>[0]) =>
      actual.resolveSandboxWorkspaceSource(ws, { isPubliclyCloneable: async () => false }),
  }
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

describe("agent_start sandbox — workspace without a configured remote", () => {
  let receivedStarts: Array<Record<string, unknown>>
  let execCalls: SandboxExecOpts[]
  let bootEnvs: Array<Record<string, string> | undefined>
  let stopSpy: ReturnType<typeof vi.fn>
  let gateway: GatewayHandle
  let boxWorkspace: string
  let hostDir: string
  let repoDir: string | undefined
  let registry: SessionsRegistry
  let provider: SandboxProvider
  let notices: string[]
  let packedBytes: Uint8Array

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

  function setWorkspace(path: string): void {
    wsConfigState.value = {
      version: 1,
      workspaces: [
        { slug: "scratch", path, addedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
    }
  }

  function gitRepoWithOrigin(origin: string): string {
    repoDir = execFileSync("mktemp", ["-d", join(tmpdir(), "agentproto-sbx-noremote-repo-XXXXXX")]).toString().trim()
    execFileSync("git", ["init", "-q"], { cwd: repoDir })
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: repoDir })
    return repoDir
  }

  beforeEach(async () => {
    receivedStarts = []
    execCalls = []
    bootEnvs = []
    notices = []
    packedBytes = new Uint8Array([1, 2, 3, 4])
    stopSpy = vi.fn(async () => undefined)
    boxWorkspace = await mkdtemp(join(tmpdir(), "agentproto-sandbox-nr-box-"))
    hostDir = await mkdtemp(join(tmpdir(), "agentproto-sandbox-nr-host-"))
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
        sandboxId: "sbx_fake_nr",
        stop: stopSpy,
        async exec(o: SandboxExecOpts) {
          execCalls.push(o)
          if (o.command.includes("rev-list")) return ok("ahead=0\nuncommitted=0\n")
          if (o.command.includes("rev-parse")) return ok(`${BASE_SHA}\n`)
          if (o.command.includes("sha256sum")) return ok(`bytes=${packedBytes.byteLength}\nsha=${"d".repeat(64)}\n`)
          return ok()
        },
        async readFile() {
          return packedBytes
        },
        async writeFile() {},
      }
    }
    provider = {
      boot: vi.fn(async (_spec, opts) => bootedFor(opts?.env)),
      connect: vi.fn(async (_id, _spec, opts) => bootedFor(opts?.env)),
    }
    registry = createSessionsRegistry({ persist: false, transcriptDir: join(hostDir, "transcripts") })
    const recordNotice = registry.recordNotice.bind(registry)
    vi.spyOn(registry, "recordNotice").mockImplementation((id, text) => {
      notices.push(text)
      return recordNotice(id, text)
    })
    keychain.reads.length = 0
    keychain.values = {}
    setMcpCredentialDeps({})
    setWorkspace("/Users/op/projects/scratch")
  })

  afterEach(async () => {
    setMcpCredentialDeps({})
    setDefaultSessionsBaseDir(undefined)
    registry.shutdown()
    await gateway.stop()
    await rm(hostDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(boxWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    if (repoDir) await rm(repoDir, { recursive: true, force: true })
    repoDir = undefined
  })

  it("derives the clone source from the git origin (ssh → https) with the registered credential, without persisting it", async () => {
    setWorkspace(gitRepoWithOrigin("git@github.com:acme/derived.git"))
    keychain.values["agentproto.git.scratch"] = FAKE_TOKEN
    const before = JSON.stringify(wsConfigState.value)

    const result = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      sandbox: "fake",
      workspaceSlug: "scratch",
      worktree: { slug: "x" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(bootEnvs[0]?.AGENTPROTO_GIT_TOKEN).toBe(FAKE_TOKEN)
    const commands = execCalls.map(c => c.command)
    expect(commands.some(c => c.includes("git clone -- 'https://github.com/acme/derived.git'"))).toBe(true)
    expect(commands.some(c => c.includes("git checkout -b 'wt/x'"))).toBe(true)
    expect(receivedStarts[0]?.cwd).toBe("/home/user/scratch")
    expect(result.descriptor.sandboxDeliveryTarget).toMatchObject({ branch: "wt/x" })
    expect(notices.join("\n")).toMatch(/no remote configured — cloning its git origin https:\/\/github.com\/acme\/derived.git/)
    expect(JSON.stringify(wsConfigState.value)).toBe(before)
    expect(JSON.stringify(execCalls)).not.toContain(FAKE_TOKEN)
    expect(JSON.stringify(notices)).not.toContain(FAKE_TOKEN)
    expect(await readTarTarget(sessionTranscriptDir(result.descriptor.id))).toBeUndefined()
  })

  it("falls back to tar checkpoints when the origin is private and no credential is registered", async () => {
    setWorkspace(gitRepoWithOrigin("git@github.com:acme/private.git"))

    const result = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      sandbox: "fake",
      workspaceSlug: "scratch",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(execCalls.some(c => c.command.includes("git clone"))).toBe(false)
    expect(notices.join("\n")).toMatch(/not publicly cloneable and no credential is registered/)
    expect(notices.join("\n")).toMatch(/agentproto workspace remote set scratch/)
    expect(await readTarTarget(sessionTranscriptDir(result.descriptor.id))).toEqual({ dir: "/home/user/scratch" })
  })

  it("a non-git workspace starts in an empty <home>/<slug>, then tars the dir to the host at teardown", async () => {
    const result = await spawnAgentSession(makeDeps(), {
      adapter: "fake-cli",
      sandbox: "fake",
      workspaceSlug: "scratch",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const id = result.descriptor.id

    expect(receivedStarts[0]?.cwd).toBe("/home/user/scratch")
    expect(result.descriptor.cwd).toBe("/home/user/scratch")
    expect(execCalls.some(c => c.command.includes("git clone"))).toBe(false)
    expect(execCalls.some(c => c.command.includes("mkdir -p '/home/user/scratch'"))).toBe(true)
    expect(result.descriptor.sandboxDeliveryTarget).toBeUndefined()
    const text = notices.join("\n")
    expect(text).toMatch(/not a git repository/)
    expect(text).toMatch(/checkpointed to the host as a tarball/)

    registry.kill(id)
    await vi.waitFor(() => expect(stopSpy).toHaveBeenCalled())
    const archive = tarArchivePath(sessionTranscriptDir(id))
    await vi.waitFor(() => expect(existsSync(archive)).toBe(true))
    expect([...(await readFile(archive))]).toEqual([1, 2, 3, 4])
    const pack = execCalls.map(c => c.command).find(c => c.includes("sha256sum"))
    expect(pack).toContain("cd '/home/user/scratch'")
    expect(pack).toContain("node_modules")
    expect(execCalls.some(c => c.command.includes("push"))).toBe(false)
  })
})
