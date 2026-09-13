/**
 * Tests for `agentproto app build` (`../app-build.ts`): the no-ui-project /
 * no-build-script no-op paths, package-manager detection by lockfile, and a
 * real (but hermetic — no network, no daemon) build run through a fixture
 * `ui/` project whose "build" script just writes `.agentproto/ui/index.html`
 * with plain `node -e`, so no bundler dependency is needed to exercise the
 * spawn + verify-output path.
 */

import { describe, it, expect, afterEach, vi } from "vitest"

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { runAppBuild, detectPackageManager } from "../app-build.js"

const tmpRoots: string[] = []

afterEach(async () => {
  for (const p of tmpRoots) await rm(p, { recursive: true, force: true })
  tmpRoots.length = 0
  vi.restoreAllMocks()
})

async function mktmp(prefix = "app-build-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tmpRoots.push(dir)
  return dir
}

async function writeAppMd(appDir: string): Promise<void> {
  await mkdir(join(appDir, ".agentproto"), { recursive: true })
  await writeFile(
    join(appDir, ".agentproto", "APP.md"),
    "---\nschema: app/v1\nid: fixture-app\n---\n# Fixture\n",
    "utf8",
  )
}

function captureStdout(): string[] {
  const writes: string[] = []
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  })
  return writes
}

function captureStderr(): string[] {
  const writes: string[] = []
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  })
  return writes
}

describe("detectPackageManager", () => {
  it("defaults to pnpm when no lockfile is found anywhere", async () => {
    const appDir = await mktmp()
    const uiDir = join(appDir, "ui")
    await mkdir(uiDir, { recursive: true })
    expect(await detectPackageManager(appDir, uiDir)).toBe("pnpm")
  })

  it("detects npm from a package-lock.json in the app root", async () => {
    const appDir = await mktmp()
    const uiDir = join(appDir, "ui")
    await mkdir(uiDir, { recursive: true })
    await writeFile(join(appDir, "package-lock.json"), "{}", "utf8")
    expect(await detectPackageManager(appDir, uiDir)).toBe("npm")
  })

  it("detects yarn from a yarn.lock in ui/ when the app root has none", async () => {
    const appDir = await mktmp()
    const uiDir = join(appDir, "ui")
    await mkdir(uiDir, { recursive: true })
    await writeFile(join(uiDir, "yarn.lock"), "", "utf8")
    expect(await detectPackageManager(appDir, uiDir)).toBe("yarn")
  })

  it("prefers a lockfile in the app root over one in ui/", async () => {
    const appDir = await mktmp()
    const uiDir = join(appDir, "ui")
    await mkdir(uiDir, { recursive: true })
    await writeFile(join(appDir, "pnpm-lock.yaml"), "", "utf8")
    await writeFile(join(uiDir, "package-lock.json"), "{}", "utf8")
    expect(await detectPackageManager(appDir, uiDir)).toBe("pnpm")
  })
})

describe("runAppBuild", () => {
  it("returns 2 when <appDir> is omitted", async () => {
    expect(await runAppBuild([])).toBe(2)
  })

  it("returns 2 when appDir has no .agentproto/APP.md", async () => {
    const appDir = await mktmp()
    expect(await runAppBuild([appDir])).toBe(2)
  })

  it("no-ops successfully (human line) when there is no ui/package.json", async () => {
    const appDir = await mktmp()
    await writeAppMd(appDir)
    const writes = captureStdout()
    expect(await runAppBuild([appDir])).toBe(0)
    expect(writes.join("")).toContain("no ui build step")
  })

  it("--json reports {built:false, reason:'no-ui-project'} with no ui/package.json", async () => {
    const appDir = await mktmp()
    await writeAppMd(appDir)
    const writes = captureStdout()
    expect(await runAppBuild([appDir, "--json"])).toBe(0)
    expect(JSON.parse(writes.join(""))).toEqual({ built: false, reason: "no-ui-project" })
  })

  it("--json reports {built:false, reason:'no-build-script'} when ui/package.json has no build script", async () => {
    const appDir = await mktmp()
    await writeAppMd(appDir)
    await mkdir(join(appDir, "ui"), { recursive: true })
    await writeFile(
      join(appDir, "ui", "package.json"),
      JSON.stringify({ name: "ui", scripts: { dev: "vite" } }),
      "utf8",
    )
    const writes = captureStdout()
    expect(await runAppBuild([appDir, "--json"])).toBe(0)
    expect(JSON.parse(writes.join(""))).toEqual({ built: false, reason: "no-build-script" })
  })

  it("runs the ui project's build script and reports the built .agentproto/ui", async () => {
    const appDir = await mktmp()
    await writeAppMd(appDir)
    await mkdir(join(appDir, "ui"), { recursive: true })
    await writeFile(
      join(appDir, "ui", "package.json"),
      JSON.stringify({
        name: "ui",
        scripts: {
          build:
            "node -e \"require('fs').mkdirSync('../.agentproto/ui',{recursive:true});require('fs').writeFileSync('../.agentproto/ui/index.html','<html></html>')\"",
        },
      }),
      "utf8",
    )
    const writes = captureStdout()
    expect(await runAppBuild([appDir, "--json"])).toBe(0)
    const uiOutDir = join(appDir, ".agentproto", "ui")
    expect(existsSync(join(uiOutDir, "index.html"))).toBe(true)
    expect(JSON.parse(writes.join(""))).toEqual({ built: true, uiDir: uiOutDir })
  })

  it("returns 1 when the build script exits non-zero", async () => {
    const appDir = await mktmp()
    await writeAppMd(appDir)
    await mkdir(join(appDir, "ui"), { recursive: true })
    await writeFile(
      join(appDir, "ui", "package.json"),
      JSON.stringify({
        name: "ui",
        scripts: { build: "node -e \"process.exit(3)\"" },
      }),
      "utf8",
    )
    const stderr = captureStderr()
    expect(await runAppBuild([appDir])).toBe(1)
    expect(stderr.join("")).toContain("failed with exit code")
  })

  it("returns 1 with a hint when the build succeeds but emits no .agentproto/ui/index.html", async () => {
    const appDir = await mktmp()
    await writeAppMd(appDir)
    await mkdir(join(appDir, "ui"), { recursive: true })
    await writeFile(
      join(appDir, "ui", "package.json"),
      JSON.stringify({
        name: "ui",
        scripts: { build: "node -e \"0\"" },
      }),
      "utf8",
    )
    const stderr = captureStderr()
    expect(await runAppBuild([appDir])).toBe(1)
    expect(stderr.join("")).toContain("../.agentproto/ui")
  })
})
