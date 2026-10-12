/**
 * The probe helper in a real Node ESM process — bundled with the package-local
 * tsup and executed via `process.execPath`, never the vitest host (vite
 * rewrites `import.meta`, and `import.meta.resolve`, the API the sync
 * preflight is built on, does not exist there).
 *
 * 1. Real conditional-exports regression: a package whose exports map offers
 *    an `import` target but whose `require` target does NOT exist is
 *    importable. A require-based preflight would classify it missing
 *    (`MODULE_NOT_FOUND`) and silently drop a working provider;
 *    `import.meta.resolve` uses import conditions and must say present, and
 *    the probe must return the module — not just a preflight answer.
 *
 * 2. Failed-probe handle regression: 500 distinct missing bare packages
 *    through the probe (each a synchronous preflight miss) must not grow the
 *    process's active-resource count, nor init a MessagePort through the
 *    registered async hook — Node 22's off-thread loader was observed leaking
 *    one MessagePort per failed import, unreclaimed by GC, which is the
 *    long-lived-daemon handle pile-up this whole patch guards against.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const bundleDir = join(pkgDir, "node_modules", ".cache", "provider-probes-node-test")

beforeAll(() => {
  execFileSync(
    join(pkgDir, "node_modules", ".bin", "tsup"),
    [
      "src/provider-probes.ts",
      "--format",
      "esm",
      "--no-dts",
      "--no-config",
      "--no-splitting",
      "--out-dir",
      bundleDir,
    ],
    { cwd: pkgDir, stdio: "pipe" },
  )
  // Conditional-exports fixture on the BUNDLE's resolution path: the require
  // target is absent on purpose, the import target exists. Placed in the
  // bundle's own node_modules so `import.meta.resolve` inside the helper and
  // a dynamic import from the helper share one base — exactly the layout the
  // preflight must agree with.
  const fixtureDir = join(bundleDir, "node_modules", "probe-fixture-conditional")
  mkdirSync(fixtureDir, { recursive: true })
  writeFileSync(
    join(fixtureDir, "package.json"),
    JSON.stringify(
      {
        name: "probe-fixture-conditional",
        version: "1.0.0",
        type: "module",
        exports: { ".": { require: "./main.cjs", import: "./main.mjs" } },
      },
      null,
      2,
    ),
  )
  writeFileSync(join(fixtureDir, "main.mjs"), 'export const ok = "esm"\n')
}, 60_000)

afterAll(() => {
  rmSync(bundleDir, { recursive: true, force: true })
})

const bundleHref = (): string => {
  const entry = readdirSync(bundleDir).find((f) => /^provider-probes\.m?js$/.test(f))
  if (!entry) throw new Error(`tsup produced no provider-probes bundle in ${bundleDir}`)
  return pathToFileURL(join(bundleDir, entry)).href
}

const cleanEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "VITEST" && !k.startsWith("VITEST_")),
  )

const runChild = <T>(script: string, nodeArgs: string[] = []): T => {
  const stdout = execFileSync(process.execPath, [...nodeArgs, "--input-type=module", "-e", script], {
    encoding: "utf8",
    env: cleanEnv(),
    cwd: pkgDir,
  })
  return JSON.parse(stdout.trim().split("\n").pop()!) as T
}

type Snapshot = Record<string, number>

const grown = (before: Snapshot, after: Snapshot): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => (after[k] ?? 0) > (before[k] ?? 0))
    .map((k) => `${k}: ${before[k] ?? 0} -> ${after[k] ?? 0}`)

describe("provider probes in a real node process", () => {
  it("treats a package whose require target is absent but import target exists as present, and imports it", () => {
    const driver = `
      import { createRequire } from "node:module"
      const helpers = await import(${JSON.stringify(bundleHref())})

      const metaHasResolve = typeof import.meta.resolve === "function"
      const preflightSaysPresent = helpers.missingSyncDefault("probe-fixture-conditional")
      const preflightSaysMissing = helpers.missingSyncDefault("@agentproto/probe-canary-absent")

      // The false negative a require-based preflight would produce.
      let requireFailed = false
      try { createRequire(import.meta.url).resolve("probe-fixture-conditional") } catch { requireFailed = true }
      const bundleRequireFailed = (() => {
        try {
          createRequire(${JSON.stringify(bundleHref())}).resolve("probe-fixture-conditional")
          return false
        } catch { return true }
      })()

      const cache = helpers.createProviderProbeCache()
      const namespace = await cache.probe("probe-fixture-conditional")
      const cached = await cache.probe("probe-fixture-conditional")
      console.log(JSON.stringify({ metaHasResolve, preflightSaysPresent, preflightSaysMissing, requireFailed, bundleRequireFailed, ok: namespace?.ok ?? null, cachedSame: cached === namespace }))
    `
    const r = runChild<{
      metaHasResolve: boolean
      preflightSaysPresent: boolean
      preflightSaysMissing: boolean
      requireFailed: boolean
      bundleRequireFailed: boolean
      ok: string | null
      cachedSame: boolean
    }>(driver)

    expect(r.metaHasResolve).toBe(true)
    // The regression: require says missing, import conditions say present.
    expect(r.requireFailed).toBe(true)
    expect(r.bundleRequireFailed).toBe(true)
    expect(r.preflightSaysPresent).toBe(false)
    expect(r.preflightSaysMissing).toBe(true)
    // ...and the probe really imports it, not just preflights it.
    expect(r.ok).toBe("esm")
    expect(r.cachedSame).toBe(true)
  }, 60_000)

  it("keeps async handles flat across 500 distinct missing bare packages under a registered async hook", () => {
    const driver = `
      import { createHook } from "node:async_hooks"
      const helpers = await import(${JSON.stringify(bundleHref())})

      let messagePortInits = 0
      const hook = createHook({
        init(_asyncId, type) { if (type === "MessagePort") messagePortInits++ },
      })
      hook.enable()

      const gc = () => { if (globalThis.gc) { globalThis.gc(); globalThis.gc() } }
      const snap = () => {
        const counts = {}
        for (const r of process.getActiveResourcesInfo()) counts[r] = (counts[r] ?? 0) + 1
        return counts
      }
      const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

      const cache = helpers.createProviderProbeCache()

      const preflightMisses = []
      for (let i = 0; i < 16; i++) {
        preflightMisses.push(helpers.missingSyncDefault("@agentproto/probe-canary-" + i))
      }

      await settle()
      gc()
      const before = snap()

      let nulls = 0
      for (let i = 0; i < 500; i++) {
        if ((await cache.probe("@agentproto/probe-canary-" + i)) === null) nulls++
      }

      gc()
      const after = snap()
      hook.disable()

      // The cached negative is stable, and an invalidation retries it (the
      // install-a-provider recovery path) without growing anything either.
      let repeatNulls = 0
      for (let i = 0; i < 25; i++) {
        if ((await cache.probe("@agentproto/probe-canary-repeat")) === null) repeatNulls++
      }
      cache.invalidate("@agentproto/probe-canary-repeat")
      const reprobeNull = (await cache.probe("@agentproto/probe-canary-repeat")) === null

      console.log(JSON.stringify({
        allPreflightMiss: preflightMisses.every(Boolean),
        nulls,
        messagePortInits,
        before,
        after,
        repeatNulls,
        reprobeNull,
      }))
    `
    const r = runChild<{
      allPreflightMiss: boolean
      nulls: number
      messagePortInits: number
      before: Snapshot
      after: Snapshot
      repeatNulls: number
      reprobeNull: boolean
    }>(driver, ["--expose-gc"])

    // The preflight proved every canary missing, so no import ever ran and
    // the async loader's leaky error path was never entered.
    expect(r.allPreflightMiss).toBe(true)
    expect(r.nulls).toBe(500)
    expect(grown(r.before, r.after)).toEqual([])
    expect(r.messagePortInits).toBe(0)
    expect(r.repeatNulls).toBe(25)
    expect(r.reprobeNull).toBe(true)
  }, 60_000)
})
