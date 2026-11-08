/**
 * `agentproto doctor` verb — exit codes, `--json` shape, TTY colour rules,
 * flag validation. Runs the real step registry over a fake StepContext.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, expect } from "vitest"
import { runDoctor, type DoctorDeps, type DoctorJson } from "../commands/doctor.js"
import { ONBOARDING_STEPS } from "../onboarding/registry.js"
import type { OnboardingStep } from "../onboarding/types.js"
import { createFakeContext, type FakeContextOptions } from "../onboarding/__fixtures__/fake-context.js"

interface Harness {
  deps: DoctorDeps
  out: () => string
  err: () => string
}

function harness(opts: { ctx?: FakeContextOptions; tty?: boolean; env?: Record<string, string>; steps?: OnboardingStep[] } = {}): Harness {
  let out = ""
  let err = ""
  return {
    deps: {
      context: () => createFakeContext(opts.ctx),
      steps: opts.steps ?? ONBOARDING_STEPS,
      stdout: { write: (s: string) => (out += s), isTTY: opts.tty ?? false },
      stderr: { write: (s: string) => (err += s) },
      env: opts.env ?? {},
    },
    out: () => out,
    err: () => err,
  }
}

const ANSI = /\x1b\[/

describe("agentproto doctor", () => {
  it("healthy machine exits 0 with grouped human output and no ANSI off-TTY", async () => {
    const h = harness()
    expect(await runDoctor([], h.deps)).toBe(0)
    const out = h.out()
    expect(out).toContain("agentproto doctor — v1.0.0 · darwin/arm64")
    expect(out).toContain("\nDaemon\n")
    expect(out).toContain("✓ Daemon /health")
    expect(out).toContain("Run `agentproto doctor --json` and attach it to bug reports.")
    expect(out).not.toMatch(ANSI)
  })

  it("colours on a TTY, but not when NO_COLOR is set", async () => {
    const tty = harness({ tty: true })
    await runDoctor([], tty.deps)
    expect(tty.out()).toMatch(ANSI)

    const noColor = harness({ tty: true, env: { NO_COLOR: "1" } })
    await runDoctor([], noColor.deps)
    expect(noColor.out()).not.toMatch(ANSI)
  })

  it("a required missing check exits 1 and prints its fix", async () => {
    const h = harness({ ctx: { health: null } })
    expect(await runDoctor([], h.deps)).toBe(1)
    expect(h.out()).toContain("✗ Daemon /health")
    expect(h.out()).toContain("→ fix: agentproto daemon start")
  })

  it("warn-only runs exit 0", async () => {
    const h = harness({ ctx: { sources: { latestCliVersion: async () => "9.9.9" } } })
    expect(await runDoctor([], h.deps)).toBe(0)
    expect(h.out()).toContain("! CLI version")
  })

  it("an optional broken step does not fail the run", async () => {
    const h = harness({
      ctx: {
        sources: {
          listAuthProfiles: async () => {
            throw new Error("corrupt")
          },
        },
      },
    })
    expect(await runDoctor([], h.deps)).toBe(0)
  })

  it("--json prints the documented shape", async () => {
    const h = harness()
    expect(await runDoctor(["--json", "--only", "preflight"], h.deps)).toBe(0)
    const json: DoctorJson = JSON.parse(h.out())
    expect(Object.keys(json)).toEqual(["version", "platform", "steps", "summary"])
    expect(json.version).toBe("1.0.0")
    expect(json.platform).toBe("darwin/arm64")
    expect(json.summary).toEqual({ ok: 5, warn: 0, missing: 0, broken: 0 })
    expect(json.steps.map((s) => ({ ...s, durationMs: 0 }))).toMatchInlineSnapshot(`
      [
        {
          "checks": [
            {
              "data": {
                "required": ">=20.9.0",
                "version": "22.1.0",
              },
              "detail": "v22.1.0 (>= 20.9.0)",
              "id": "preflight.node",
              "status": "ok",
              "title": "Node.js",
            },
            {
              "data": {
                "arch": "arm64",
                "platform": "darwin",
              },
              "detail": "darwin/arm64",
              "id": "preflight.os",
              "status": "ok",
              "title": "Operating system",
            },
            {
              "data": {
                "installed": "1.0.0",
                "latest": "1.0.0",
              },
              "detail": "1.0.0 (latest)",
              "id": "preflight.cli-version",
              "status": "ok",
              "title": "CLI version",
            },
            {
              "data": {
                "path": "/home/tester/.agentproto",
              },
              "detail": "~/.agentproto is writable",
              "id": "preflight.home",
              "status": "ok",
              "title": "State directory",
            },
            {
              "data": {
                "available": true,
              },
              "detail": "available (node-pty)",
              "id": "preflight.terminal",
              "status": "ok",
              "title": "Terminal sessions",
            },
          ],
          "durationMs": 0,
          "id": "preflight",
          "required": true,
          "title": "Preflight",
        },
      ]
    `)
    expect(h.out()).not.toMatch(ANSI)
  })

  it("--skip drops steps; unknown step ids exit 2", async () => {
    const h = harness()
    await runDoctor(["--json", "--skip", "agents", "--skip", "skills"], h.deps)
    const json: DoctorJson = JSON.parse(h.out())
    expect(json.steps.map((s) => s.id)).toEqual([
      "preflight",
      "workspace",
      "daemon",
      "connect-machines",
      "auth",
      "clients",
      "devices",
      "rendezvous",
      "apps",
      "local-models",
      "llm-gateway",
    ])

    const bad = harness()
    expect(await runDoctor(["--only", "nope"], bad.deps)).toBe(2)
    expect(bad.err()).toContain("unknown step(s): nope")
  })

  it("--help prints usage and exits 0", async () => {
    const h = harness()
    expect(await runDoctor(["--help"], h.deps)).toBe(0)
    expect(h.out()).toContain("agentproto doctor [--json]")
  })
})

describe("agentproto doctor --fix", () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doctor-fix-"))
    file = join(dir, "settings.json")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function fixHarness() {
    const h = harness()
    return { ...h, deps: { ...h.deps, claudeSettingsFile: file } }
  }
  const backups = () => readdirSync(dir).filter((f) => f.includes(".bak-"))

  it("adds crossSessionInbound accept, keeps every other key, backs up, prints the diff", async () => {
    const original = { theme: "dark", permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [] } }
    writeFileSync(file, JSON.stringify(original, null, 2))
    const h = fixHarness()
    expect(await runDoctor(["--fix"], h.deps)).toBe(0)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...original, crossSessionInbound: "accept" })
    expect(backups()).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(dir, backups()[0]!), "utf8"))).toEqual(original)
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([])
    expect(h.out()).toContain('+   "crossSessionInbound": "accept"')
    expect(h.out()).toContain("backup:")
  })

  it("is idempotent: a second run changes nothing and makes no second backup", async () => {
    writeFileSync(file, JSON.stringify({ theme: "dark" }))
    await runDoctor(["--fix"], fixHarness().deps)
    const after = readFileSync(file, "utf8")
    const h = fixHarness()
    expect(await runDoctor(["--fix"], h.deps)).toBe(0)
    expect(readFileSync(file, "utf8")).toBe(after)
    expect(backups()).toHaveLength(1)
    expect(h.out()).toContain("nothing changed")
  })

  it("leaves an explicit crossSessionInbound value alone", async () => {
    const text = JSON.stringify({ crossSessionInbound: "refuse" })
    writeFileSync(file, text)
    expect(await runDoctor(["--fix"], fixHarness().deps)).toBe(0)
    expect(readFileSync(file, "utf8")).toBe(text)
    expect(backups()).toEqual([])
  })

  it("creates the file when it does not exist", async () => {
    expect(await runDoctor(["--fix"], fixHarness().deps)).toBe(0)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ crossSessionInbound: "accept" })
  })

  it("refuses to touch a settings file it cannot parse", async () => {
    writeFileSync(file, "{ // comment\n}")
    const h = fixHarness()
    expect(await runDoctor(["--fix"], h.deps)).toBe(1)
    expect(readFileSync(file, "utf8")).toBe("{ // comment\n}")
    expect(h.out()).toContain("NOT changed")
  })

  it("never writes without --fix", async () => {
    await runDoctor([], fixHarness().deps)
    expect(readdirSync(dir)).toEqual([])
  })

  it("reports the fix in --json", async () => {
    const h = fixHarness()
    await runDoctor(["--json", "--fix"], h.deps)
    const json: DoctorJson = JSON.parse(h.out())
    expect(json.fix).toMatchObject({ file, status: "added" })
  })

  it("the daemon step warns, with the fix, when /health lists a held bypass receiver", async () => {
    const h = harness({
      ctx: {
        health: {
          version: "1.0.0",
          uptimeMs: 65_000,
          pid: 4242,
          warnings: [{ kind: "held-by-receiver-bypass", sessionId: "cc:abc", message: "x" }],
        },
      },
    })
    expect(await runDoctor([], h.deps)).toBe(0)
    expect(h.out()).toContain("! Waking Claude Code sessions in bypassPermissions")
    expect(h.out()).toContain("→ fix: agentproto doctor --fix")
  })
})
