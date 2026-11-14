/**
 * Per-session skill delivery for claude-code: the manifest declares
 * `metadata.sessionSkills { dir: "skills" }` (no env — CLAUDE_CONFIG_DIR is
 * already the session dir), and the driver's `applySessionSkills` copies each
 * resolved skill into `<configDir>/skills/<alias>/`, wiping stale entries.
 */

import { describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applySessionSkills, readSessionSkillsMetadata } from "@agentproto/harness"
import { claudeCode } from "../index.js"

describe("claude-code session-skills metadata", () => {
  it("declares { dir: 'skills' } with no env override", () => {
    expect(claudeCode.metadata?.sessionSkills).toEqual({ dir: "skills" })
    expect(readSessionSkillsMetadata(claudeCode.metadata)).toEqual({ dir: "skills" })
  })
})

describe("claude-code session-skills delivery", () => {
  it("writes <configDir>/skills/<alias>/ and wipes stale entries", async () => {
    const base = await mkdtemp(join(tmpdir(), "cc-skills-base-"))
    const src = await mkdtemp(join(tmpdir(), "cc-skills-src-"))
    try {
      await writeFile(
        join(src, "SKILL.md"),
        "---\nname: ap-x\ndescription: d\n---\n\nbody\n",
      )
      await mkdir(join(src, "scripts"), { recursive: true })
      await writeFile(join(src, "scripts", "run.sh"), "echo hi\n")
      // A stale entry from a previous spawn must not survive.
      await mkdir(join(base, "skills", "old-skill"), { recursive: true })
      await writeFile(join(base, "skills", "old-skill", "SKILL.md"), "stale")

      const env: Record<string, string> = {}
      const meta = readSessionSkillsMetadata(claudeCode.metadata)
      expect(meta).toBeDefined()
      const { targetDir } = applySessionSkills({
        skills: [{ alias: "ap-x", path: src }],
        meta: meta!,
        baseDir: base,
        env,
      })

      expect(targetDir).toBe(join(base, "skills"))
      expect(existsSync(join(base, "skills", "old-skill"))).toBe(false)
      expect(await readFile(join(base, "skills", "ap-x", "SKILL.md"), "utf8")).toContain("name: ap-x")
      expect(await readFile(join(base, "skills", "ap-x", "scripts", "run.sh"), "utf8")).toBe("echo hi\n")
      // No env substitution for claude-code.
      expect(env).toEqual({})
    } finally {
      await rm(base, { recursive: true, force: true })
      await rm(src, { recursive: true, force: true })
    }
  })
})
