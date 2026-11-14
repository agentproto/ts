/**
 * Per-session skill delivery for opencode: the manifest declares
 * `metadata.sessionSkills { dir: "skills", env: { OPENCODE_CONFIG_DIR: "<abs
 * dir>" } }` — the env var is the route that survives `lean` mode (its
 * OPENCODE_DISABLE_EXTERNAL_SKILLS only gates opencode's auto-discovery, not
 * the config-dir scan). The driver copies into `<configDir>/skills/<alias>/`
 * and points OPENCODE_CONFIG_DIR at that same dir.
 */

import { describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applySessionSkills, readSessionSkillsMetadata } from "@agentproto/harness"
import { opencode } from "../index.js"

describe("opencode session-skills metadata", () => {
  it("declares { dir: 'skills', env: { OPENCODE_CONFIG_DIR: '<abs dir>' } }", () => {
    expect(opencode.metadata?.sessionSkills).toEqual({
      dir: "skills",
      env: { OPENCODE_CONFIG_DIR: "<abs dir>" },
    })
    expect(readSessionSkillsMetadata(opencode.metadata)).toEqual({
      dir: "skills",
      env: { OPENCODE_CONFIG_DIR: "<abs dir>" },
    })
  })
})

describe("opencode session-skills delivery", () => {
  it("writes <configDir>/skills/<alias>/, points OPENCODE_CONFIG_DIR at <configDir>, and wipes stale entries", async () => {
    const base = await mkdtemp(join(tmpdir(), "oc-skills-base-"))
    const src = await mkdtemp(join(tmpdir(), "oc-skills-src-"))
    try {
      await writeFile(
        join(src, "SKILL.md"),
        "---\nname: ap-x\ndescription: d\n---\n\nbody\n",
      )
      await mkdir(join(base, "skills", "old-skill"), { recursive: true })
      await writeFile(join(base, "skills", "old-skill", "SKILL.md"), "stale")

      const env: Record<string, string> = {}
      const meta = readSessionSkillsMetadata(opencode.metadata)
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
      // `<abs dir>` substituted with the absolute session config dir (the
      // PARENT of `skills/`, so opencode finds `<dir>/skills/<name>`).
      expect(env.OPENCODE_CONFIG_DIR).toBe(base)
    } finally {
      await rm(base, { recursive: true, force: true })
      await rm(src, { recursive: true, force: true })
    }
  })
})
