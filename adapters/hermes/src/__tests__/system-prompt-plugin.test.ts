/**
 * Tests for the agentproto-system-prompt plugin helpers (status + install)
 * and the plugin's own Python unit tests (run through `python3` when the
 * interpreter is available on this machine).
 */
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import {
  HERMES_SYSTEM_PROMPT_PLUGIN_NAME,
  MAX_HERMES_SYSTEM_PROMPT_CHARS,
  bundledHermesSystemPromptPluginDir,
  hermesSystemPromptPluginStatus,
  installHermesSystemPromptPlugin,
  resolveHermesHome,
} from "../system-prompt-plugin.js"

const PLUGIN_DIR = bundledHermesSystemPromptPluginDir()
const PLUGIN_TEST_DIR = dirname(
  fileURLToPath(
    new URL("../../plugin/test_agentproto_system_prompt.py", import.meta.url),
  ),
)

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentproto-hermes-plugin-"))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function writePlugin(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "plugin.yaml"),
    `name: ${HERMES_SYSTEM_PROMPT_PLUGIN_NAME}\nversion: ${version}\ndescription: test\n`,
  )
  writeFileSync(join(dir, "__init__.py"), "def register(ctx):\n    pass\n")
}

function writeConfig(hermesHome: string, yaml: string): void {
  mkdirSync(hermesHome, { recursive: true })
  writeFileSync(join(hermesHome, "config.yaml"), yaml)
}

describe("MAX_HERMES_SYSTEM_PROMPT_CHARS", () => {
  it("is 7500 — the 8000 hermes budget minus its audit headings", () => {
    expect(MAX_HERMES_SYSTEM_PROMPT_CHARS).toBe(7500)
    expect(MAX_HERMES_SYSTEM_PROMPT_CHARS).toBeLessThan(8000)
  })
})

describe("resolveHermesHome", () => {
  it("prefers HERMES_HOME when set", () => {
    expect(resolveHermesHome({ HERMES_HOME: "/tmp/custom-hermes" })).toBe(
      "/tmp/custom-hermes",
    )
  })

  it("falls back to ~/.hermes", () => {
    expect(resolveHermesHome({})).toMatch(/\.hermes$/)
  })
})

describe("hermesSystemPromptPluginStatus", () => {
  it("reports not installed / not enabled on a fresh home", () => {
    const home = tempDir()
    const status = hermesSystemPromptPluginStatus({ env: { HERMES_HOME: home } })
    expect(status.installed).toBe(false)
    expect(status.enabled).toBe(false)
    expect(status.installedVersion).toBeUndefined()
    expect(status.path).toBe(join(home, "plugins", HERMES_SYSTEM_PROMPT_PLUGIN_NAME))
  })

  it("always reports the bundled version", () => {
    const home = tempDir()
    const status = hermesSystemPromptPluginStatus({ env: { HERMES_HOME: home } })
    expect(status.bundledVersion).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("reports installed + version from plugin.yaml", () => {
    const home = tempDir()
    writePlugin(join(home, "plugins", HERMES_SYSTEM_PROMPT_PLUGIN_NAME), "0.2.0")
    const status = hermesSystemPromptPluginStatus({ env: { HERMES_HOME: home } })
    expect(status.installed).toBe(true)
    expect(status.installedVersion).toBe("0.2.0")
    expect(status.enabled).toBe(false)
  })

  it("is enabled only when plugins.enabled lists the plugin", () => {
    const home = tempDir()
    writePlugin(join(home, "plugins", HERMES_SYSTEM_PROMPT_PLUGIN_NAME), "0.1.0")
    writeConfig(
      home,
      "plugins:\n  enabled:\n    - other-plugin\n    - agentproto-system-prompt\n",
    )
    const status = hermesSystemPromptPluginStatus({ env: { HERMES_HOME: home } })
    expect(status.installed).toBe(true)
    expect(status.enabled).toBe(true)
  })

  it("treats an unparseable config.yaml as not enabled (conservative)", () => {
    const home = tempDir()
    writePlugin(join(home, "plugins", HERMES_SYSTEM_PROMPT_PLUGIN_NAME), "0.1.0")
    writeConfig(home, "plugins: { enabled: [agentproto-system-prompt")
    const status = hermesSystemPromptPluginStatus({ env: { HERMES_HOME: home } })
    expect(status.installed).toBe(true)
    expect(status.enabled).toBe(false)
  })

  it("treats plugins.enabled without a list as not enabled", () => {
    const home = tempDir()
    writePlugin(join(home, "plugins", HERMES_SYSTEM_PROMPT_PLUGIN_NAME), "0.1.0")
    writeConfig(home, "plugins:\n  enabled: agentproto-system-prompt\n")
    const status = hermesSystemPromptPluginStatus({ env: { HERMES_HOME: home } })
    expect(status.enabled).toBe(false)
  })
})

describe("installHermesSystemPromptPlugin", () => {
  it("copies the bundled plugin on a fresh home", async () => {
    const home = tempDir()
    const result = await installHermesSystemPromptPlugin({ env: { HERMES_HOME: home } })
    expect(result.action).toBe("installed")
    expect(result.enable.requested).toBe(false)
    const status = hermesSystemPromptPluginStatus({ env: { HERMES_HOME: home } })
    expect(status.installed).toBe(true)
    expect(status.installedVersion).toBe(result.bundledVersion)
  })

  it("leaves an equal-or-newer installed copy untouched", async () => {
    const home = tempDir()
    const target = join(home, "plugins", HERMES_SYSTEM_PROMPT_PLUGIN_NAME)
    writePlugin(target, "99.0.0")
    const result = await installHermesSystemPromptPlugin({ env: { HERMES_HOME: home } })
    expect(result.action).toBe("unchanged")
    expect(result.installedVersion).toBe("99.0.0")
  })

  it("overwrites an older installed copy", async () => {
    const home = tempDir()
    const target = join(home, "plugins", HERMES_SYSTEM_PROMPT_PLUGIN_NAME)
    writePlugin(target, "0.0.1")
    const result = await installHermesSystemPromptPlugin({ env: { HERMES_HOME: home } })
    expect(result.action).toBe("updated")
    const status = hermesSystemPromptPluginStatus({ env: { HERMES_HOME: home } })
    expect(status.installedVersion).toBe(result.bundledVersion)
  })

  it("runs `hermes plugins enable` when asked, reporting its exit code", async () => {
    const home = tempDir()
    const binDir = tempDir()
    // Fake `hermes` on PATH — argv spawn, no shell; exit 0 records success.
    const fakeBin = join(binDir, "hermes")
    writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n")
    chmodSync(fakeBin, 0o755)
    const result = await installHermesSystemPromptPlugin({
      env: { HERMES_HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      enable: true,
    })
    expect(result.enable.requested).toBe(true)
    expect(result.enable.exitCode).toBe(0)
    expect(result.enable.error).toBeUndefined()
  })

  it("surfaces a failing hermes enable instead of throwing", async () => {
    const home = tempDir()
    const binDir = tempDir()
    const fakeBin = join(binDir, "hermes")
    writeFileSync(fakeBin, "#!/bin/sh\necho 'nope' >&2\nexit 3\n")
    chmodSync(fakeBin, 0o755)
    const result = await installHermesSystemPromptPlugin({
      env: { HERMES_HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      enable: true,
    })
    expect(result.enable.requested).toBe(true)
    expect(result.enable.exitCode).toBe(3)
    expect(result.enable.error).toContain("nope")
  })

  it("reports a missing hermes binary as an enable error", async () => {
    const home = tempDir()
    const result = await installHermesSystemPromptPlugin({
      env: { HERMES_HOME: home, PATH: tempDir() },
      enable: true,
    })
    expect(result.enable.requested).toBe(true)
    expect(result.enable.exitCode).toBeUndefined()
    expect(result.enable.error).toBeDefined()
  })
})

describe("bundled plugin", () => {
  it("ships plugin.yaml + __init__.py", () => {
    const status = hermesSystemPromptPluginStatus({ env: { HERMES_HOME: tempDir() } })
    expect(status.bundledVersion).not.toBe("unknown")
    expect(PLUGIN_DIR).toContain(HERMES_SYSTEM_PROMPT_PLUGIN_NAME)
  })

  // The plugin's own unit tests are Python; run them through python3 when
  // the interpreter exists, skip loudly otherwise (never silently).
  const python = (() => {
    try {
      execFileSync("python3", ["--version"], { stdio: "pipe", timeout: 5_000 })
      return "python3"
    } catch {
      return null
    }
  })()

  it.skipIf(!python)(
    "python unittest passes (python3 -m unittest)",
    () => {
      const run = spawnSync("python3", ["-m", "unittest", "test_agentproto_system_prompt"], {
        cwd: PLUGIN_TEST_DIR,
        encoding: "utf8",
        timeout: 30_000,
      })
      if (run.status !== 0) {
        console.error(run.stdout)
        console.error(run.stderr)
      }
      expect(run.status).toBe(0)
    },
    30_000,
  )

  if (!python) {
    console.log(
      "[skip] hermes plugin python unittest: python3 is not available on this machine",
    )
  }
})
