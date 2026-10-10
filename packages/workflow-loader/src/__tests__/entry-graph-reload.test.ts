/**
 * End-to-end cache-busting of a workflow's local import graph, through the
 * real `loadWorkflowHandle` in a real Node process (the hook + `import()`
 * versioning only exist outside Vite, so an in-process test can't see them).
 * The child imports a bundle of `src/` built by tsup into node_modules/.cache,
 * so the test needs neither a prior `pnpm build` of this package nor VITEST.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const bundleDir = join(pkgDir, "node_modules", ".cache", "entry-graph-reload-test")
const roots: string[] = []

beforeAll(() => {
  execFileSync(
    join(pkgDir, "node_modules", ".bin", "tsup"),
    ["src/index.ts", "--format", "esm", "--no-dts", "--no-config", "--no-splitting", "--out-dir", bundleDir, "--external", "@agentproto/workflow"],
    { cwd: pkgDir, stdio: "pipe" },
  )
}, 60_000)

afterAll(() => {
  rmSync(bundleDir, { recursive: true, force: true })
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const counted = (name: string, body: string): string =>
  `const e = (globalThis.__evals ??= {}); e[${JSON.stringify(name)}] = (e[${JSON.stringify(name)}] ?? 0) + 1\n${body}\n`

type Step = { write: string; content: string } | { load: string }
type Loaded = { marker: string; evals: Record<string, number> }

/** Fixture: wf/entry.mjs imports ./dep.mjs (-> ./deep.mjs), ../shared/lib.mjs
 *  (-> ./lib2.mjs) and ./a/b/c/d/deepest.mjs (4 dirs down); other/unrelated.mjs
 *  is imported by nothing. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "entry-graph-reload-"))
  roots.push(root)
  const files: Record<string, string> = {
    "wf/WORKFLOW.md": `---\nname: wf\nid: wf\ndescription: d\nversion: 0.1.0\nentry: ./entry.mjs\ninputs: {}\noutputs: {}\nsteps:\n  - id: marker\n    kind: transform\n---\n\nx\n`,
    "wf/entry.mjs": counted(
      "entry",
      `import { value as dep } from "./dep.mjs"\nimport { value as lib } from "../shared/lib.mjs"\nimport { value as deepest } from "./a/b/c/d/deepest.mjs"\n` +
        `export default { name: "wf", id: "wf", description: "d", version: "0.1.0", inputs: {}, outputs: {}, steps: [{ id: "marker", kind: "transform", compute: () => [dep, lib, deepest].join("|") }] }`,
    ),
    "wf/dep.mjs": counted("dep", `import { deep } from "./deep.mjs"\nexport const value = "dep1/" + deep`),
    "wf/deep.mjs": counted("deep", `export const deep = "deep1"`),
    "shared/lib.mjs": counted("lib", `import { deep } from "./lib2.mjs"\nexport const value = "lib1/" + deep`),
    "shared/lib2.mjs": counted("lib2", `export const deep = "lib2v1"`),
    "wf/a/b/c/d/deepest.mjs": counted("deepest", `export const value = "deepest1"`),
    "other/unrelated.mjs": counted("unrelated", `export const value = "u1"`),
  }
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return { root, path: (rel: string) => join(root, rel) }
}

function runInChild(steps: Step[]): Loaded[] {
  const driver = `
    import { writeFileSync } from "node:fs"
    const { loadWorkflowHandle } = await import(${JSON.stringify(pathToFileURL(join(bundleDir, "index.js")).href)})
    const out = []
    for (const s of ${JSON.stringify(steps)}) {
      if ("write" in s) { writeFileSync(s.write, s.content); continue }
      const h = await loadWorkflowHandle(s.load)
      out.push({ marker: h.steps[0].compute(), evals: { ...globalThis.__evals } })
    }
    console.log(JSON.stringify(out))
  `
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "VITEST" && !k.startsWith("VITEST_")))
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", driver], { encoding: "utf8", env, cwd: pkgDir })
  return JSON.parse(stdout.trim().split("\n").pop()!) as Loaded[]
}

describe("loadWorkflowHandle serves fresh code for the whole import graph (real node process)", () => {
  it("picks up an edit to a relative import at depth 1 and depth 2 in the entry directory", () => {
    const f = fixture()
    const wf = f.path("wf/WORKFLOW.md")
    const r = runInChild([
      { load: wf },
      { write: f.path("wf/dep.mjs"), content: counted("dep", `import { deep } from "./deep.mjs"\nexport const value = "dep2/" + deep`) },
      { load: wf },
      { write: f.path("wf/deep.mjs"), content: counted("deep", `export const deep = "deep2"`) },
      { load: wf },
    ])
    expect(r.map(x => x.marker)).toEqual([
      "dep1/deep1|lib1/lib2v1|deepest1",
      "dep2/deep1|lib1/lib2v1|deepest1",
      "dep2/deep2|lib1/lib2v1|deepest1",
    ])
  })

  it("picks up an edit to a module OUTSIDE the entry directory (sibling dir), at depth 1 and depth 2", () => {
    const f = fixture()
    const wf = f.path("wf/WORKFLOW.md")
    const r = runInChild([
      { load: wf },
      { write: f.path("shared/lib.mjs"), content: counted("lib", `import { deep } from "./lib2.mjs"\nexport const value = "lib2/" + deep`) },
      { load: wf },
      { write: f.path("shared/lib2.mjs"), content: counted("lib2", `export const deep = "lib2v2"`) },
      { load: wf },
    ])
    expect(r.map(x => x.marker)).toEqual([
      "dep1/deep1|lib1/lib2v1|deepest1",
      "dep1/deep1|lib2/lib2v1|deepest1",
      "dep1/deep1|lib2/lib2v2|deepest1",
    ])
  })

  it("picks up an edit nested deeper than the entry-directory scan, and a same-size rewrite", () => {
    const f = fixture()
    const wf = f.path("wf/WORKFLOW.md")
    const r = runInChild([
      { load: wf },
      { write: f.path("wf/a/b/c/d/deepest.mjs"), content: counted("deepest", `export const value = "deepest2"`) },
      { load: wf },
    ])
    expect(r.map(x => x.marker)).toEqual(["dep1/deep1|lib1/lib2v1|deepest1", "dep1/deep1|lib1/lib2v1|deepest2"])
  })

  it("re-evaluates nothing when the graph is unchanged or only an unrelated file changed", () => {
    const f = fixture()
    const wf = f.path("wf/WORKFLOW.md")
    const r = runInChild([
      { load: wf },
      { load: wf },
      { write: f.path("other/unrelated.mjs"), content: counted("unrelated", `export const value = "u2"`) },
      { load: wf },
    ])
    const once = { entry: 1, dep: 1, deep: 1, lib: 1, lib2: 1, deepest: 1 }
    expect(r[0]!.evals).toEqual(once)
    expect(r[1]!.evals).toEqual(once)
    expect(r[2]!.evals).toEqual(once)
  })

  it("re-evaluates exactly the graph (entry and every module under it) once per change", () => {
    const f = fixture()
    const wf = f.path("wf/WORKFLOW.md")
    const r = runInChild([
      { load: wf },
      { write: f.path("shared/lib2.mjs"), content: counted("lib2", `export const deep = "lib2v2"`) },
      { load: wf },
      { load: wf },
    ])
    expect(r[1]!.evals).toEqual({ entry: 2, dep: 2, deep: 2, lib: 2, lib2: 2, deepest: 2 })
    expect(r[2]!.evals).toEqual(r[1]!.evals)
  })
})
