/**
 * `skill-imports.ts` registry: import copies a skill folder (never a symlink),
 * records a content sha, and resync/remove keep the copy and the registry in
 * step. Fully hermetic — temp dirs, injected registry path + root.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { existsSync, lstatSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  computeSkillDirSha,
  importSkill,
  listImportedSkills,
  loadImportedSkills,
  parseSkillFrontmatter,
  removeImportedSkill,
  resyncImportedSkill,
  skillImportDir,
  type SkillImportPaths,
} from "../skill-imports.js"

let base: string
let paths: SkillImportPaths

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "skill-imports-"))
  paths = { registryPath: join(base, "imported-skills.json"), root: join(base, "skills") }
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

async function makeSkill(
  name: string,
  opts: { description?: string; extraFiles?: Record<string, string>; frontmatter?: string } = {}
): Promise<string> {
  const dir = join(base, `src-${name}`)
  await mkdir(join(dir, "scripts"), { recursive: true })
  const frontmatter =
    opts.frontmatter ??
    `---\nname: ${name}\ndescription: ${opts.description ?? "does things"}\n---\n\n# ${name}\n`
  await writeFile(join(dir, "SKILL.md"), frontmatter)
  for (const [rel, content] of Object.entries(opts.extraFiles ?? {})) {
    const abs = join(dir, rel)
    await mkdir(join(abs, ".."), { recursive: true })
    await writeFile(abs, content)
  }
  return dir
}

describe("parseSkillFrontmatter", () => {
  it("requires a valid name", () => {
    expect(() => parseSkillFrontmatter("---\ndescription: x\n---\n")).toThrow(/name/)
    expect(() => parseSkillFrontmatter("no frontmatter")).toThrow(/name/)
    expect(parseSkillFrontmatter("---\nname: my-skill\ndescription: d\n---\n").name).toBe("my-skill")
  })
})

describe("importSkill", () => {
  it("copies the folder as a snapshot and records id/alias/sha", async () => {
    const src = await makeSkill("ap-foo", { extraFiles: { "scripts/run.sh": "echo hi\n" } })
    const { config, entry } = await importSkill({ sourcePath: src }, paths)

    expect(entry.id).toBe("ap-foo")
    expect(entry.alias).toBe("ap-foo")
    expect(entry.sourcePath).toBe(await realpath(src))
    expect(entry.sha).toMatch(/^[0-9a-f]{64}$/)
    expect(config.imports).toHaveLength(1)

    const copied = skillImportDir("ap-foo", paths.root)
    expect(await readFile(join(copied, "SKILL.md"), "utf8")).toContain("# ap-foo")
    expect(await readFile(join(copied, "scripts/run.sh"), "utf8")).toBe("echo hi\n")

    // Snapshot, not symlink: deleting the source leaves the copy intact.
    await rm(src, { recursive: true, force: true })
    expect(existsSync(join(copied, "SKILL.md"))).toBe(true)

    expect(await listImportedSkills(paths)).toEqual([entry])
  })

  it("dereferences a symlinked source (and nested symlinks) into a real copy", async () => {
    const realSrc = await makeSkill("ap-link", { extraFiles: { "scripts/run.sh": "echo hi\n" } })
    const link = join(base, "src-link")
    await symlink(realSrc, link, "dir")

    // A nested link that stays INSIDE the skill folder is dereferenced; one
    // that escapes is refused (see the symlink-escape tests below).
    await symlink(join(realSrc, "scripts", "run.sh"), join(realSrc, "linked.txt"))

    const { entry } = await importSkill({ sourcePath: link }, paths)
    expect(entry.sourcePath).toBe(await realpath(realSrc))

    const copied = skillImportDir("ap-link", paths.root)
    expect(lstatSync(copied).isSymbolicLink()).toBe(false)
    expect(lstatSync(join(copied, "linked.txt")).isSymbolicLink()).toBe(false)
    expect(await readFile(join(copied, "linked.txt"), "utf8")).toBe("echo hi\n")

    // Snapshot: removing the real source tree leaves the copy intact.
    await rm(realSrc, { recursive: true, force: true })
    expect(existsSync(join(copied, "SKILL.md"))).toBe(true)
    expect(await readFile(join(copied, "linked.txt"), "utf8")).toBe("echo hi\n")
  })

  it("honours an explicit alias and replaces an existing id", async () => {
    const src = await makeSkill("ap-bar")
    await importSkill({ sourcePath: src, alias: "friendly" }, paths)
    const again = await importSkill({ sourcePath: src, alias: "friendly-2" }, paths)
    expect(again.config.imports).toHaveLength(1)
    expect(again.entry.alias).toBe("friendly-2")
  })

  it("rejects a source with no SKILL.md", async () => {
    const dir = join(base, "empty")
    await mkdir(dir, { recursive: true })
    await expect(importSkill({ sourcePath: dir }, paths)).rejects.toThrow(/SKILL\.md/)
    await expect(importSkill({ sourcePath: join(base, "nope") }, paths)).rejects.toThrow(/does not exist/)
  })

  it("rejects an alias that could escape the delivery dir", async () => {
    const src = await makeSkill("ap-evil")
    await expect(importSkill({ sourcePath: src, alias: "../evil" }, paths)).rejects.toThrow(
      /alias/
    )
    await expect(importSkill({ sourcePath: src, alias: "a/b" }, paths)).rejects.toThrow(/alias/)
    await expect(importSkill({ sourcePath: src, alias: "." }, paths)).rejects.toThrow(/alias/)
    expect(existsSync(join(base, "evil"))).toBe(false)
  })

  it("refuses an alias colliding with another entry's id or alias", async () => {
    await importSkill({ sourcePath: await makeSkill("ap-one"), alias: "shared" }, paths)
    const two = await makeSkill("ap-two")
    await expect(importSkill({ sourcePath: two, alias: "shared" }, paths)).rejects.toThrow(
      /already used/
    )
    await expect(importSkill({ sourcePath: two, alias: "ap-one" }, paths)).rejects.toThrow(
      /already used/
    )
  })

  it("refuses a source inside the imports root (would delete itself)", async () => {
    await importSkill({ sourcePath: await makeSkill("ap-seed") }, paths)
    const inside = join(paths.root!, "ap-inner")
    await mkdir(inside, { recursive: true })
    await writeFile(join(inside, "SKILL.md"), "---\nname: ap-inner\ndescription: d\n---\n")
    await expect(importSkill({ sourcePath: inside }, paths)).rejects.toThrow(/overlaps/)
    expect(existsSync(join(inside, "SKILL.md"))).toBe(true)
    expect(existsSync(skillImportDir("ap-seed", paths.root))).toBe(true)
  })

  it("refuses a source that CONTAINS the imports root", async () => {
    await importSkill({ sourcePath: await makeSkill("ap-seed") }, paths)
    await writeFile(join(base, "SKILL.md"), "---\nname: ap-base\ndescription: d\n---\n")
    await expect(importSkill({ sourcePath: base }, paths)).rejects.toThrow(/overlaps/)
    expect(existsSync(skillImportDir("ap-seed", paths.root))).toBe(true)
  })

  it("refuses a symlink inside the skill that escapes to a directory", async () => {
    const outside = join(base, "outside-secrets")
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, "id_rsa"), "PRIVATE KEY")
    const src = await makeSkill("ap-escape-dir")
    await symlink(outside, join(src, "leak"), "dir")
    await expect(importSkill({ sourcePath: src }, paths)).rejects.toThrow(/escapes/)
    // The copy was refused before it landed in the registry.
    expect(existsSync(skillImportDir("ap-escape-dir", paths.root))).toBe(false)
  })

  it("refuses a symlink inside the skill that escapes to a file", async () => {
    const secret = join(base, "credentials")
    await writeFile(secret, "AKIA-SECRET")
    const src = await makeSkill("ap-escape-file")
    await symlink(secret, join(src, "creds"), "file")
    await expect(importSkill({ sourcePath: src }, paths)).rejects.toThrow(/escapes/)
    expect(existsSync(skillImportDir("ap-escape-file", paths.root))).toBe(false)
  })

  it("refuses a symlink to / without traversing it", async () => {
    const src = await makeSkill("ap-escape-root")
    await symlink("/", join(src, "everything"), "dir")
    await expect(importSkill({ sourcePath: src }, paths)).rejects.toThrow(/escapes/)
    expect(existsSync(skillImportDir("ap-escape-root", paths.root))).toBe(false)
  })

  it("allows a symlink that stays inside the skill folder", async () => {
    const src = await makeSkill("ap-inlink")
    await writeFile(join(src, "real.txt"), "hello")
    await symlink(join(src, "real.txt"), join(src, "alias.txt"), "file")
    const { entry } = await importSkill({ sourcePath: src }, paths)
    expect(entry.id).toBe("ap-inlink")
    // Dereferenced on copy: the delivered tree has a REAL alias.txt.
    const delivered = join(skillImportDir("ap-inlink", paths.root), "alias.txt")
    expect(existsSync(delivered)).toBe(true)
    expect(lstatSync(delivered).isSymbolicLink()).toBe(false)
  })

  it("serializes concurrent imports so neither entry is lost", async () => {
    const a = await makeSkill("ap-conc-a")
    const b = await makeSkill("ap-conc-b")
    await Promise.all([
      importSkill({ sourcePath: a }, paths),
      importSkill({ sourcePath: b }, paths),
    ])
    const config = await loadImportedSkills(paths.registryPath)
    expect(config.imports.map(e => e.id).sort()).toEqual(["ap-conc-a", "ap-conc-b"])
    expect(existsSync(join(paths.root!, "ap-conc-a"))).toBe(true)
    expect(existsSync(join(paths.root!, "ap-conc-b"))).toBe(true)
  })

  it("leaves no temp copy behind after an import (atomic rename)", async () => {
    const src = await makeSkill("ap-atomic")
    await importSkill({ sourcePath: src }, paths)
    const entries = await readdir(paths.root!)
    expect(entries).toContain("ap-atomic")
    expect(entries.filter(e => e.includes(".tmp."))).toEqual([])
  })

  it("tolerates extra frontmatter keys", async () => {
    const src = await makeSkill("ap-extra", {
      frontmatter: "---\nname: ap-extra\ndescription: d\nlicense: MIT\nmetadata:\n  aip3:\n    schema: skills/v1\n---\n",
    })
    const { entry } = await importSkill({ sourcePath: src }, paths)
    expect(entry.id).toBe("ap-extra")
  })
})

describe("computeSkillDirSha", () => {
  it("moves on a content change, not on a no-op re-copy", async () => {
    const src = await makeSkill("ap-sha", { extraFiles: { "a.txt": "one\n" } })
    const { entry } = await importSkill({ sourcePath: src }, paths)
    expect(await computeSkillDirSha(skillImportDir("ap-sha", paths.root))).toBe(entry.sha)

    await writeFile(join(src, "a.txt"), "two\n")
    expect(await computeSkillDirSha(src)).not.toBe(entry.sha)
  })
})

describe("resyncImportedSkill", () => {
  it("re-copies when the source changed and reports changed", async () => {
    const src = await makeSkill("ap-resync", { extraFiles: { "a.txt": "one\n" } })
    const { entry } = await importSkill({ sourcePath: src }, paths)

    await writeFile(join(src, "a.txt"), "two\n")
    const r = await resyncImportedSkill(entry.id, paths)
    expect(r.changed).toBe(true)
    expect(r.entry?.sha).not.toBe(entry.sha)
    expect(await readFile(join(skillImportDir("ap-resync", paths.root), "a.txt"), "utf8")).toBe("two\n")
  })

  it("is a no-op when nothing changed", async () => {
    const src = await makeSkill("ap-stable")
    const { entry } = await importSkill({ sourcePath: src }, paths)
    const r = await resyncImportedSkill(entry.id, paths)
    expect(r.changed).toBe(false)
    expect(r.warnings).toEqual([])
  })

  it("warns instead of throwing when the source is gone, keeping the entry", async () => {
    const src = await makeSkill("ap-gone")
    const { entry } = await importSkill({ sourcePath: src }, paths)
    await rm(src, { recursive: true, force: true })
    const r = await resyncImportedSkill(entry.id, paths)
    expect(r.changed).toBe(false)
    expect(r.warnings[0]).toMatch(/could not resync/)
    expect(r.config.imports.some(e => e.id === entry.id)).toBe(true)
  })
})

describe("removeImportedSkill", () => {
  it("drops the entry and deletes the copied tree", async () => {
    const src = await makeSkill("ap-rm")
    const { entry } = await importSkill({ sourcePath: src }, paths)
    const r = await removeImportedSkill(entry.id, paths)
    expect(r.removed).toBe(true)
    expect(existsSync(skillImportDir("ap-rm", paths.root))).toBe(false)
    expect((await loadImportedSkills(paths.registryPath)).imports).toHaveLength(0)
  })

  it("reports removed:false for an unknown id", async () => {
    const r = await removeImportedSkill("ghost", paths)
    expect(r.removed).toBe(false)
  })
})
