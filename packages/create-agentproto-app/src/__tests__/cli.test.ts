/**
 * Tests for `runCreateApp` (`src/cli.ts`) — argv parsing, exit codes, and
 * `--json` output shape. Hermetic: scaffolds into a tmp dir, no install/
 * network. stdout/stderr are captured via a spy rather than asserting on
 * real terminal output.
 */

import { describe, it, expect, afterEach, vi } from "vitest"

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { runCreateApp } from "../cli.js"

const tmpRoots: string[] = []

async function mktmp(prefix = "create-agentproto-app-cli-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tmpRoots.push(dir)
  return dir
}

afterEach(async () => {
  for (const p of tmpRoots) await rm(p, { recursive: true, force: true })
  tmpRoots.length = 0
  vi.restoreAllMocks()
})

function captureStdout(): { text: () => string } {
  let out = ""
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += typeof chunk === "string" ? chunk : String(chunk)
    return true
  })
  return { text: () => out }
}

function captureStderr(): { text: () => string } {
  let out = ""
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    out += typeof chunk === "string" ? chunk : String(chunk)
    return true
  })
  return { text: () => out }
}

describe("runCreateApp", () => {
  it("exits 2 with usage when <dir> is missing", async () => {
    const stderr = captureStderr()
    const code = await runCreateApp([])
    expect(code).toBe(2)
    expect(stderr.text()).toContain("<dir> is required")
  })

  it("scaffolds and prints a human summary by default", async () => {
    const root = await mktmp()
    const target = join(root, "human-app")
    const stdout = captureStdout()

    const code = await runCreateApp([target])
    expect(code).toBe(0)
    expect(stdout.text()).toContain("scaffolded")
    expect(stdout.text()).toContain(target)
    expect(stdout.text()).toContain("agentproto app dev .")
  })

  it("--json prints a parseable object with the resolved fields", async () => {
    const root = await mktmp()
    const target = join(root, "json-app")
    const stdout = captureStdout()

    const code = await runCreateApp([target, "--json", "--name", "JSON App"])
    expect(code).toBe(0)

    const parsed: unknown = JSON.parse(stdout.text())
    expect(parsed).toMatchObject({
      appDir: target,
      id: "json-app",
      name: "JSON App",
      slug: "json-app",
      template: "react-ts",
    })
  })

  it("--id overrides the default plain-slug id", async () => {
    const root = await mktmp()
    const target = join(root, "scoped-app")
    const stdout = captureStdout()

    const code = await runCreateApp([target, "--json", "--id", "@acme/scoped-app"])
    expect(code).toBe(0)
    const parsed: unknown = JSON.parse(stdout.text())
    expect(parsed).toMatchObject({ id: "@acme/scoped-app", slug: "scoped-app" })
  })

  it("exits 2 and reports the reason when the target dir is non-empty", async () => {
    const root = await mktmp()
    const target = join(root, "occupied")
    await mkdir(target, { recursive: true })
    await writeFile(join(target, "keep.txt"), "x", "utf8")

    const stderr = captureStderr()
    const code = await runCreateApp([target])
    expect(code).toBe(2)
    expect(stderr.text()).toContain("already exists and is not empty")
  })

  it("--template vanilla scaffolds and prints `app serve` (not `app dev`) next steps", async () => {
    const root = await mktmp()
    const target = join(root, "vanilla-app")
    const stdout = captureStdout()

    const code = await runCreateApp([target, "--template", "vanilla"])
    expect(code).toBe(0)
    expect(stdout.text()).toContain("agentproto app serve .")
    expect(stdout.text()).not.toContain("pnpm install")
    expect(stdout.text()).not.toContain("agentproto app dev .")
  })

  it("--help prints usage and exits 0 without touching the filesystem", async () => {
    const stdout = captureStdout()
    const code = await runCreateApp(["--help"])
    expect(code).toBe(0)
    expect(stdout.text()).toContain("create-agentproto-app")
    expect(stdout.text()).toContain("Usage:")
  })
})
