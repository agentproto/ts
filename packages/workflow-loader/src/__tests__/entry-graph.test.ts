import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs"
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
  it("is the newest script mtime under the entry dir, ignoring dotfiles and node_modules", async () => {
    const dir = tmp()
    writeFileSync(join(dir, "entry.mjs"), "export default 1")
    writeFileSync(join(dir, "rules.mjs"), "export const a = 1")
    mkdirSync(join(dir, "node_modules"))
    writeFileSync(join(dir, "node_modules", "x.mjs"), "")
    writeFileSync(join(dir, "notes.md"), "")
    utimesSync(join(dir, "entry.mjs"), 1000, 1000)
    utimesSync(join(dir, "rules.mjs"), 2000, 2000)
    utimesSync(join(dir, "node_modules", "x.mjs"), 9000, 9000)
    utimesSync(join(dir, "notes.md"), 9000, 9000)
    expect(await entryGraphVersion(dir)).toBe(2_000_000)
    utimesSync(join(dir, "rules.mjs"), 3000, 3000)
    expect(await entryGraphVersion(dir)).toBe(3_000_000)
  })

  it("is 0 for a missing dir", async () => {
    expect(await entryGraphVersion(join(tmp(), "nope"))).toBe(0)
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
