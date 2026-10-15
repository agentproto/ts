/**
 * Tests for `buildGitEnv` — the token must reach git through the
 * `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` mechanism
 * (git does NOT implement `GIT_HTTP_EXTRAHEADER`), and must never appear
 * on the command line. Includes a hermetic real-git assertion: the env is
 * consumable by git via `git config --get-all` with no network and no
 * working tree.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { buildGitEnv, realGitRunner } from "../git.js"

const TOKEN = "test-token-not-real"

const expectedHeader = `Authorization: Basic ${btoa(`x-access-token:${TOKEN}`)}`

describe("buildGitEnv", () => {
  it("sets the GIT_CONFIG_* triple and GIT_TERMINAL_PROMPT", () => {
    const env = buildGitEnv({ PATH: process.env.PATH ?? "" }, TOKEN)
    expect(env.GIT_CONFIG_COUNT).toBe("1")
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader")
    expect(env.GIT_CONFIG_VALUE_0).toBe(expectedHeader)
    expect(env.GIT_TERMINAL_PROMPT).toBe("0")
  })

  it("does NOT set GIT_HTTP_EXTRAHEADER (git never implemented it)", () => {
    const env = buildGitEnv({}, TOKEN)
    expect(env.GIT_HTTP_EXTRAHEADER).toBeUndefined()
  })

  it("carries the base env through", () => {
    const env = buildGitEnv({ httpHeaderProbe: "kept" }, TOKEN)
    expect(env.httpHeaderProbe).toBe("kept")
  })

  it("throws on an empty token", () => {
    expect(() => buildGitEnv({}, "")).toThrow(/empty token/)
  })

  it("is consumable by real git via `git config --get-all`", () => {
    const dir = mkdtempSync(join(tmpdir(), "buildgitenv-"))
    try {
      const env = buildGitEnv({ GIT_CONFIG_SYSTEM: "" }, TOKEN)
      const res = realGitRunner(["config", "--get-all", "http.https://github.com/.extraheader"], {
        cwd: dir,
        env,
      })
      expect(res.ok).toBe(true)
      expect(res.stdout.trim()).toBe(expectedHeader)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
