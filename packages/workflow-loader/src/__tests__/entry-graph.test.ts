import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { ENTRY_GRAPH_HOOK_SOURCE, ENTRY_GRAPH_VERSION_PARAM, entryGraphVersion } from "../entry-graph.js"

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "entry-graph-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("entryGraphVersion", () => {
  it("is stable for an untouched graph and changes with the content of any reachable file", async () => {
    const dir = tmp()
    mkdirSync(join(dir, "wf"))
    mkdirSync(join(dir, "shared"))
    const entry = join(dir, "wf", "entry.mjs")
    writeFileSync(entry, 'import "./a.mjs"; import "../shared/s.mjs"')
    writeFileSync(join(dir, "wf", "a.mjs"), 'import "./b.mjs"')
    writeFileSync(join(dir, "wf", "b.mjs"), "export const b = 1")
    writeFileSync(join(dir, "shared", "s.mjs"), 'export * from "./t.mjs"')
    writeFileSync(join(dir, "shared", "t.mjs"), "export const t = 1")
    writeFileSync(join(dir, "outside.mjs"), "export const o = 1")
    const v0 = await entryGraphVersion(entry)
    expect(v0).toMatch(/^[0-9a-f]{16}$/)
    expect(await entryGraphVersion(entry)).toBe(v0)

    writeFileSync(join(dir, "outside.mjs"), "export const o = 2")
    expect(await entryGraphVersion(entry)).toBe(v0)

    const seen = new Set([v0])
    for (const [file, content] of [
      ["wf/b.mjs", "export const b = 2"],
      ["shared/t.mjs", "export const t = 2"],
      ["shared/s.mjs", 'export * from "./t.mjs"; export const s = 1'],
    ] as const) {
      writeFileSync(join(dir, file), content)
      const v = await entryGraphVersion(entry)
      expect(seen.has(v)).toBe(false)
      seen.add(v)
    }
  })

  it("ignores dotfiles and node_modules, and follows imports past the directory-scan depth", async () => {
    const dir = tmp()
    const entry = join(dir, "entry.mjs")
    mkdirSync(join(dir, "node_modules"))
    mkdirSync(join(dir, "a/b/c/d"), { recursive: true })
    writeFileSync(entry, 'import "./a/b/c/d/deep.mjs"')
    writeFileSync(join(dir, "a/b/c/d/deep.mjs"), "export const d = 1")
    writeFileSync(join(dir, "node_modules", "x.mjs"), "1")
    writeFileSync(join(dir, ".hidden.mjs"), "1")
    const v0 = await entryGraphVersion(entry)
    writeFileSync(join(dir, "node_modules", "x.mjs"), "2")
    writeFileSync(join(dir, ".hidden.mjs"), "2")
    expect(await entryGraphVersion(entry)).toBe(v0)
    writeFileSync(join(dir, "a/b/c/d/deep.mjs"), "export const d = 2")
    expect(await entryGraphVersion(entry)).not.toBe(v0)
  })

  it("changes when a missing import target appears, and survives import cycles", async () => {
    const dir = tmp()
    const entry = join(dir, "entry.mjs")
    writeFileSync(entry, 'import "./later.mjs"')
    const missing = await entryGraphVersion(entry)
    writeFileSync(join(dir, "later.mjs"), 'import "./entry.mjs"')
    expect(await entryGraphVersion(entry)).not.toBe(missing)
  })

  it("is empty for an unreadable entry", async () => {
    expect(await entryGraphVersion(join(tmp(), "nope", "entry.mjs"))).toBe("")
  })
})

describe("entry-graph resolve hook (real node process)", () => {
  /** Imports `entry.mjs` twice at two versions, editing a relative import
   *  between; prints what each import saw. */
  const driver = (dir: string) => `
    import { register } from "node:module"
    import { writeFileSync } from "node:fs"
    import { pathToFileURL } from "node:url"
    register("data:text/javascript," + encodeURIComponent(${JSON.stringify(ENTRY_GRAPH_HOOK_SOURCE)}))
    const entry = pathToFileURL(${JSON.stringify(join(dir, "entry.mjs"))})
    const load = async v => {
      const u = new URL(entry); if (v !== undefined) u.searchParams.set(${JSON.stringify(ENTRY_GRAPH_VERSION_PARAM)}, v)
      return (await import(u.href)).default
    }
    const first = await load("1")
    writeFileSync(${JSON.stringify(join(dir, "dep.mjs"))}, 'import { deep } from "./deep.mjs"; export const value = "new:" + deep')
    writeFileSync(${JSON.stringify(join(dir, "deep.mjs"))}, 'export const deep = "deep-new"')
    const sameVersion = await load("1")
    const bumped = await load("2")
    console.log(JSON.stringify({ first, sameVersion, bumped }))
  `

  it("re-reads relative imports (and theirs) when the version changes, serves the cache when it does not", () => {
    const dir = tmp()
    writeFileSync(join(dir, "entry.mjs"), 'import { value } from "./dep.mjs"\nexport default value')
    writeFileSync(join(dir, "dep.mjs"), 'import { deep } from "./deep.mjs"; export const value = "old:" + deep')
    writeFileSync(join(dir, "deep.mjs"), 'export const deep = "deep-old"')
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", driver(dir)], { encoding: "utf8" })
    expect(JSON.parse(out.trim().split("\n").pop()!)).toEqual({
      first: "old:deep-old",
      sameVersion: "old:deep-old",
      bumped: "new:deep-new",
    })
  })

  it("never versions bare specifiers (shared library singletons stay single)", () => {
    const dir = tmp()
    writeFileSync(join(dir, "entry.mjs"), 'import { sep } from "node:path"\nimport os from "node:os"\nexport default [sep, typeof os.cpus]')
    const script = `
      import { register } from "node:module"
      import { pathToFileURL } from "node:url"
      register("data:text/javascript," + encodeURIComponent(${JSON.stringify(ENTRY_GRAPH_HOOK_SOURCE)}))
      const u = pathToFileURL(${JSON.stringify(join(dir, "entry.mjs"))}); u.searchParams.set("${ENTRY_GRAPH_VERSION_PARAM}", "7")
      console.log(JSON.stringify((await import(u.href)).default))
    `
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })
    expect(JSON.parse(out.trim())).toEqual(["/", "function"])
  })
})
