/**
 * Per-session skill delivery at the driver level: `runtime.start({configDir,
 * sessionSkills})` copies each skill into `<configDir>/<metadata.sessionSkills
 * .dir>/<alias>/`, wipes stale entries, and applies the manifest's
 * `metadata.sessionSkills.env` (with `<abs dir>` → the session config dir).
 * Spawns are mocked — this asserts the wiring in `define-agent-cli.ts`, not a
 * real CLI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"

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

vi.mock("node:child_process", async importOriginal => {
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
  })),
}))

const { defineAgentCli, createAgentCliRuntime } = await import("../define-agent-cli.js")
import { applySessionSkills } from "../session-skills.js"
import type { AgentCliDefinition, AgentCliSessionSkill } from "../types.js"

const opencodeLike = (metadata: Record<string, unknown>): AgentCliDefinition => ({
  name: "opencode",
  id: "opencode",
  description: "test double",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "opencode-ai", "acp"],
  install: [{ method: "npm", package: "opencode-ai" }],
  version_check: { cmd: "opencode --version", parse: "(\\d+)", range: ">=0.0.0" },
  auth: { ref: "./SECRETS.md", state: { env: ["OPENCODE_API_KEY"] } },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./opencode-acp.ACP.md",
  metadata,
})

const claudeLike = (metadata: Record<string, unknown>): AgentCliDefinition => ({
  ...opencodeLike(metadata),
  name: "claude-code",
  id: "claude-code",
})

function makeSkill(fsBase: string, name: string): string {
  const dir = join(fsBase, `src-${name}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n\nbody\n`)
  return dir
}

describe("session-skills delivery (define-agent-cli wiring)", () => {
  let base: string
  beforeEach(() => {
    spawnCalls.length = 0
    base = mkdtempSync(join(tmpdir(), "agent-cli-skills-"))
  })
  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it("opencode: copies skills + points OPENCODE_CONFIG_DIR at the session config dir", async () => {
    const configDir = join(base, "sess_oc")
    const src = makeSkill(base, "ap-x")
    const skills: AgentCliSessionSkill[] = [{ alias: "ap-x", path: src }]

    const runtime = createAgentCliRuntime(
      defineAgentCli(
        opencodeLike({
          sessionSkills: { dir: "skills", env: { OPENCODE_CONFIG_DIR: "<abs dir>" } },
        }),
      ),
    )
    await runtime.start({ cwd: "/scratch", configDir, sessionSkills: skills })

    expect(spawnCalls[0]!.env.OPENCODE_CONFIG_DIR).toBe(configDir)
    expect(readFileSync(join(configDir, "skills", "ap-x", "SKILL.md"), "utf8")).toContain("name: ap-x")
  })

  it("claude-code: copies skills into CLAUDE_CONFIG_DIR's skills/ with no env override, wiping stale entries", async () => {
    const configDir = join(base, "sess_cc")
    const src = makeSkill(base, "ap-y")
    mkdirSync(join(configDir, "skills", "old"), { recursive: true })
    writeFileSync(join(configDir, "skills", "old", "SKILL.md"), "stale")

    const runtime = createAgentCliRuntime(
      defineAgentCli(claudeLike({ sessionSkills: { dir: "skills" } })),
    )
    await runtime.start({
      cwd: "/scratch",
      configDir,
      sessionSkills: [{ alias: "ap-y", path: src }],
    })

    expect(spawnCalls[0]!.env.CLAUDE_CONFIG_DIR).toBe(configDir)
    expect(spawnCalls[0]!.env.OPENCODE_CONFIG_DIR).toBeUndefined()
    expect(existsSync(join(configDir, "skills", "old"))).toBe(false)
    expect(readFileSync(join(configDir, "skills", "ap-y", "SKILL.md"), "utf8")).toContain("name: ap-y")
  })

  it("an adapter with no metadata.sessionSkills gets no delivery", async () => {
    const configDir = join(base, "sess_none")
    const src = makeSkill(base, "ap-z")
    const runtime = createAgentCliRuntime(defineAgentCli(opencodeLike({})))
    await runtime.start({ cwd: "/scratch", configDir, sessionSkills: [{ alias: "ap-z", path: src }] })
    expect(existsSync(join(configDir, "skills"))).toBe(false)
  })

  it("applySessionSkills skips an alias that escapes the target dir with a warning", () => {
    const configDir = join(base, "sess_evil")
    const src = makeSkill(base, "ap-ev")
    const result = applySessionSkills({
      skills: [{ alias: "../evil", path: src }],
      meta: { dir: "skills" },
      baseDir: configDir,
      env: {},
    })
    expect(result.warnings.some(w => w.includes("invalid alias"))).toBe(true)
    expect(existsSync(join(base, "evil"))).toBe(false)
  })

  it("delivers the good skills and warns on a broken one instead of throwing", () => {
    const configDir = join(base, "sess_mixed")
    const good = makeSkill(base, "ap-good")
    const result = applySessionSkills({
      skills: [
        { alias: "ap-good", path: good },
        { alias: "ap-bad", path: join(base, "no-such-skill") },
      ],
      meta: { dir: "skills" },
      baseDir: configDir,
      env: {},
    })
    expect(result.warnings.some(w => w.includes("ap-bad"))).toBe(true)
    expect(readFileSync(join(configDir, "skills", "ap-good", "SKILL.md"), "utf8")).toContain(
      "name: ap-good"
    )
  })
})
