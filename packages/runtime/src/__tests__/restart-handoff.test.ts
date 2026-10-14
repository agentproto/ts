/**
 * Restart handoff: a restarted session that could not resume natively gets
 * the FULL prior conversation, not a 7k-char digest (restart-handoff.ts +
 * session-restart-core.ts's `resumeFallback` branch).
 *
 * Covered here:
 *  - the prior transcript is written into the box (re-attach AND fresh box)
 *    at `/home/user/.agentproto/prior-sessions/<id>.md`, full-fidelity
 *  - the `resumedFrom` ancestor chain is walked, capped at 5 hops
 *  - the injected prompt carries the deterministic checkpoint (goal/plan)
 *    and the transcript path(s)
 *  - a failed in-box write falls back to the old digest, never a failed
 *    restart
 *  - a local blank-fallback writes the transcript onto the host next to
 *    the NEW session and points at it
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import {
  SandboxBoxGoneError,
  type SandboxExecOpts,
  type SandboxExecResult,
  type SandboxProvider,
  type SandboxSpec,
} from "@agentproto/sandbox"

import { createGateway, type GatewayHandle } from "../index.js"
import {
  createSessionsRegistry,
  type SessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionDescriptor,
} from "../sessions.js"
import { restartAgentSession } from "../session-restart-core.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import type { SandboxDeliveryTarget } from "../sandbox-delivery.js"
import { setDefaultSessionsBaseDir } from "../transcript-writer.js"
import {
  writeBoxPriorTranscripts,
  boxPriorSessionPath,
  ANCESTOR_HOP_CAP,
} from "../restart-handoff.js"

// The in-box dir is a literal in restart-handoff.ts; mirror it here so the
// assertion doesn't silently drift with an import of the constant under test.
const BOX_DIR = "/home/user/.agentproto/prior-sessions"

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

/** Write daemon-transcript events for `sessionId` under the sessions base
 *  dir the exporters read from. */
async function writeEvents(base: string, sessionId: string, lines: object[]): Promise<void> {
  const dir = join(base, sessionId)
  await mkdir(dir, { recursive: true })
  writeFileSync(
    join(dir, "events.jsonl"),
    lines.map((l, i) => JSON.stringify({ seq: i + 1, ts: "2026-10-14T00:00:00.000Z", ...l })).join("\n") + "\n",
  )
}

/** A prior session's conversation: a goal, a plan, a long tool result, and
 *  a closing assistant message — enough for every checkpoint extractor. */
function priorConversationEvents(): object[] {
  return [
    { kind: "user-prompt", text: "Build the restart-handoff feature end to end." },
    {
      kind: "plan",
      entries: [
        { content: "write the handoff module", priority: "high", status: "completed" },
        { content: "wire it into restart", priority: "high", status: "pending" },
      ],
    },
    { kind: "tool-call", toolCallId: "t1", toolName: "bash", arguments: { command: "pnpm test" } },
    { kind: "tool-result", toolCallId: "t1", result: "R".repeat(500) },
    { kind: "text-delta", text: "Working on the wiring now." },
    { kind: "turn-end", reason: "completed" },
  ]
}

interface RecordedWrite {
  path: string
  text: string
}

/** File seam recorded by the fake box handles. */
function recordingSink(writes: RecordedWrite[]) {
  return {
    async writeFile(path: string, data: Uint8Array) {
      writes.push({ path, text: Buffer.from(data).toString("utf8") })
    },
  }
}

function makeResolver(
  box: { provider: SandboxProvider },
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

describe("restart handoff — full prior transcript + structured prompt", () => {
  const receivedStarts: Array<Record<string, unknown>> = []
  let gateway: GatewayHandle
  let provider: SandboxProvider
  let hostWorkspace: string
  let sessionsBase: string
  let registry: SessionsRegistry
  let prev: SessionDescriptor
  let boxWrites: RecordedWrite[]

  afterEach(async () => {
    registry.shutdown()
    await gateway.stop()
    setDefaultSessionsBaseDir(undefined)
    await rm(hostWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(sessionsBase, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    deriveState.isPublic = false
    wsConfigState.value = { version: 1, workspaces: [] }
  })

  /** Boot the in-process "box" daemon and a provider whose connect() works
   *  for a LIVE box id (returning a recording file seam) and reports
   *  `SandboxBoxGoneError` for dead ones — the re-attach and fresh-box
   *  write paths both go through it. */
  async function setup(opts: {
    deliveryTarget?: SandboxDeliveryTarget
    workspaceSlug?: string
    /** Return this instead of the recording seam from connect(). */
    connectOverride?: (sandboxId: string) => Record<string, unknown> | undefined
  } = {}): Promise<{
    resolver: AgentAdapterResolver
    providerResolver: (slug: string) => Promise<SandboxProviderHandle | null>
  }> {
    receivedStarts.length = 0
    boxWrites = []
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-restart-handoff-box-"))
    const port = await freePort()
    gateway = await createGateway({
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
    hostWorkspace = await mkdtemp(join(tmpdir(), "agentproto-restart-handoff-host-"))
    sessionsBase = join(hostWorkspace, "sessions")
    setDefaultSessionsBaseDir(sessionsBase)
    registry = createSessionsRegistry({
      persist: false,
      transcriptDir: join(hostWorkspace, "transcripts"),
    })
    prev = registry.spawnAgent({
      workspaceSlug: opts.workspaceSlug ?? "default",
      cwd: "/home/user",
      agentSession: fakeAgentSession("box"),
      adapterSlug: "fake-cli",
      commandPreview: "sandbox:fake → fake-cli",
      remote: true,
      sandboxId: "sbx_prev_1",
      sandboxTeardown: "pause",
      ...(opts.deliveryTarget ? { sandboxDeliveryTarget: opts.deliveryTarget } : {}),
    })
    await writeEvents(sessionsBase, prev.id, priorConversationEvents())
    registry.kill(prev.id)

    provider = {
      async boot(): Promise<never> {
        throw new Error("boot must never be called — this test only re-attaches")
      },
      async connect(sandboxId: string, _spec: SandboxSpec) {
        if (sandboxId !== "sbx_prev_1") {
          // A live (fresh) box: only the file seam is exercised.
          const override = opts.connectOverride?.(sandboxId)
          return {
            mcpUrl: `${gateway.url}/mcp`,
            sandboxId,
            async stop() {},
            ...(override ?? recordingSink(boxWrites)),
          }
        }
        const override = opts.connectOverride?.(sandboxId)
        return {
          mcpUrl: `${gateway.url}/mcp`,
          sandboxId,
          async stop() {
            await gateway.stop()
          },
          ...(override ?? recordingSink(boxWrites)),
        }
      },
    }
    return makeResolver({ provider })
  }

  it("re-attach: writes the full prior transcript into the box and injects the structured handoff", async () => {
    const { resolver, providerResolver } = await setup()

    const result = await restartAgentSession(registry, resolver, prev, {
      resolveSandboxProvider: providerResolver,
    })

    // 1. The full transcript file landed in the box — outside any repo
    //    checkout, so the delivery hook can never commit it.
    expect(boxWrites).toHaveLength(1)
    const write = boxWrites[0]!
    expect(write.path).toBe(`${BOX_DIR}/${prev.id}.md`)
    // Full fidelity: the 500-char tool result is present WHOLE (the file's
    // cap is 2000, not the old digest's 200).
    expect(write.text).toContain("R".repeat(500))
    expect(write.text).toContain("Build the restart-handoff feature end to end.")
    expect(write.text).not.toMatch(/chars truncated\]/)

    // 2. The injected first-turn context is the structured handoff.
    const injected = String(result.desc.pendingResumeContext)
    expect(injected).toMatch(/^\[restart handoff — the sandbox box/)
    expect(injected).toContain("## goal")
    expect(injected).toContain("Build the restart-handoff feature end to end.")
    expect(injected).toContain("## plan")
    expect(injected).toContain("write the handoff module")
    expect(injected).toContain("## Full prior transcript")
    expect(injected).toContain(`${BOX_DIR}/${prev.id}.md`)

    // 3. The restart result describes the handoff for CLI/VS Code.
    expect(result.resumeFallback).toBe(true)
    expect(result.digestRecovered).toBe(true)
    expect(result.handoff).toBeDefined()
    expect(result.handoff!.transcriptPath).toBe(`${BOX_DIR}/${prev.id}.md`)
    expect(result.handoff!.checkpointId).toMatch(/^ckpt_/)
    expect(result.handoff!.recentChars).toBeGreaterThan(0)
    expect(result.handoff!.totalMessages).toBeGreaterThan(0)
  })

  it("re-attach: walks the resumedFrom ancestor chain, capped at 5 hops", async () => {
    const { resolver, providerResolver } = await setup()
    // A restart lineage under prev: prev itself was a restart of `a1`, …
    const rows: SessionDescriptor[] = [prev]
    let parent = prev
    for (let i = 1; i <= 6; i++) {
      const row = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/home/user",
        agentSession: fakeAgentSession("chain"),
        adapterSlug: "fake-cli",
        commandPreview: "sandbox:fake → fake-cli",
        remote: true,
        sandboxId: `sbx_chain_${i}`,
        sandboxTeardown: "pause",
        resumedFrom: parent.id,
        resumeVia: "",
      })
      await writeEvents(sessionsBase, row.id, priorConversationEvents())
      registry.kill(row.id)
      rows.push(row)
      parent = row
    }
    // `parent` is now 6 restarts above prev (7 links total including prev).
    // Only prev + ANCESTOR_HOP_CAP ancestors may be written.
    const deep = parent

    const result = await restartAgentSession(registry, resolver, registry.get(deep.id)!, {
      resolveSandboxProvider: providerResolver,
    })

    const writtenPaths = boxWrites.map(w => w.path)
    expect(writtenPaths).toHaveLength(1 + ANCESTOR_HOP_CAP)
    expect(writtenPaths[0]).toBe(boxPriorSessionPath(deep.id))
    // The 5 closest ancestors are present …
    expect(writtenPaths).toContain(boxPriorSessionPath(rows[5]!.id))
    expect(writtenPaths).toContain(boxPriorSessionPath(rows[4]!.id))
    expect(writtenPaths).toContain(boxPriorSessionPath(rows[3]!.id))
    expect(writtenPaths).toContain(boxPriorSessionPath(rows[2]!.id))
    expect(writtenPaths).toContain(boxPriorSessionPath(rows[1]!.id))
    // … and the 6th hop (rows[0] === prev) is beyond the cap.
    expect(writtenPaths).not.toContain(boxPriorSessionPath(rows[0]!.id))
    // The primary file is the one the handoff points at.
    expect(result.handoff!.transcriptPath).toBe(boxPriorSessionPath(deep.id))
  })

  it("fresh box: writes the full prior transcript into the NEW box and injects the structured handoff", async () => {
    const target: SandboxDeliveryTarget = {
      checkoutDir: "/home/user/agentproto",
      branch: "wt/resume-me",
      baseSha: "c".repeat(40),
    }
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
    const { resolver } = await setup({
      deliveryTarget: target,
      workspaceSlug: "agentproto",
      connectOverride: sandboxId => {
        if (sandboxId === "sbx_prev_1") {
          // The OLD box is dead — exactly the fresh-box precondition.
          throw new SandboxBoxGoneError(sandboxId, new Error("Sandbox not found"))
        }
        return undefined // live fresh box → the recording seam
      },
    })
    const execCalls: SandboxExecOpts[] = []
    const boots = { count: 0 }
    const freshProvider: (slug: string) => Promise<SandboxProviderHandle | null> = async slug => {
      const handle = await makeResolver({ provider }).providerResolver(slug)
      if (!handle) return null
      return {
        ...handle,
        defaultCwd: "/home/user",
        provider: {
          async connect(sandboxId: string, spec: SandboxSpec) {
            const booted = await provider.connect!(sandboxId, spec, { env: {} })
            return {
              ...booted,
              async exec(o: SandboxExecOpts): Promise<SandboxExecResult> {
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
          async boot() {
            boots.count++
            return {
              mcpUrl: `${gateway.url}/mcp`,
              sandboxId: "sbx_fresh_2",
              async stop() {},
              ...recordingSink(boxWrites),
              async exec(o: SandboxExecOpts): Promise<SandboxExecResult> {
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

    const result = await restartAgentSession(registry, resolver, prev, {
      resolveSandboxProvider: freshProvider,
    })

    expect(boots.count).toBe(1)
    expect(result.desc.sandboxId).toBe("sbx_fresh_2")

    // The transcript was written into the FRESH box.
    expect(boxWrites).toHaveLength(1)
    expect(boxWrites[0]!.path).toBe(`${BOX_DIR}/${prev.id}.md`)
    expect(boxWrites[0]!.text).toContain("R".repeat(500))

    const injected = String(result.desc.pendingResumeContext)
    expect(injected).toMatch(/^\[restart handoff — the sandbox box/)
    expect(injected).toContain("was lost and this session was started on a fresh box")
    expect(injected).toContain("## goal")
    expect(injected).toContain(`${BOX_DIR}/${prev.id}.md`)
    expect(result.handoff!.transcriptPath).toBe(`${BOX_DIR}/${prev.id}.md`)
  })

  it("falls back to the old digest when the in-box write throws — the restart still succeeds", async () => {
    const { resolver, providerResolver } = await setup({
      connectOverride: () => ({
        async writeFile(): Promise<void> {
          throw new Error("box filesystem is read-only")
        },
      }),
    })

    const result = await restartAgentSession(registry, resolver, prev, {
      resolveSandboxProvider: providerResolver,
    })

    // The restart itself worked …
    expect(result.desc.remote).toBe(true)
    expect(result.resumeFallback).toBe(true)
    // … the structured handoff was skipped …
    expect(result.handoff).toBeUndefined()
    // … and the OLD digest is what got injected instead.
    const injected = String(result.desc.pendingResumeContext)
    expect(injected).toMatch(/^\[resumed session — prior conversation could not be natively restored/)
    expect(injected).toContain("Build the restart-handoff feature end to end.")
  })
})

describe("restart handoff — local blank-fallback", () => {
  it("writes the transcript next to the NEW session on the host and points at it", async () => {
    // No sandbox at all — a plain local fresh-spawn fallback (hermes with
    // no resume id, same harness as resume-context-injection.test.ts).
    const localBase = await mkdtemp(join(tmpdir(), "restart-handoff-local-"))
    const localSessions = join(localBase, "sessions")
    setDefaultSessionsBaseDir(localSessions)
    const localRegistry = createSessionsRegistry({ persist: false })
    try {
      const localResolver: AgentAdapterResolver = async slug => ({
        commandPreview: `mock-${slug}`,
        async startSession(sessOpts) {
          if (sessOpts.resumeSessionId) throw new Error("Resource not found")
          return fakeAgentSession(slug)
        },
      })
      const localPrev = localRegistry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        agentSession: fakeAgentSession("hermes"),
        adapterSlug: "hermes",
      })
      await writeEvents(localSessions, localPrev.id, priorConversationEvents())
      localRegistry.kill(localPrev.id)

      const result = await restartAgentSession(localRegistry, localResolver, localPrev, {})

      expect(result.resumeFallback).toBe(true)
      expect(result.handoff).toBeDefined()
      const transcriptPath = result.handoff!.transcriptPath
      expect(transcriptPath).toContain("prior-session.md")
      // The file is on the HOST, under the NEW session's own transcript dir.
      expect(transcriptPath.startsWith(join(localSessions, result.desc.id))).toBe(true)
      const written = await readFile(transcriptPath, "utf8")
      expect(written).toContain("R".repeat(500))
      expect(written).toContain("Build the restart-handoff feature end to end.")

      const injected = String(result.desc.pendingResumeContext)
      expect(injected).toMatch(/^\[restart handoff — the prior session/)
      expect(injected).toContain("## goal")
      expect(injected).toContain("## Full prior transcript")
      expect(injected).toContain(transcriptPath)
    } finally {
      localRegistry.shutdown()
      setDefaultSessionsBaseDir(undefined)
      await rm(localBase, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  })
})

// ── writeBoxPriorTranscripts in isolation (chain cap) ─────────────────

describe("writeBoxPriorTranscripts", () => {
  let sessionsBase: string
  let registry: SessionsRegistry

  afterEach(async () => {
    registry.shutdown()
    setDefaultSessionsBaseDir(undefined)
    await rm(sessionsBase, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it("stops the chain when an ancestor row is gone from the registry", async () => {
    sessionsBase = await mkdtemp(join(tmpdir(), "restart-handoff-chain-"))
    setDefaultSessionsBaseDir(sessionsBase)
    registry = createSessionsRegistry({ persist: false })
    const a = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession("a"),
      adapterSlug: "hermes",
    })
    await writeEvents(sessionsBase, a.id, priorConversationEvents())
    registry.kill(a.id)
    const b = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession("b"),
      adapterSlug: "hermes",
      resumedFrom: a.id,
      resumeVia: "",
    })
    await writeEvents(sessionsBase, b.id, priorConversationEvents())
    registry.kill(b.id)
    const c = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession("c"),
      adapterSlug: "hermes",
      resumedFrom: b.id,
      resumeVia: "",
    })
    await writeEvents(sessionsBase, c.id, priorConversationEvents())
    registry.kill(c.id)
    // d's parent chain names an id the registry never knew.
    const d = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession("d"),
      adapterSlug: "hermes",
      resumedFrom: "sess_never_existed",
      resumeVia: "",
    })
    await writeEvents(sessionsBase, d.id, priorConversationEvents())
    registry.kill(d.id)

    const writes: RecordedWrite[] = []
    const res = await writeBoxPriorTranscripts(recordingSink(writes), registry.get(d.id)!, registry)
    expect(res.ok).toBe(true)
    expect(res.paths).toEqual([boxPriorSessionPath(d.id)])
  })
})
