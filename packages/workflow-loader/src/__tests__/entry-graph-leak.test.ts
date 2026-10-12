/**
 * The entry-graph hook as installed by the package's own `registerEntryGraphHook`,
 * in disposable child processes (never the vitest host — the hook and version
 * import only exist outside Vite).
 *
 * 1. Failed-import handle regression: repeated FAILED dynamic imports with the
 *    hook installed must not grow the process's async-handle count (Node 22's
 *    off-thread loader was observed leaking a MessagePort per failed import,
 *    unreclaimed by GC — the long-lived-daemon handle pile-up this guards
 *    against). On a runtime with `module.registerHooks` (Node >= 22.15, the
 *    CI floor) the child must also show NO loader-thread pipes (PipeWrap) at
 *    any point — that observable separates the synchronous path from
 *    `module.register()`, which always holds the channel open from
 *    registration onward.
 *
 * 2. Fallback installation: a runtime without `registerHooks` (simulated by
 *    hiding it from the `node:module` namespace the way Node <= 22.14 lacks
 *    it) must still install the off-thread data-URL hook, version-propagate
 *    through it, and keep register-once — i.e. the engines-floor path (Node
 *    20.9) never depends on the newer API and never fails at link time.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const bundleDir = join(pkgDir, "node_modules", ".cache", "entry-graph-leak-test")

beforeAll(() => {
  execFileSync(
    join(pkgDir, "node_modules", ".bin", "tsup"),
    ["src/entry-graph.ts", "--format", "esm", "--no-dts", "--no-config", "--no-splitting", "--out-dir", bundleDir],
    { cwd: pkgDir, stdio: "pipe" },
  )
}, 60_000)

afterAll(() => {
  rmSync(bundleDir, { recursive: true, force: true })
})

const bundleHref = (): string => pathToFileURL(join(bundleDir, "entry-graph.js")).href

const cleanEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "VITEST" && !k.startsWith("VITEST_")))

const runChild = <T>(script: string, nodeArgs: string[] = []): T => {
  const stdout = execFileSync(process.execPath, [...nodeArgs, "--input-type=module", "-e", script], {
    encoding: "utf8",
    env: cleanEnv(),
    cwd: pkgDir,
  })
  return JSON.parse(stdout.trim().split("\n").pop()!) as T
}

type Snapshot = Record<string, number>
type Probe = {
  firstRegister: boolean
  secondRegister: boolean
  syncAvailable: boolean
  defaultExport: number
  failedImports: number
  before: Snapshot
  after: Snapshot
}

const grown = (before: Snapshot, after: Snapshot): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(k => (after[k] ?? 0) > (before[k] ?? 0))
    .map(k => `${k}: ${before[k] ?? 0} -> ${after[k] ?? 0}`)

describe("registerEntryGraphHook in a real node process", () => {
  it("installs once, keeps handles flat across 500 missing imports, and avoids the off-thread loader channel when registerHooks exists", () => {
    const driver = `
      import { mkdtempSync, writeFileSync } from "node:fs"
      import { tmpdir } from "node:os"
      import { join } from "node:path"
      import { pathToFileURL } from "node:url"
      const { registerEntryGraphHook } = await import(${JSON.stringify(bundleHref())})

      const firstRegister = registerEntryGraphHook()
      const secondRegister = registerEntryGraphHook()
      const syncAvailable = typeof (await import("node:module")).registerHooks === "function"

      const dir = mkdtempSync(join(tmpdir(), "entry-graph-leak-"))
      writeFileSync(join(dir, "entry.mjs"), 'import { d } from "./dep.mjs"; export default d')
      writeFileSync(join(dir, "dep.mjs"), "export const d = 1")
      const u = pathToFileURL(join(dir, "entry.mjs"))
      u.searchParams.set("agentproto_v", "v1")
      const mod = await import(u.href)

      const gc = () => { if (globalThis.gc) { globalThis.gc(); globalThis.gc() } }
      const snap = () => {
        const counts = {}
        for (const r of process.getActiveResourcesInfo()) counts[r] = (counts[r] ?? 0) + 1
        return counts
      }

      gc()
      const before = snap()
      let failedImports = 0
      for (let i = 0; i < 500; i++) {
        try { await import(pathToFileURL(join(dir, "missing-" + i + ".mjs")).href) } catch { failedImports++ }
      }
      gc()
      const after = snap()
      console.log(JSON.stringify({ firstRegister, secondRegister, syncAvailable, defaultExport: mod.default, failedImports, before, after }))
    `
    const r = runChild<Probe>(driver, ["--expose-gc"])
    expect(r.firstRegister).toBe(true)
    expect(r.secondRegister).toBe(true)
    expect(r.defaultExport).toBe(1)
    expect(r.failedImports).toBe(500)
    expect(grown(r.before, r.after)).toEqual([])
    if (r.syncAvailable) {
      // module.register() would hold loader-thread pipes from registration on
      expect(r.before.PipeWrap ?? 0).toBe(0)
      expect(r.after.PipeWrap ?? 0).toBe(0)
    }
  })

  it("falls back to the off-thread data-URL hook when registerHooks is absent, still propagating versions", () => {
    const driver = `
      import { createRequire } from "node:module"
      import { mkdtempSync, writeFileSync } from "node:fs"
      import { tmpdir } from "node:os"
      import { join } from "node:path"
      import { pathToFileURL } from "node:url"
      // Simulate Node <= 22.14 (engines floor 20.9): no module.registerHooks.
      // Builtins don't live-sync their CJS exports into the ESM namespace, so
      // hide it the documented way — mutate + syncBuiltinESMExports — before
      // the bundle reads the namespace.
      const require = createRequire(import.meta.url)
      require("module").registerHooks = undefined
      require("module").syncBuiltinESMExports()
      const { registerEntryGraphHook } = await import(${JSON.stringify(bundleHref())})
      const registerHooksHidden = typeof (await import("node:module")).registerHooks !== "function"

      const firstRegister = registerEntryGraphHook()
      const secondRegister = registerEntryGraphHook()

      const dir = mkdtempSync(join(tmpdir(), "entry-graph-fallback-"))
      writeFileSync(join(dir, "entry.mjs"), 'import { d } from "./dep.mjs"; export default d')
      writeFileSync(join(dir, "dep.mjs"), "export const d = new URL(import.meta.url).searchParams.get(\\"agentproto_v\\")")
      const u = pathToFileURL(join(dir, "entry.mjs"))
      u.searchParams.set("agentproto_v", "v7")
      const mod = await import(u.href)
      console.log(JSON.stringify({ registerHooksHidden, firstRegister, secondRegister, defaultExport: mod.default }))
    `
    const r = runChild<{ registerHooksHidden: boolean; firstRegister: boolean; secondRegister: boolean; defaultExport: string | null }>(driver)
    expect(r.registerHooksHidden).toBe(true)
    expect(r.firstRegister).toBe(true)
    expect(r.secondRegister).toBe(true)
    // the fallback hook carried the version to the entry's relative import
    expect(r.defaultExport).toBe("v7")
  })
})
