/**
 * Unit coverage for `ensureAppUiBuilt` (app-ui-build.ts) — build an
 * installed app's `ui.path` bundle on demand per APP.md's `ui.build`.
 * Exercises the function directly (no daemon/HTTP harness): missing vs.
 * fresh vs. stale bundles, single-flight de-dup, a failing build's error
 * shape, the no-`ui.build` fallback, and the single-file warning.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ensureAppUiBuilt, appUiBuildLogPath, newestSourceMtime } from "../app-ui-build.js"

describe("ensureAppUiBuilt", () => {
  let dir: string
  let uiPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-app-ui-build-"))
    uiPath = join(dir, ".agentproto", "ui", "index.html")
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("missing bundle triggers a build", async () => {
    const result = await ensureAppUiBuilt({
      dir,
      uiPath,
      build: {
        command: `mkdir -p "${join(dir, ".agentproto", "ui")}" && printf '<html>built</html>' > "${uiPath}"`,
      },
    })
    expect(result).toEqual({ ok: true, built: true })
    expect(await readFile(uiPath, "utf8")).toBe("<html>built</html>")
  })

  it("fresh bundle skips the build", async () => {
    await mkdir(join(dir, "src"), { recursive: true })
    await writeFile(join(dir, "src", "main.ts"), "old source", "utf8")
    await utimes(join(dir, "src", "main.ts"), new Date("2020-01-01"), new Date("2020-01-01"))
    await mkdir(join(dir, ".agentproto", "ui"), { recursive: true })
    await writeFile(uiPath, "<html>already built</html>", "utf8")
    await utimes(uiPath, new Date("2024-01-01"), new Date("2024-01-01"))

    const command = `printf '<html>rebuilt</html>' > "${uiPath}"`
    const result = await ensureAppUiBuilt({ dir, uiPath, build: { command } })
    expect(result).toEqual({ ok: true, built: false })
    // The build command never ran — content is untouched.
    expect(await readFile(uiPath, "utf8")).toBe("<html>already built</html>")
  })

  it("stale bundle (older than its sources) rebuilds", async () => {
    await mkdir(join(dir, ".agentproto", "ui"), { recursive: true })
    await writeFile(uiPath, "<html>stale</html>", "utf8")
    await utimes(uiPath, new Date("2020-01-01"), new Date("2020-01-01"))
    // A nested source file, newer than the bundle — exercises the "**"
    // recursive match, not just a flat directory.
    await mkdir(join(dir, "src", "nested"), { recursive: true })
    await writeFile(join(dir, "src", "nested", "widget.ts"), "new source", "utf8")
    await utimes(join(dir, "src", "nested", "widget.ts"), new Date("2024-01-01"), new Date("2024-01-01"))

    const command = `printf '<html>rebuilt</html>' > "${uiPath}"`
    const result = await ensureAppUiBuilt({ dir, uiPath, build: { command } })
    expect(result).toEqual({ ok: true, built: true })
    expect(await readFile(uiPath, "utf8")).toBe("<html>rebuilt</html>")
  })

  it("concurrent requests for the same bundle build exactly once", async () => {
    const counterPath = join(dir, "counter.txt")
    await writeFile(counterPath, "", "utf8")
    const command =
      `printf 'x' >> "${counterPath}" && sleep 0.2 && ` +
      `mkdir -p "${join(dir, ".agentproto", "ui")}" && printf '<html>built</html>' > "${uiPath}"`

    const [a, b, c] = await Promise.all([
      ensureAppUiBuilt({ dir, uiPath, build: { command } }),
      ensureAppUiBuilt({ dir, uiPath, build: { command } }),
      ensureAppUiBuilt({ dir, uiPath, build: { command } }),
    ])
    expect(a).toEqual({ ok: true, built: true })
    expect(b).toEqual(a)
    expect(c).toEqual(a)
    expect(await readFile(counterPath, "utf8")).toBe("x")
  })

  it("a failing build surfaces a readable error naming the log path", async () => {
    const result = await ensureAppUiBuilt({
      dir,
      uiPath,
      build: { command: `echo "boom: something broke" 1>&2 && exit 7` },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error).toContain("exit 7")
    expect(result.error).toContain(appUiBuildLogPath(dir))
    expect(result.error).toContain("boom: something broke")
    const log = await readFile(appUiBuildLogPath(dir), "utf8")
    expect(log).toContain("boom: something broke")
  })

  it("build exits 0 but never wrote the bundle -> readable error", async () => {
    const result = await ensureAppUiBuilt({ dir, uiPath, build: { command: "true" } })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error).toContain(uiPath)
    expect(result.error).toContain("still missing")
  })

  it("no ui.build declared and a missing bundle -> clear error naming the path", async () => {
    const result = await ensureAppUiBuilt({ dir, uiPath })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error).toContain(uiPath)
    expect(result.error).toContain("ui.build")
  })

  it("no ui.build declared and an existing bundle -> ok, not built", async () => {
    await mkdir(join(dir, ".agentproto", "ui"), { recursive: true })
    await writeFile(uiPath, "<html>committed</html>", "utf8")
    const result = await ensureAppUiBuilt({ dir, uiPath })
    expect(result).toEqual({ ok: true, built: false })
  })

  it("warns loudly when a build's output references ./assets (not single-file)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const command =
      `mkdir -p "${join(dir, ".agentproto", "ui")}" && ` +
      `printf '<html><script src="./assets/index.js"></script></html>' > "${uiPath}"`
    const result = await ensureAppUiBuilt({ dir, uiPath, build: { command } })
    expect(result).toEqual({ ok: true, built: true })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("./assets"))
    warn.mockRestore()
  })

  it("respects a declared build.cwd for both the command and its sources", async () => {
    const subCwd = join(dir, "ui")
    await mkdir(join(subCwd, "src"), { recursive: true })
    await writeFile(join(subCwd, "src", "app.ts"), "source", "utf8")
    const command = `mkdir -p "${dirname(uiPath)}" && cat src/app.ts > "${uiPath}"`
    const result = await ensureAppUiBuilt({ dir, uiPath, build: { command, cwd: "ui" } })
    expect(result).toEqual({ ok: true, built: true })
    expect(await readFile(uiPath, "utf8")).toBe("source")
  })
})

describe("newestSourceMtime", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-newest-source-mtime-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("returns undefined when nothing matches", async () => {
    expect(await newestSourceMtime(dir, ["src/**"])).toBeUndefined()
  })

  it("finds the newest file across a ** pattern, including nested dirs", async () => {
    await mkdir(join(dir, "src", "a"), { recursive: true })
    await writeFile(join(dir, "src", "one.ts"), "1", "utf8")
    await writeFile(join(dir, "src", "a", "two.ts"), "2", "utf8")
    await utimes(join(dir, "src", "one.ts"), new Date("2020-01-01"), new Date("2020-01-01"))
    await utimes(join(dir, "src", "a", "two.ts"), new Date("2024-06-01"), new Date("2024-06-01"))
    const newest = await newestSourceMtime(dir, ["src/**"])
    expect(newest).toBe(new Date("2024-06-01").getTime())
  })
})
