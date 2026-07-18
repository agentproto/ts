/**
 * Integration tests for `agentproto conversation locate` — spawns the BUILT
 * CLI (`packages/cli/dist/cli.mjs`, requires a prior `pnpm build`) against a
 * throwaway `HOME` seeded with a fixture `conversations.jsonl`. No daemon
 * needed: the verb is a pure local-filesystem read, same as
 * `agentproto worktree ls`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const REPO_ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dir
})()

function runCli(
  args: string[],
  home: string,
): { stdout: string; stderr: string; code: number | null } {
  const cliEntry = join(REPO_ROOT, "packages/cli/dist/cli.mjs")
  const result = spawnSync("node", [cliEntry, "conversation", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home },
    timeout: 15_000,
  })
  return {
    stdout: result.stdout?.toString("utf8") ?? "",
    stderr: result.stderr?.toString("utf8") ?? "",
    code: result.status,
  }
}

describe("agentproto conversation locate (real CLI, fake HOME)", () => {
  let home: string
  let record: Record<string, unknown>

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentproto-conv-locate-"))
    const bucketDir = join(home, ".agentproto", "workspaces", "default")
    mkdirSync(bucketDir, { recursive: true })
    record = {
      sessionId: "sess_locate1",
      workspace: "default",
      cwd: "/tmp/proj",
      adapterSlug: "claude-code",
      adapterSessionId: "11111111-0000-0000-0000-000000000001",
      native: {
        kind: "claude-jsonl",
        path: join(home, ".claude", "projects", "-tmp-proj", "11111111.jsonl"),
        subagents: [],
      },
      agentprotoTranscript: join(home, ".agentproto", "sessions", "sess_locate1", "events.jsonl"),
      startedAt: "2026-07-18T10:00:00.000Z",
    }
    writeFileSync(join(bucketDir, "conversations.jsonl"), JSON.stringify(record) + "\n")
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it("forward: locates by sessionId", () => {
    const { stdout, code } = runCli(["locate", "sess_locate1"], home)
    expect(code).toBe(0)
    expect(stdout).toContain("Session:    sess_locate1")
    expect(stdout).toContain("Workspace:  default")
    expect(stdout).toContain("claude-jsonl")
  })

  it("forward --json: emits the full record", () => {
    const { stdout, code } = runCli(["locate", "sess_locate1", "--json"], home)
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout) as { workspace: string; matchedBy: string; record: { sessionId: string } }
    expect(parsed.workspace).toBe("default")
    expect(parsed.matchedBy).toBe("sessionId")
    expect(parsed.record.sessionId).toBe("sess_locate1")
  })

  it("reverse: locates by native jsonl path", () => {
    const nativePath = (record.native as { path: string }).path
    const { stdout, code } = runCli(["locate", nativePath], home)
    expect(code).toBe(0)
    expect(stdout).toContain("Session:    sess_locate1")
  })

  it("unknown id/path: exits 1 with a clear message, tried both directions", () => {
    const { stderr, code } = runCli(["locate", "sess_totally_unknown"], home)
    expect(code).toBe(1)
    expect(stderr).toMatch(/no record for/)
    expect(stderr).toMatch(/sessionId.*native jsonl path/)
  })

  it("missing argument: exits 2 with usage", () => {
    const { stderr, code } = runCli(["locate"], home)
    expect(code).toBe(2)
    expect(stderr).toMatch(/missing/)
  })
})
