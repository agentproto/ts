import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"

/**
 * opencode posture enforcement (`opencode-permission.ts`): a canonical posture
 * with no advertised opencode ACP mode (`bypass`, `accept-edits`, `read-only`)
 * must reach the spawn as a real `permission` block in the session's own
 * OPENCODE_CONFIG_CONTENT — not just the runtime's advisory preamble. Plus a
 * regression guard that the claude-code `CLAUDE_CONFIG_DIR` path is unchanged.
 *
 * No real CLI is spawned — these pin the spawn-time env only.
 */

const spawnCalls: Array<{ bin: string; args: string[]; env: Record<string, string> }> = []

function fakeChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(),
  }) as unknown as ChildProcess
  queueMicrotask(() => child.emit("spawn"))
  return child
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    spawn: vi.fn((bin: string, args: string[], opts: { env: Record<string, string> }) => {
      spawnCalls.push({ bin, args, env: opts.env })
      return fakeChild()
    }),
  }
})

vi.mock("@agentproto/acp/client", () => ({
  createAcpClient: vi.fn(async () => ({
    agentCapabilities: {},
    async newSession() {
      return { sessionId: "sess-1" }
    },
    async loadSession(params: { sessionId: string }) {
      return { sessionId: params.sessionId }
    },
  })),
}))

const { defineHarness, createAgentCliRuntime, spawnEnforcedPostures } = await import(
  "../define-agent-cli.js"
)
const { opencodePermissionForPosture, mergeOpencodePermission } = await import(
  "../opencode-permission.js"
)
import type { AgentCliDefinition } from "../types.js"

const opencodeLike = (): AgentCliDefinition => ({
  name: "opencode",
  id: "opencode",
  description: "test double",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "opencode-ai", "acp"],
  install: [{ method: "npm", package: "opencode-ai" }],
  version_check: { cmd: "opencode --version", parse: "(\\d+)", range: ">=0.0.0" },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./opencode-acp.ACP.md",
  systemPrompt: {
    via: "inline-config",
    env: "OPENCODE_CONFIG_CONTENT",
    key: "instructions",
    shape: "file-list",
  },
  modes: [
    {
      id: "lean",
      kind: "context",
      description: "Lean context.",
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { agentproto: { enabled: false } } }) },
    },
  ],
})

const claudeCodeLike = (): AgentCliDefinition => ({
  ...opencodeLike(),
  name: "claude-code",
  id: "claude-code",
  bin_args: ["-y", "@agentclientprotocol/claude-agent-acp"],
  systemPrompt: undefined,
  modes: [],
})

const inlineConfig = (call = 0): Record<string, unknown> =>
  JSON.parse(spawnCalls[call]!.env.OPENCODE_CONFIG_CONTENT ?? "{}") as Record<string, unknown>

describe("opencodePermissionForPosture", () => {
  it("bypass allows everything: wildcard first, then every well-known key", () => {
    const block = opencodePermissionForPosture("bypass")!
    const keys = Object.keys(block)
    expect(keys[0]).toBe("*")
    for (const key of ["edit", "bash", "external_directory", "doom_loop", "read", "webfetch"]) {
      expect(block[key]).toBe("allow")
    }
    expect(new Set(Object.values(block))).toEqual(new Set(["allow"]))
  })

  it("accept-edits allows edits only", () => {
    expect(opencodePermissionForPosture("accept-edits")).toEqual({ edit: "allow" })
  })

  it("read-only denies edits and shell", () => {
    expect(opencodePermissionForPosture("read-only")).toEqual({ edit: "deny", bash: "deny" })
  })

  it("has no config mapping for default, plan (native opencode agent), unknown, or absent", () => {
    expect(opencodePermissionForPosture("default")).toBeUndefined()
    expect(opencodePermissionForPosture("plan")).toBeUndefined()
    expect(opencodePermissionForPosture("architect")).toBeUndefined()
    expect(opencodePermissionForPosture(undefined)).toBeUndefined()
  })
})

describe("mergeOpencodePermission", () => {
  it("creates the inline config when absent", () => {
    expect(JSON.parse(mergeOpencodePermission(undefined, { edit: "allow" }, "X"))).toEqual({
      permission: { edit: "allow" },
    })
  })

  it("keeps other inline keys and moves posture keys last in an existing permission object", () => {
    const prior = JSON.stringify({
      small_model: "a/b",
      permission: { edit: "ask", webfetch: "deny" },
    })
    const out = JSON.parse(mergeOpencodePermission(prior, { edit: "allow" }, "X"))
    expect(out.small_model).toBe("a/b")
    expect(out.permission).toEqual({ webfetch: "deny", edit: "allow" })
    expect(Object.keys(out.permission)).toEqual(["webfetch", "edit"])
  })

  it("expands an existing string permission to a wildcard before layering", () => {
    const out = JSON.parse(
      mergeOpencodePermission(JSON.stringify({ permission: "ask" }), { bash: "deny" }, "X"),
    )
    expect(out.permission).toEqual({ "*": "ask", bash: "deny" })
  })

  it("refuses loudly on a non-object inline config instead of dropping the boundary", () => {
    expect(() => mergeOpencodePermission("{not json", { edit: "allow" }, "OPENCODE_CONFIG_CONTENT")).toThrow(
      /OPENCODE_CONFIG_CONTENT is not a JSON object/,
    )
    expect(() => mergeOpencodePermission("[]", { edit: "allow" }, "X")).toThrow(/not a JSON object/)
  })
})

describe("opencode spawn: posture → OPENCODE_CONFIG_CONTENT permission", () => {
  let prevInline: string | undefined
  let prevClaudeConfigDir: string | undefined
  let baseDir: string
  beforeEach(() => {
    spawnCalls.length = 0
    // The child env spreads process.env — neutralise ambient values so the
    // assertions read the override, not the runner's shell.
    prevInline = process.env.OPENCODE_CONFIG_CONTENT
    delete process.env.OPENCODE_CONFIG_CONTENT
    prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    baseDir = mkdtempSync(join(tmpdir(), "agentproto-opencode-posture-test-"))
  })
  afterEach(() => {
    if (prevInline === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
    else process.env.OPENCODE_CONFIG_CONTENT = prevInline
    if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir
    rmSync(baseDir, { recursive: true, force: true })
  })

  it("bypass writes an allow-everything permission block", async () => {
    const runtime = createAgentCliRuntime(defineHarness(opencodeLike()))
    await runtime.start({ cwd: "/scratch", posture: "bypass" })

    expect(inlineConfig().permission).toEqual(opencodePermissionForPosture("bypass"))
  })

  it("layers over the lean context profile and the system-prompt instructions without clobbering either", async () => {
    const configDir = join(baseDir, "sess_1")
    const runtime = createAgentCliRuntime(defineHarness(opencodeLike()))
    await runtime.start({
      cwd: "/scratch",
      configDir,
      posture: "read-only",
      contextProfile: "lean",
      appendSystemPrompt: "be careful",
    })

    const inline = inlineConfig()
    expect(inline.permission).toEqual({ edit: "deny", bash: "deny" })
    expect(inline.mcp).toEqual({ agentproto: { enabled: false } })
    const instructions = inline.instructions as string[]
    expect(instructions).toHaveLength(1)
    expect(readFileSync(instructions[0]!, "utf8")).toBe("be careful")
  })

  it("accept-edits writes edit:allow", async () => {
    const runtime = createAgentCliRuntime(defineHarness(opencodeLike()))
    await runtime.start({ cwd: "/scratch", posture: "accept-edits" })
    expect(inlineConfig().permission).toEqual({ edit: "allow" })
  })

  it("leaves the inline config untouched for no posture, default, and plan", async () => {
    const runtime = createAgentCliRuntime(defineHarness(opencodeLike()))
    await runtime.start({ cwd: "/scratch" })
    await runtime.start({ cwd: "/scratch", posture: "default" })
    await runtime.start({ cwd: "/scratch", posture: "plan" })
    for (const call of spawnCalls) expect(call.env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })

  it("does not apply to an adapter with another id, even with the same inline-config channel", async () => {
    const runtime = createAgentCliRuntime(
      defineHarness({ ...opencodeLike(), id: "mastracode", name: "mastracode" }),
    )
    await runtime.start({ cwd: "/scratch", posture: "bypass" })
    expect(spawnCalls[0]!.env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })

  describe("claude-code regression: its posture path is unchanged", () => {
    it("bypass still lands as permissions.defaultMode in the isolated settings.json, with no opencode block", async () => {
      const runtime = createAgentCliRuntime(defineHarness(claudeCodeLike()))
      await runtime.start({ cwd: "/scratch", posture: "bypass" })

      const configDir = spawnCalls[0]!.env.CLAUDE_CONFIG_DIR!
      expect(JSON.parse(readFileSync(`${configDir}/settings.json`, "utf8"))).toEqual({
        attribution: { commit: "", pr: "", sessionUrl: false },
        permissions: { defaultMode: "bypassPermissions" },
      })
      expect(spawnCalls[0]!.env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
    })

    it("read-only still maps to claude-code's plan mode", async () => {
      const runtime = createAgentCliRuntime(defineHarness(claudeCodeLike()))
      await runtime.start({ cwd: "/scratch", posture: "read-only" })

      const configDir = spawnCalls[0]!.env.CLAUDE_CONFIG_DIR!
      expect(JSON.parse(readFileSync(`${configDir}/settings.json`, "utf8")).permissions).toEqual({
        defaultMode: "plan",
      })
    })
  })
})

describe("spawnEnforcedPostures (enforced-vs-advisory read surface)", () => {
  it("names the postures each adapter enforces through its isolated config", () => {
    expect([...spawnEnforcedPostures({ id: "opencode" })].sort()).toEqual(
      ["accept-edits", "bypass", "read-only"],
    )
    expect([...spawnEnforcedPostures({ id: "claude-code" })].sort()).toEqual(
      ["accept-edits", "bypass", "plan", "read-only"],
    )
    expect(spawnEnforcedPostures({ id: "codex" })).toEqual([])
  })

  it("stamps the list on a started opencode session and omits it for an adapter with none", async () => {
    spawnCalls.length = 0
    const oc = await createAgentCliRuntime(defineHarness(opencodeLike())).start({ cwd: "/scratch" })
    expect(oc.spawnEnforcedPostures).toEqual(spawnEnforcedPostures({ id: "opencode" }))

    const other = await createAgentCliRuntime(
      defineHarness({ ...opencodeLike(), id: "mastracode", name: "mastracode" }),
    ).start({ cwd: "/scratch" })
    expect(other.spawnEnforcedPostures).toBeUndefined()
  })
})
