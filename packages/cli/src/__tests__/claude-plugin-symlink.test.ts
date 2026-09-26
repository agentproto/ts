/**
 * Re-installing the Claude Code plugin from a symlinked pack (the pnpm
 * node_modules layout) must overwrite the existing plugin dir — `fs.cp` on a
 * symlink source used to fail with ENOTDIR and abort the whole fan-out.
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { installClaudePlugin } from "../commands/skill-install/claude-plugin.js"

let root = ""
afterEach(async () => {
  vi.restoreAllMocks()
  if (root) await rm(root, { recursive: true, force: true })
})

describe("installClaudePlugin", () => {
  it("overwrites an existing plugin dir from a symlinked pack", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    root = await mkdtemp(join(tmpdir(), "claude-plugin-"))
    const real = join(root, "real-pack")
    await mkdir(join(real, ".claude-plugin"), { recursive: true })
    await writeFile(join(real, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.8.3" }))
    // A workspace pack's own node_modules/.turbo must not be bundled.
    await mkdir(join(real, "node_modules", "dep"), { recursive: true })
    await writeFile(join(real, "node_modules", "dep", "index.js"), "")
    await mkdir(join(real, ".turbo"), { recursive: true })
    await mkdir(join(real, "skills", "x"), { recursive: true })
    await writeFile(join(real, "skills", "x", "SKILL.md"), "---\nname: x\n---")
    const linked = join(root, "linked-pack")
    await symlink(real, linked)
    const outDir = join(root, "out")
    await mkdir(join(outDir, ".claude-plugin"), { recursive: true })
    await writeFile(join(outDir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.5.0" }))

    const result = await installClaudePlugin(
      { name: "x", description: "", dir: join(linked, "skills", "x") },
      { force: true, dryRun: false, slug: "agentproto-pack", outDir, packDir: linked },
      "claude-code",
    )
    expect(result.status).toBe("overwritten")
    expect(JSON.parse(await readFile(join(outDir, ".claude-plugin", "plugin.json"), "utf8")).version).toBe("0.8.3")
    expect(existsSync(join(outDir, "skills", "x", "SKILL.md"))).toBe(true)
    expect(existsSync(join(outDir, "node_modules"))).toBe(false)
    expect(existsSync(join(outDir, ".turbo"))).toBe(false)
  })
})
