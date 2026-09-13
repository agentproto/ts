/**
 * `agentproto auth profile refresh-models` — driven through the public
 * `runAuth` entrypoint. Thin wrapper tests: the diff/refresh logic itself is
 * exhaustively covered in `@agentproto/auth`'s `profile-provision.test.ts`;
 * these only assert this CLI verb's happy path + its unknown-profile error
 * shape (exit code + surfaced message).
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { addAuthProfile, getAuthProfile } from "@agentproto/auth"
import { getModelsByProvider } from "@agentproto/model-catalog"
import { runAuth } from "../commands/auth.js"

// authProfilesPath() resolves under os.homedir() → $HOME on POSIX (same
// isolation profile-store.test.ts uses) — a temp HOME keeps this off the
// real ~/.agentproto/auth-profiles.json.
let prevHome: string | undefined
let home: string

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-auth-profile-refresh-cli-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = []
  const err: string[] = []
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
    out.push(String(chunk))
    return true
  })
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
    err.push(String(chunk))
    return true
  })
  return { out, err, restore: () => { outSpy.mockRestore(); errSpy.mockRestore() } }
}

describe("agentproto auth profile refresh-models", () => {
  it("re-syncs a mode:\"allow\" profile against the current catalog and reports the diff", async () => {
    await addAuthProfile({
      id: "anthropic-sub",
      endpoint: "anthropic",
      method: "api-key",
      credentialRef: "agentproto.auth.anthropic",
      models: { mode: "allow", ids: ["totally-retired-model"] },
    })
    const currentIds = getModelsByProvider("anthropic").map(m => m.id)

    const { out, restore } = capture()
    const code = await runAuth(["profile", "refresh-models", "anthropic-sub", "--json"])
    restore()

    expect(code).toBe(0)
    const payload = JSON.parse(out.join(""))
    expect(payload.profile.models.mode).toBe("allow")
    expect(new Set(payload.profile.models.ids)).toEqual(new Set(currentIds))
    expect(payload.removed).toContain("totally-retired-model")

    const stored = await getAuthProfile("anthropic-sub")
    expect(new Set(stored?.models?.ids)).toEqual(new Set(currentIds))
  })

  it("exits 1 with a clear message for an unknown profile id", async () => {
    const { err, restore } = capture()
    const code = await runAuth(["profile", "refresh-models", "does-not-exist"])
    restore()

    expect(code).toBe(1)
    expect(err.join("")).toMatch(/no profile with id "does-not-exist"/)
  })
})
