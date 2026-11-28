import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type FakeServer, FAKE, PACKAGE_ROOT, cleanStores, startServer, workdir, writeRecipe } from "./helpers"

const BIN = join(PACKAGE_ROOT, "dist/cli.mjs")

function run(args: string[], cwd: string, env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, ...env } })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c) => (stdout += c))
    child.stderr.on("data", (c) => (stderr += c))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

describe("collect binary", () => {
  let server: FakeServer
  beforeAll(async () => {
    // `test` does not depend on this package's own build: make the binary if it is not there.
    if (!existsSync(BIN)) {
      const built = spawnSync("pnpm", ["exec", "tsup"], { cwd: PACKAGE_ROOT, encoding: "utf8" })
      if (built.status !== 0) throw new Error(`building the binary failed: ${built.stderr}`)
    }
    server = await startServer()
  })
  afterAll(async () => {
    await server.close()
    cleanStores()
  })

  it("prints its version and help", async () => {
    const dir = workdir("bin-help")
    expect((await run(["--version"], dir)).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
    const help = await run(["--help"], dir)
    expect(help.code).toBe(0)
    expect(help.stdout).toContain("reparse")
  })

  it("init, run, export and exit codes through the real process", async () => {
    const dir = workdir("bin-run")
    expect((await run(["init", "store"], dir)).code).toBe(0)
    const recipe = writeRecipe(dir, server.base, ["alpha", "missing"])
    const partial = await run(["run", recipe, "--store", "store", "--rate-ms", "0"], dir)
    expect(partial.code).toBe(1)
    expect(partial.stderr).toContain("[run.start]")
    const exp = await run(["export", "--store", "store"], dir)
    expect(exp.code).toBe(0)
    expect(exp.stdout.trim().split("\n")).toHaveLength(2)
    expect((await run(["connectors", "--connector", FAKE, "--json"], dir)).code).toBe(0)
    expect((await run(["bogus"], dir)).code).toBe(2)
    expect((await run(["runs", "--store", "absent"], dir)).code).toBe(3)
  })
})
