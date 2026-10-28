/**
 * `@agentproto/runtime` is bundled into `cli.mjs`, and through it `defuddle`
 * and `linkedom`. linkedom does `try { require("canvas") } catch { shim }`:
 * `canvas` is an optional peer it never needs. Wherever a native `canvas` is
 * installed but not compiled (a pnpm workspace that lists `canvas: false` in
 * `allowBuilds`, such as the agentik-studio monorepo), esbuild follows that
 * require into canvas/lib/bindings.js and tsup's native-node-modules plugin
 * fails the whole build on `../build/Release/canvas.node`. Keeping `canvas`
 * external leaves the guarded require to run (and fall back) at load time.
 *
 * This builds a fixture with the real `external` list of tsup.config.ts, next
 * to an uncompiled fake `canvas`, through the same tsup plugin chain.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import tsupConfig from "../../tsup.config"

describe("bundling an optional native peer that is installed but not compiled", () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-optional-native-peer-"))
    const canvas = join(dir, "node_modules", "canvas")
    mkdirSync(join(canvas, "lib"), { recursive: true })
    writeFileSync(
      join(canvas, "package.json"),
      JSON.stringify({ name: "canvas", version: "3.2.3", main: "index.js" }),
    )
    writeFileSync(join(canvas, "index.js"), "module.exports = require('./lib/bindings')\n")
    writeFileSync(
      join(canvas, "lib", "bindings.js"),
      "module.exports = require('../build/Release/canvas.node')\n",
    )
    mkdirSync(join(dir, "src"))
    writeFileSync(
      join(dir, "src", "entry.cjs"),
      "try { module.exports = require('canvas') } catch { module.exports = { shim: true } }\n",
    )
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("builds with the cli external list and keeps the guarded require(\"canvas\") unbundled", () => {
    const external = (tsupConfig as { external?: string[] }).external
    expect(external).toBeDefined()

    // A child process: the plugin failure kills esbuild's service and would
    // surface in the runner as an uncaught exception instead of a failure.
    const script = `
      const { build } = await import("tsup")
      await build({
        config: false,
        silent: true,
        entry: { entry: ${JSON.stringify(join(dir, "src", "entry.cjs"))} },
        format: ["esm"],
        outDir: ${JSON.stringify(join(dir, "dist"))},
        dts: false,
        splitting: false,
        external: ${JSON.stringify(external)},
      })
    `
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: join(import.meta.dirname, "..", ".."),
      encoding: "utf8",
    })
    expect(run.status, run.stderr.slice(0, 400)).toBe(0)

    const [file] = readdirSync(join(dir, "dist")).filter((f) => /^entry\.[cm]?js$/.test(f))
    const out = readFileSync(join(dir, "dist", file), "utf8")
    expect(out).toMatch(/require\(["']canvas["']\)/)
    expect(out).not.toContain("canvas.node")
  })
})
