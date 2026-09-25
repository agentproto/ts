/**
 * `agentproto doctor` verb — exit codes, `--json` shape, TTY colour rules,
 * flag validation. Runs the real step registry over a fake StepContext.
 */

import { describe, it, expect } from "vitest"
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
    expect(json.summary).toEqual({ ok: 4, warn: 0, missing: 0, broken: 0 })
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
    expect(json.steps.map((s) => s.id)).toEqual(["preflight", "workspace", "daemon", "auth", "clients"])

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
