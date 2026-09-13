/**
 * Tests for the opt-in `gh` provenance PATH shim (gh-provenance-shim.ts).
 *
 * Two layers:
 *   - PURE units: `parseWrapGh`, `assembleShimPath`, `buildGhShimEnv`,
 *     `loadProvenanceWrapGh` (env > injected config > default), and that the
 *     generated script carries the canonical MARKER + a CommonJS shape.
 *   - BEHAVIOURAL: generate the real shim and drive it against a FAKE `gh`
 *     (a tiny `/bin/sh` script that logs its argv) — no real `gh` needed.
 *     Covers real-gh resolution (scan PATH minus the shim dir), the
 *     `pr create` → parse-URL → PATCH-footer path, exit-code passthrough
 *     (success + failure), non-targeted passthrough, and real-gh absence.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { MARKER } from "../pr-provenance.js"
import { SESSION_ID_ENV, WORKSPACE_SLUG_ENV } from "../sessions.js"
import {
  assembleShimPath,
  buildGhShimEnv,
  DEFAULT_WRAP_GH,
  ensureGhShimDir,
  GH_PROVENANCE_ADAPTER_ENV,
  GH_PROVENANCE_ENABLE_ENV,
  GH_PROVENANCE_MODEL_ENV,
  loadProvenanceWrapGh,
  parseWrapGh,
  PROVENANCE_WRAP_GH_ENV,
  renderGhShimScript,
} from "../gh-provenance-shim.js"

describe("parseWrapGh", () => {
  it("recognises truthy tokens", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " On "]) {
      expect(parseWrapGh(v)).toBe(true)
    }
  })
  it("recognises falsy tokens", () => {
    for (const v of ["0", "false", "no", "off"]) {
      expect(parseWrapGh(v)).toBe(false)
    }
  })
  it("returns undefined for absent / unrecognised", () => {
    expect(parseWrapGh(undefined)).toBeUndefined()
    expect(parseWrapGh("maybe")).toBeUndefined()
  })
})

describe("assembleShimPath", () => {
  it("prepends the shim dir with the platform delimiter", () => {
    expect(assembleShimPath("/shim", `/a${delimiter}/b`)).toBe(`/shim${delimiter}/a${delimiter}/b`)
  })
  it("tolerates an empty base path", () => {
    expect(assembleShimPath("/shim", "")).toBe("/shim")
  })
  it("is idempotent when the shim dir already leads (a re-spawn)", () => {
    const once = assembleShimPath("/shim", `/a${delimiter}/b`)
    expect(assembleShimPath("/shim", once)).toBe(once)
  })
})

describe("buildGhShimEnv", () => {
  it("carries the shimmed PATH, the enable flag, and adapter/model", () => {
    const env = buildGhShimEnv({
      shimDir: "/shim",
      basePath: "/usr/bin",
      adapter: "claude-code",
      model: "opus",
    })
    expect(env.PATH).toBe(`/shim${delimiter}/usr/bin`)
    expect(env[GH_PROVENANCE_ENABLE_ENV]).toBe("1")
    expect(env[GH_PROVENANCE_ADAPTER_ENV]).toBe("claude-code")
    expect(env[GH_PROVENANCE_MODEL_ENV]).toBe("opus")
  })
  it("omits adapter/model when unknown", () => {
    const env = buildGhShimEnv({ shimDir: "/shim", basePath: "/usr/bin" })
    expect(GH_PROVENANCE_ADAPTER_ENV in env).toBe(false)
    expect(GH_PROVENANCE_MODEL_ENV in env).toBe(false)
  })
})

describe("loadProvenanceWrapGh — env > config > default", () => {
  const prior = process.env[PROVENANCE_WRAP_GH_ENV]
  afterEach(() => {
    if (prior === undefined) delete process.env[PROVENANCE_WRAP_GH_ENV]
    else process.env[PROVENANCE_WRAP_GH_ENV] = prior
  })

  it("defaults to off when nothing is configured", async () => {
    delete process.env[PROVENANCE_WRAP_GH_ENV]
    expect(await loadProvenanceWrapGh(async () => ({}))).toBe(DEFAULT_WRAP_GH)
    expect(DEFAULT_WRAP_GH).toBe(false)
  })
  it("reads the config field when set", async () => {
    delete process.env[PROVENANCE_WRAP_GH_ENV]
    expect(await loadProvenanceWrapGh(async () => ({ provenance: { wrapGh: true } }))).toBe(true)
  })
  it("env overrides the config field", async () => {
    process.env[PROVENANCE_WRAP_GH_ENV] = "0"
    expect(await loadProvenanceWrapGh(async () => ({ provenance: { wrapGh: true } }))).toBe(false)
  })
  it("survives an unreadable config", async () => {
    delete process.env[PROVENANCE_WRAP_GH_ENV]
    expect(
      await loadProvenanceWrapGh(async () => {
        throw new Error("boom")
      }),
    ).toBe(DEFAULT_WRAP_GH)
  })
})

describe("renderGhShimScript", () => {
  it("carries the canonical marker, the shebang, and a CommonJS shape", () => {
    const script = renderGhShimScript({ nodePath: "/opt/node" })
    expect(script.startsWith("#!/opt/node\n")).toBe(true)
    expect(script).toContain(MARKER)
    expect(script).toContain('require("node:child_process")')
    // Self-contained: no import/require of this package (only node built-ins).
    expect(script).not.toMatch(/require\((?!"node:)/)
    expect(script).not.toContain("import ")
  })
})

// --- Behavioural: drive the generated shim against a fake gh ------------------

describe("generated shim — behaviour against a fake gh", () => {
  let root: string
  let shimDir: string
  let fakeDir: string
  let ghLog: string

  const PR_URL = "https://github.com/acme/widgets/pull/42"

  /** A `/bin/sh` fake `gh`: logs each arg on its own line + an invocation
   *  separator, prints a PR URL for `pr create`, echoes `$FAKE_GH_BODY` for
   *  `pr view`, and no-ops `api`. Exit code for create is `$FAKE_GH_CREATE_EXIT`. */
  const FAKE_GH = `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> "$FAKE_GH_LOG"; done
printf -- '--INVOCATION--\\n' >> "$FAKE_GH_LOG"
case "$1" in
  pr)
    case "$2" in
      create) printf '%s\\n' "${PR_URL}"; exit "\${FAKE_GH_CREATE_EXIT:-0}";;
      view) printf '%s\\n' "\${FAKE_GH_BODY:-}"; exit 0;;
    esac;;
  api) exit 0;;
esac
exit 0
`

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "gh-shim-"))
    fakeDir = join(root, "bin")
    // ensureGhShimDir writes `<baseDir>/gh` and returns baseDir.
    shimDir = await ensureGhShimDir({
      baseDir: join(root, "shim"),
      nodePath: process.execPath,
    })
    ghLog = join(root, "gh.log")
    mkdirSync(fakeDir, { recursive: true })
    writeFileSync(join(fakeDir, "gh"), FAKE_GH)
    chmodSync(join(fakeDir, "gh"), 0o755)
  })

  function runShim(
    args: string[],
    extraEnv: Record<string, string> = {},
    path = `${shimDir}${delimiter}${fakeDir}`,
  ) {
    return spawnSync(process.execPath, [join(shimDir, "gh"), ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: path,
        FAKE_GH_LOG: ghLog,
        [SESSION_ID_ENV]: "sess-1",
        [WORKSPACE_SLUG_ENV]: "ts",
        [GH_PROVENANCE_ADAPTER_ENV]: "claude-code",
        [GH_PROVENANCE_MODEL_ENV]: "opus",
        ...extraEnv,
      },
    })
  }

  const log = () => (existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "")

  it("resolves the real gh past its own dir and stamps a footer on `pr create`", () => {
    const r = runShim(["pr", "create", "--title", "t", "--body", "b"], {
      FAKE_GH_BODY: "Initial body",
    })
    expect(r.status).toBe(0)
    // gh's own stdout (the PR URL) is passed through.
    expect(r.stdout).toContain(PR_URL)
    const l = log()
    // The follow-up PATCH ran with the footer appended once to the body.
    expect(l).toContain("api")
    expect(l).toContain("PATCH")
    expect(l).toContain("repos/acme/widgets/pulls/42")
    expect(l).toContain(MARKER)
    expect(l).toContain("session `sess-1`")
    expect(l).toContain("model `opus`")
    // Original body preserved ahead of the footer.
    expect(l).toContain("body=Initial body")
  })

  it("does not double-stamp when the body already carries the marker", () => {
    const r = runShim(["pr", "create"], {
      FAKE_GH_BODY: `Body ${MARKER} already`,
    })
    expect(r.status).toBe(0)
    // pr view ran, but the PATCH is skipped — no `api` invocation logged.
    expect(log()).not.toContain("PATCH")
  })

  it("passes the exit code through and skips stamping on a failed create", () => {
    const r = runShim(["pr", "create"], { FAKE_GH_CREATE_EXIT: "3" })
    expect(r.status).toBe(3)
    // exitCode !== 0 → no footer step at all.
    expect(log()).not.toContain("PATCH")
  })

  it("passes non-targeted subcommands straight through (no stamping)", () => {
    const r = runShim(["issue", "list"])
    expect(r.status).toBe(0)
    expect(log()).not.toContain("PATCH")
    // The real gh still ran (the passthrough).
    expect(log()).toContain("issue")
  })

  it("behaves as gh-absent (exit 127) when no real gh is on PATH", () => {
    const r = runShim(["pr", "create"], {}, shimDir)
    expect(r.status).toBe(127)
  })
})
