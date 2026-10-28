/**
 * Opt-in live proof of the claude-code native-dir projection (E62 runs 1
 * and 8): a projected index line is read by the real CLI through
 * `autoMemoryDirectory`. Skipped unless AGENTPROTO_LIVE_NATIVE_MEMORY=1 and
 * a credential is already in the environment (never read from disk here).
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { projectNativeMemory } from "../native-memory.js"

const live =
  process.env.AGENTPROTO_LIVE_NATIVE_MEMORY === "1" &&
  !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY)

describe.skipIf(!live)("claude-code native memory (live)", () => {
  it("reads a fact from the projected MEMORY.md block", () => {
    const cfg = mkdtempSync(join(tmpdir(), "nm-live-"))
    try {
      const dir = join(cfg, "memory")
      writeFileSync(join(cfg, "settings.json"), JSON.stringify({ autoMemoryDirectory: dir }))
      writeFileSync(join(cfg, ".claude.json"), JSON.stringify({ mcpServers: {} }))
      projectNativeMemory(dir, [
        {
          schema: "memory/v1",
          id: "mem-codeword",
          slug: "deploy-codeword",
          kind: "project",
          type: "project",
          title: "Deploy codeword",
          description: "The deploy codeword is PURPLE-HERON-42",
          updated_at: "2026-10-28T00:00:00.000Z",
          body: "The deploy codeword is PURPLE-HERON-42.\n",
        },
      ])
      const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: cfg }
      delete env.CLAUDECODE
      const out = spawnSync("claude", ["-p", "--tools", "", "What is the deploy codeword? Answer with it only, or UNKNOWN."], {
        env,
        cwd: cfg,
        encoding: "utf8",
        timeout: 120_000,
      })
      expect(out.stdout).toContain("PURPLE-HERON-42")
    } finally {
      rmSync(cfg, { recursive: true, force: true })
    }
  }, 150_000)
})
