/**
 * Unit coverage for `ensureAppUiBuilt` (app-ui-build.ts) — build an
 * installed app's `ui.path` bundle on demand per APP.md's `ui.build`.
 * Exercises the function directly (no daemon/HTTP harness): missing vs.
 * fresh vs. stale bundles, single-flight de-dup, a failing build's error
 * shape, the no-`ui.build` fallback, and the single-file warning.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  ensureAppUiBuilt,
  appUiBuildLogPath,
  appUiBuildStampPath,
  collectSourceFiles,
  newestSourceMtime,
  peekInFlightBuild,
  resolveAppUiBuildState,
} from "../app-ui-build.js"

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

  it("writes the build log under the daemon state dir, never inside the app dir", async () => {
    const prev = process.env.AGENTPROTO_HOME
    const home = await mkdtemp(join(tmpdir(), "agentproto-home-"))
    process.env.AGENTPROTO_HOME = home
    try {
      const logPath = appUiBuildLogPath(dir)
      expect(logPath.startsWith(join(home, "logs", "app-ui-build") + "/")).toBe(true)
      expect(logPath.startsWith(dir)).toBe(false)
      const result = await ensureAppUiBuilt({
        dir,
        uiPath,
        build: { command: `echo "log-line" && mkdir -p "${dirname(uiPath)}" && printf '<html/>' > "${uiPath}"` },
      })
      expect(result.ok).toBe(true)
      expect(await readFile(logPath, "utf8")).toContain("log-line")
      await expect(readFile(join(dir, ".agentproto", "ui-build.log"), "utf8")).rejects.toThrow()
    } finally {
      if (prev === undefined) delete process.env.AGENTPROTO_HOME
      else process.env.AGENTPROTO_HOME = prev
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe("resolveAppUiBuildState", () => {
  let dir: string
  let uiPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-resolve-build-state-"))
    uiPath = join(dir, ".agentproto", "ui", "index.html")
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("resolves 'ready' fast when the bundle already exists and is fresh — no build ever runs", async () => {
    await mkdir(dirname(uiPath), { recursive: true })
    await writeFile(uiPath, "<html>already built</html>", "utf8")
    const state = await resolveAppUiBuildState({
      dir,
      uiPath,
      build: { command: `echo should-not-run >> "${join(dir, "ran.marker")}"` },
    })
    expect(state).toEqual({ kind: "ready" })
    await expect(readFile(join(dir, "ran.marker"), "utf8")).rejects.toThrow()
  })

  it("resolves 'error' fast when there's no ui.build and the bundle is missing", async () => {
    const state = await resolveAppUiBuildState({ dir, uiPath })
    expect(state.kind).toBe("error")
    if (state.kind !== "error") throw new Error("expected error")
    expect(state.message).toContain(uiPath)
    expect(state.logPath).toBe(appUiBuildLogPath(dir))
  })

  it("returns 'building' (never blocking) while a slow build is still running, then 'ready' once it lands", async () => {
    const command =
      `sleep 0.6 && mkdir -p "${dirname(uiPath)}" && printf '<html>slow-built</html>' > "${uiPath}"`
    const started = Date.now()
    const state = await resolveAppUiBuildState({ dir, uiPath, build: { command } })
    expect(Date.now() - started).toBeLessThan(500)
    expect(state.kind).toBe("building")
    if (state.kind !== "building") throw new Error("expected building")
    expect(state.startedAt).toBeLessThanOrEqual(Date.now())

    // The SAME background build is still tracked — a second caller joins it
    // rather than starting a fresh one (peekInFlightBuild finds it).
    expect(peekInFlightBuild(uiPath)).toBeDefined()
    await peekInFlightBuild(uiPath)

    const after = await resolveAppUiBuildState({ dir, uiPath, build: { command: "exit 1" } })
    expect(after).toEqual({ kind: "ready" })
    expect(await readFile(uiPath, "utf8")).toBe("<html>slow-built</html>")
  })

  it("returns 'error' with the failure's message and a log tail once a build fails", async () => {
    const state = await resolveAppUiBuildState({
      dir,
      uiPath,
      build: { command: `echo "boom: broke" 1>&2 && exit 9` },
    })
    expect(state.kind).toBe("error")
    if (state.kind !== "error") throw new Error("expected error")
    expect(state.message).toContain("exit 9")
    expect(state.logTail).toContain("boom: broke")
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

describe("content-hash staleness, source excludes, stale-while-revalidate", () => {
  let dir: string
  let uiPath: string
  let counterPath: string
  let home: string
  let prevHome: string | undefined

  const runs = async () => (await readFile(counterPath, "utf8")).length
  const old = new Date("2020-01-01")
  const later = new Date("2024-01-01")

  beforeEach(async () => {
    prevHome = process.env.AGENTPROTO_HOME
    home = await mkdtemp(join(tmpdir(), "agentproto-home-"))
    process.env.AGENTPROTO_HOME = home
    dir = await mkdtemp(join(tmpdir(), "agentproto-app-ui-swr-"))
    uiPath = join(dir, ".agentproto", "ui", "index.html")
    counterPath = join(dir, "counter.txt")
    await writeFile(counterPath, "", "utf8")
    await mkdir(join(dir, "src", "__tests__"), { recursive: true })
    await writeFile(join(dir, "src", "main.ts"), "v1", "utf8")
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.AGENTPROTO_HOME
    else process.env.AGENTPROTO_HOME = prevHome
    await rm(dir, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  /** Counts each run in counter.txt and writes the bundle from src/main.ts. */
  const buildCmd = (prefix = "") =>
    `${prefix}printf x >> "${counterPath}" && mkdir -p "${dirname(uiPath)}" && ` +
    `cat "${join(dir, "src", "main.ts")}" > "${uiPath}"`

  /** Rewrite src/main.ts, dated after the bundle so the mtime tier reads
   *  "stale" deterministically (no reliance on fs timestamp resolution). */
  async function editSource(content: string): Promise<void> {
    const st = await stat(uiPath)
    await writeFile(join(dir, "src", "main.ts"), content, "utf8")
    await utimes(join(dir, "src", "main.ts"), new Date(st.mtimeMs + 60_000), new Date(st.mtimeMs + 60_000))
  }

  it("writes the build stamp under the daemon state dir", async () => {
    await ensureAppUiBuilt({ dir, uiPath, build: { command: buildCmd() } })
    expect(appUiBuildStampPath(uiPath).startsWith(join(home, "state", "app-ui-build") + "/")).toBe(true)
    expect(JSON.parse(await readFile(appUiBuildStampPath(uiPath), "utf8")).sourcesHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("an mtime-only change (identical bytes) does not rebuild", async () => {
    await ensureAppUiBuilt({ dir, uiPath, build: { command: buildCmd() } })
    // Source rewritten with the same content, now newer than the bundle.
    await editSource("v1")
    expect(await ensureAppUiBuilt({ dir, uiPath, build: { command: buildCmd() } })).toEqual({ ok: true, built: false })
    expect(await runs()).toBe(1)
  })

  it("a real content change rebuilds", async () => {
    await ensureAppUiBuilt({ dir, uiPath, build: { command: buildCmd() } })
    await editSource("v2")
    expect(await ensureAppUiBuilt({ dir, uiPath, build: { command: buildCmd() } })).toEqual({ ok: true, built: true })
    expect(await readFile(uiPath, "utf8")).toBe("v2")
  })

  it("a bundle replaced behind the stamp's back is not vouched for", async () => {
    await ensureAppUiBuilt({ dir, uiPath, build: { command: buildCmd() } })
    await writeFile(uiPath, "an older committed bundle", "utf8")
    await utimes(uiPath, old, old)
    await utimes(join(dir, "src", "main.ts"), later, later)
    expect(await ensureAppUiBuilt({ dir, uiPath, build: { command: buildCmd() } })).toEqual({ ok: true, built: true })
    expect(await readFile(uiPath, "utf8")).toBe("v1")
  })

  it("test files never count as sources", async () => {
    await mkdir(dirname(uiPath), { recursive: true })
    await writeFile(uiPath, "<html/>", "utf8")
    await utimes(join(dir, "src", "main.ts"), old, old)
    await utimes(uiPath, new Date("2022-01-01"), new Date("2022-01-01"))
    for (const file of ["__tests__/a.ts", "b.test.tsx", "c.spec.ts"]) {
      await writeFile(join(dir, "src", file), "test", "utf8")
      await utimes(join(dir, "src", file), later, later)
    }
    expect(await ensureAppUiBuilt({ dir, uiPath, build: { command: buildCmd() } })).toEqual({ ok: true, built: false })
    expect(await newestSourceMtime(dir, ["src/**"])).toBe(old.getTime())
  })

  it("a !pattern entry in sources excludes matches", async () => {
    await mkdir(join(dir, "src", "fixtures"), { recursive: true })
    await writeFile(join(dir, "src", "fixtures", "big.json"), "{}", "utf8")
    await utimes(join(dir, "src", "main.ts"), old, old)
    await utimes(join(dir, "src", "fixtures", "big.json"), later, later)
    expect(await newestSourceMtime(dir, ["src/**", "!src/fixtures/**"])).toBe(old.getTime())
    expect((await collectSourceFiles(dir, ["src/**", "!src/fixtures/**"])).map(f => f.rel)).toEqual(["src/main.ts"])
  })

  it("serves the existing bundle while a slow rebuild runs in the background", async () => {
    const command = buildCmd("sleep 0.6 && ")
    await ensureAppUiBuilt({ dir, uiPath, build: { command } })
    await editSource("v2")

    const started = Date.now()
    const state = await resolveAppUiBuildState({ dir, uiPath, build: { command } })
    expect(Date.now() - started).toBeLessThan(500)
    expect(state).toEqual({ kind: "ready", stale: "rebuilding" })
    expect(await readFile(uiPath, "utf8")).toBe("v1")
    expect(await runs()).toBe(1)

    await peekInFlightBuild(uiPath)
    expect(await readFile(uiPath, "utf8")).toBe("v2")
    expect(await resolveAppUiBuildState({ dir, uiPath, build: { command } })).toEqual({ kind: "ready" })
  })

  it("a failed rebuild keeps serving the old bundle and isn't retried until sources change", async () => {
    await ensureAppUiBuilt({ dir, uiPath, build: { command: buildCmd() } })
    const failing = `printf x >> "${counterPath}" && exit 3`
    await editSource("broken")

    expect(await resolveAppUiBuildState({ dir, uiPath, build: { command: failing } })).toEqual({
      kind: "ready",
      stale: "build-failed",
    })
    const after = await runs()
    expect(after).toBe(2)
    expect(await resolveAppUiBuildState({ dir, uiPath, build: { command: failing } })).toEqual({
      kind: "ready",
      stale: "build-failed",
    })
    expect(await runs()).toBe(after)

    await editSource("still broken")
    await resolveAppUiBuildState({ dir, uiPath, build: { command: failing } })
    expect(await runs()).toBe(after + 1)
    expect(await readFile(uiPath, "utf8")).toBe("v1")
  })

  it("a missing bundle's failed build is retried on every render", async () => {
    const failing = `printf x >> "${counterPath}" && exit 3`
    expect((await resolveAppUiBuildState({ dir, uiPath, build: { command: failing } })).kind).toBe("error")
    expect((await resolveAppUiBuildState({ dir, uiPath, build: { command: failing } })).kind).toBe("error")
    expect(await runs()).toBe(2)
  })
})
