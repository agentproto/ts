/**
 * App boundary (L5): fs zones for sessions an app / app workflow spawns.
 *
 * Exercises, in-process and without a daemon:
 *   - `resolveBoundaryPath` (zone semantics, relative anchor, symlinks),
 *   - the daemon file tools under a boundary (write under the app dir denied,
 *     run workspace / data dir writable, relative reads anchor at the app root),
 *   - `SessionsRegistryAgentHost` spawning a boundaried step session (zones +
 *     context isolation handed to the harness, boundary stamped on the
 *     descriptor, warning / refusal when it cannot be enforced),
 *   - a real OS-sandbox write attempt against the zones the host handed over.
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { resolveCommandSandbox } from "@agentproto/command-sandbox"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  boundaryFromMeta,
  boundaryMeta,
  boundaryRestartOptions,
  buildAppBoundary,
  FsZoneError,
  resolveBoundaryPath,
  type AppBoundary,
} from "../app-boundary.js"
import { registerFsTools } from "../fs-tools.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { SessionsRegistryAgentHost } from "../sessions-registry-agent-host.js"

let base: string
let daemonWorkspace: string
let appDir: string
let dataDir: string
let runWorkspace: string

beforeEach(() => {
  // Under the REAL home (the vitest setup fakes $HOME into the OS temp dir,
  // which the sandbox treats as writable scratch).
  base = mkdtempSync(join(userInfo().homedir, ".agentproto-appboundary-"))
  daemonWorkspace = join(base, "daemon-ws")
  appDir = join(base, "apps", "yt")
  dataDir = join(appDir, "data")
  runWorkspace = join(base, "runs", "wfrun_1")
  mkdirSync(join(daemonWorkspace, ".agentproto"), { recursive: true })
  mkdirSync(join(appDir, "scripts"), { recursive: true })
  writeFileSync(join(daemonWorkspace, ".agentproto", "allowed-commands.json"), '{"secret":"daemon"}')
  writeFileSync(join(daemonWorkspace, "CLAUDE.md"), "host instructions")
  writeFileSync(join(appDir, "scripts", "dedup_vtt.py"), "original")
  writeFileSync(join(appDir, "README.md"), "app readme")
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

function makeBoundary(over: { enforce?: "required" | "best-effort" } = {}): AppBoundary {
  return buildAppBoundary({
    app: {
      appId: "@test/yt",
      dir: appDir,
      dataDir,
      ...(over.enforce ? { boundaries: { enforce: over.enforce } } : {}),
    },
    runWorkspace,
    daemonWorkspace,
  })
}

describe("resolveBoundaryPath", () => {
  it("anchors relative paths at the app root, not the daemon workspace", () => {
    const b = makeBoundary()
    expect(resolveBoundaryPath(b, "README.md", "read")).toBe(join(appDir, "README.md"))
    expect(resolveBoundaryPath(b, "scripts/dedup_vtt.py", "read")).toBe(join(appDir, "scripts", "dedup_vtt.py"))
  })

  it("makes the app source read-only and the run workspace + data dir writable", () => {
    const b = makeBoundary()
    expect(() => resolveBoundaryPath(b, "scripts/dedup_vtt.py", "write")).toThrow(/read-only/)
    expect(() => resolveBoundaryPath(b, join(appDir, ".agentproto", "x"), "write")).toThrow(FsZoneError)
    expect(resolveBoundaryPath(b, join(runWorkspace, "out.txt"), "write")).toBe(join(runWorkspace, "out.txt"))
    expect(resolveBoundaryPath(b, "data/cache.json", "write")).toBe(join(dataDir, "cache.json"))
  })

  it("denies everything else, including the daemon workspace and `..` escapes", () => {
    const b = makeBoundary()
    const secret = join(daemonWorkspace, ".agentproto", "allowed-commands.json")
    expect(() => resolveBoundaryPath(b, secret, "read")).toThrow(/outside the app boundary/)
    expect(() => resolveBoundaryPath(b, "../../daemon-ws/CLAUDE.md", "read")).toThrow(/outside the app boundary/)
    expect(() => resolveBoundaryPath(b, "/etc/passwd", "write")).toThrow(/outside the app boundary/)
  })

  it("resolves symlinks before the zone check (no writing through a link into app source)", () => {
    const b = makeBoundary()
    mkdirSync(runWorkspace, { recursive: true })
    symlinkSync(join(appDir, "scripts"), join(runWorkspace, "link"))
    expect(() => resolveBoundaryPath(b, join(runWorkspace, "link", "dedup_vtt.py"), "write")).toThrow(/read-only/)
    // A link inside a writable zone pointing at the daemon workspace is not readable either.
    symlinkSync(daemonWorkspace, join(runWorkspace, "host"))
    expect(() => resolveBoundaryPath(b, join(runWorkspace, "host", "CLAUDE.md"), "read")).toThrow(/outside/)
  })

  it("round-trips through descriptor meta and rejects malformed meta", () => {
    const b = makeBoundary({ enforce: "required" })
    expect(boundaryFromMeta(boundaryMeta(b))).toEqual(b)
    expect(boundaryFromMeta(undefined)).toBeUndefined()
    expect(boundaryFromMeta({ appBoundary: "{nope" })).toBeUndefined()
    expect(boundaryFromMeta({ appBoundary: JSON.stringify({ appId: "x" }) })).toBeUndefined()
  })

  it("hides the daemon workspace but never hides the app from itself", () => {
    const b = makeBoundary()
    expect(b.hidden).toContain(daemonWorkspace)
    const inside = buildAppBoundary({ app: { appId: "a", dir: appDir }, daemonWorkspace: join(appDir, "data") })
    expect(inside.hidden).not.toContain(join(appDir, "data"))
  })
})

describe("boundaryRestartOptions", () => {
  it("re-applies zones + context isolation when the harness supports them", () => {
    const b = makeBoundary()
    const opts = boundaryRestartOptions(b, { supportsFsZones: true, supportsHostContextIsolation: true })
    if (resolveCommandSandbox() !== null) {
      expect(opts.fsZones?.writable).toEqual(b.writable)
    }
    expect(opts.isolateHostContext).toBe(true)
  })

  it("refuses a restart that can no longer be enforced when the app requires it", () => {
    const b = makeBoundary({ enforce: "required" })
    expect(() => boundaryRestartOptions(b, { supportsFsZones: false })).toThrow(/app_boundary_unenforceable/)
    expect(boundaryRestartOptions(makeBoundary(), { supportsFsZones: false })).toEqual({})
  })
})

// ── daemon file tools under a boundary ──────────────────────────────────

async function fsClient(boundary: AppBoundary) {
  const server = new McpServer({ name: "test-fs", version: "0.0.1" })
  registerFsTools(server, { workspace: daemonWorkspace, boundary })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(clientTransport)
  return client
}

const textOf = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]!.text

describe("daemon file tools under a boundary", () => {
  it("relative file_read resolves against the app root, not the daemon workspace", async () => {
    const client = await fsClient(makeBoundary())
    const r = await client.callTool({ name: "file_read", arguments: { path: "README.md" } })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toBe("app readme")
    // The daemon workspace's own file is unreachable by the same relative name.
    const miss = await client.callTool({ name: "file_read", arguments: { path: "CLAUDE.md" } })
    expect(miss.isError).toBe(true)
  })

  it("cannot read daemon-workspace files by absolute path or `..`", async () => {
    const client = await fsClient(makeBoundary())
    const abs = await client.callTool({
      name: "file_read",
      arguments: { path: join(daemonWorkspace, ".agentproto", "allowed-commands.json") },
    })
    expect(abs.isError).toBe(true)
    expect(textOf(abs)).toMatch(/outside the app boundary/)
    const dots = await client.callTool({ name: "file_read", arguments: { path: "../../daemon-ws/CLAUDE.md" } })
    expect(dots.isError).toBe(true)
  })

  it("cannot rewrite, create, or delete under the app dir", async () => {
    const client = await fsClient(makeBoundary())
    const script = join(appDir, "scripts", "dedup_vtt.py")
    for (const [name, args] of [
      ["file_write", { path: "scripts/dedup_vtt.py", content: "pwned" }],
      ["file_write", { path: script, content: "pwned" }],
      ["file_write", { path: "new.txt", content: "x" }],
      ["directory_create", { path: "newdir" }],
      ["file_delete", { path: "scripts/dedup_vtt.py" }],
    ] as const) {
      const r = await client.callTool({ name, arguments: args })
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true)
      expect(textOf(r)).toMatch(/read-only/)
    }
    expect(readFileSync(script, "utf8")).toBe("original")
    expect(existsSync(join(appDir, "new.txt"))).toBe(false)
  })

  it("can write to the run workspace and the app data dir", async () => {
    const client = await fsClient(makeBoundary())
    const a = await client.callTool({
      name: "file_write",
      arguments: { path: join(runWorkspace, "out", "vtt.txt"), content: "ok" },
    })
    expect(a.isError).toBeFalsy()
    expect(readFileSync(join(runWorkspace, "out", "vtt.txt"), "utf8")).toBe("ok")
    const d = await client.callTool({ name: "file_write", arguments: { path: "data/cache.json", content: "{}" } })
    expect(d.isError).toBeFalsy()
    expect(readFileSync(join(dataDir, "cache.json"), "utf8")).toBe("{}")
    const list = await client.callTool({ name: "directory_list", arguments: { path: "scripts" } })
    expect(textOf(list)).toContain("dedup_vtt.py")
  })
})

// ── host-spawned app-workflow step session ──────────────────────────────

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function hostFixture(caps: { supportsFsZones?: boolean; supportsHostContextIsolation?: boolean }, boundary: AppBoundary) {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const startSession = vi.fn(async (_opts: Record<string, unknown>) => fakeAgentSession())
  const resolveAgentAdapter: AgentAdapterResolver = vi.fn(async () => ({
    startSession,
    commandPreview: "mock-adapter",
    ...caps,
  }))
  const events: SessionEvent[] = []
  sessionEvents.onAny(ev => events.push(ev))
  const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter, {
    cwd: appDir,
    run: { runId: "wfrun_1", workflowId: "transcribe" },
    boundary,
  })
  return { host, registry, startSession, events }
}

const warningsOf = (events: SessionEvent[]): string[] =>
  events.flatMap(e => (e.type === "session:harness-warning" ? e.warnings : []))

// The sandbox backend must exist AND be usable from this (possibly already
// confined) process — probed by really running a trivial wrapped command.
function probeSandbox(): { ok: boolean; reason: string } {
  const sb = resolveCommandSandbox()
  if (!sb) return { ok: false, reason: `no OS sandbox backend on ${process.platform} (needs Seatbelt or bubblewrap)` }
  try {
    const argv = sb.wrap(["/usr/bin/true"], { workspace: tmpdir(), extraReadPaths: [], network: "allow" })
    execFileSync(argv[0]!, argv.slice(1), { stdio: "pipe" })
    return { ok: true, reason: "" }
  } catch (err) {
    return { ok: false, reason: `OS sandbox present but not runnable here: ${(err as Error).message.split("\n")[0]}` }
  }
}
const sandboxProbe = probeSandbox()
const canRunSandbox = sandboxProbe.ok && process.platform === "darwin"
if (!canRunSandbox) {
  console.warn(`[skip] native-write sandbox e2e: ${sandboxProbe.reason || "e2e implemented for Seatbelt only"}`)
}

describe("app-workflow step session (SessionsRegistryAgentHost + boundary)", () => {
  it("hands the harness fs zones + context isolation and stamps the boundary on the descriptor", async () => {
    const boundary = makeBoundary()
    const { host, registry, startSession, events } = hostFixture(
      { supportsFsZones: true, supportsHostContextIsolation: true },
      boundary,
    )
    const id = await host.spawn("mock", { stepId: "extract" })
    const args = startSession.mock.calls[0]![0] as {
      cwd: string
      fsZones?: { readOnly: string[]; writable: string[]; hidden: string[] }
      isolateHostContext?: boolean
    }
    expect(args.cwd).toBe(appDir)
    expect(args.isolateHostContext).toBe(true)
    if (resolveCommandSandbox() !== null) {
      expect(args.fsZones?.readOnly).toEqual([appDir])
      expect(args.fsZones?.writable).toEqual([dataDir, runWorkspace])
      expect(args.fsZones?.hidden).toContain(daemonWorkspace)
      expect(warningsOf(events)).toEqual([])
    }
    // The gateway recovers the caller's boundary from this meta.
    expect(boundaryFromMeta(registry.get(id)?.meta)).toEqual(boundary)
    expect(registry.get(id)?.meta?.workflowRunId).toBe("wfrun_1")
  })

  it("warns explicitly (never silently) when the harness cannot enforce the zones or isolate context", async () => {
    const { host, startSession, events } = hostFixture({}, makeBoundary())
    await host.spawn("mock", { stepId: "extract" })
    const args = startSession.mock.calls[0]![0] as Record<string, unknown>
    expect(args.fsZones).toBeUndefined()
    expect(args.isolateHostContext).toBeUndefined()
    const w = warningsOf(events).join("\n")
    expect(w).toMatch(/NOT enforced on this session's native tools/)
    expect(w).toMatch(/cannot exclude the host repository's CLAUDE\.md\/AGENTS\.md/)
  })

  it('refuses the spawn when the app declares boundaries.enforce "required" and the harness cannot enforce', async () => {
    const { host, startSession } = hostFixture({}, makeBoundary({ enforce: "required" }))
    await expect(host.spawn("mock", { stepId: "extract" })).rejects.toThrow(/app_boundary_unenforceable/)
    expect(startSession).not.toHaveBeenCalled()
  })

  it("refuses a cwd outside the boundary and sandbox (remote box) spawns", async () => {
    const { host, startSession } = hostFixture({ supportsFsZones: true }, makeBoundary())
    await expect(host.spawn("mock", { stepId: "a", cwd: daemonWorkspace })).rejects.toThrow(/app_boundary_cwd_outside/)
    await expect(host.spawn("mock", { stepId: "b", sandbox: "some-provider" })).rejects.toThrow(/app_boundary_sandbox/)
    expect(startSession).not.toHaveBeenCalled()
  })

  it("stamps nothing and changes nothing when the run has no boundary", async () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const startSession = vi.fn(async (_o: Record<string, unknown>) => fakeAgentSession())
    const resolve: AgentAdapterResolver = vi.fn(async () => ({ startSession, commandPreview: "m" }))
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolve, { cwd: appDir })
    const id = await host.spawn("mock", { stepId: "x" })
    expect(registry.get(id)?.meta?.appBoundary).toBeUndefined()
    expect(startSession.mock.calls[0]![0]).not.toHaveProperty("fsZones")
  })

  it("the recorded boundary confines the session's daemon file tools end to end", async () => {
    const { host, registry } = hostFixture({ supportsFsZones: true, supportsHostContextIsolation: true }, makeBoundary())
    const id = await host.spawn("mock", { stepId: "extract" })
    const recovered = boundaryFromMeta(registry.get(id)?.meta)!
    const client = await fsClient(recovered)
    const denied = await client.callTool({
      name: "file_write",
      arguments: { path: "scripts/dedup_vtt.py", content: "rewritten" },
    })
    expect(denied.isError).toBe(true)
    const allowed = await client.callTool({
      name: "file_write",
      arguments: { path: join(runWorkspace, "notes.txt"), content: "ok" },
    })
    expect(allowed.isError).toBeFalsy()
    expect(readFileSync(join(appDir, "scripts", "dedup_vtt.py"), "utf8")).toBe("original")
  })

  it.skipIf(!canRunSandbox)(
    "a NATIVE write under the app dir is denied by the OS sandbox built from the zones the host handed over; the run workspace stays writable",
    async () => {
      const { host, startSession } = hostFixture(
        { supportsFsZones: true, supportsHostContextIsolation: true },
        makeBoundary(),
      )
      await host.spawn("mock", { stepId: "extract" })
      const zones = (startSession.mock.calls[0]![0] as { fsZones: { readOnly: string[]; writable: string[]; hidden: string[] } })
        .fsZones
      expect(zones).toBeDefined()
      const sb = resolveCommandSandbox()!
      const run = (...argv: string[]): boolean => {
        const wrapped = sb.wrap(argv, { workspace: appDir, extraReadPaths: [], zones, network: "allow" })
        try {
          execFileSync(wrapped[0]!, wrapped.slice(1), { stdio: "pipe" })
          return true
        } catch {
          return false
        }
      }
      const script = join(appDir, "scripts", "dedup_vtt.py")
      expect(run("/bin/cat", script)).toBe(true)
      expect(run("/bin/sh", "-c", `echo pwned > '${script}'`)).toBe(false)
      expect(run("/usr/bin/touch", join(appDir, "new.txt"))).toBe(false)
      expect(run("/bin/rm", script)).toBe(false)
      expect(readFileSync(script, "utf8")).toBe("original")
      expect(run("/usr/bin/touch", join(runWorkspace, "out.txt"))).toBe(true)
      expect(existsSync(join(runWorkspace, "out.txt"))).toBe(true)
      // The daemon workspace is hidden from the native tools too.
      expect(run("/bin/cat", join(daemonWorkspace, ".agentproto", "allowed-commands.json"))).toBe(false)
    },
  )
})
