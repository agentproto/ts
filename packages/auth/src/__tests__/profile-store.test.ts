import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  addAuthProfile,
  authProfilesPath,
  getAuthProfile,
  listAuthProfiles,
  loadAuthProfiles,
  removeAuthProfile,
} from "../profile-store.js"

// authProfilesPath() resolves under os.homedir() → $HOME on POSIX, so a temp
// HOME fully isolates these tests (same isolation providers-store's own
// tests use, providers-store/src/__tests__/providers-store.test.ts:17-20).
let prevHome: string | undefined
let home: string

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-auth-profiles-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

describe("auth profile store", () => {
  it("starts empty when no file exists", async () => {
    await expect(listAuthProfiles()).resolves.toEqual([])
    await expect(getAuthProfile("missing")).resolves.toBeUndefined()
  })

  it("add → get round-trips a profile", async () => {
    await addAuthProfile({
      id: "jeremy-max",
      vendor: "anthropic",
      method: "oauth-bearer",
      credentialRef: "keychain:anthropic:jeremy-max",
      label: "Jeremy Max",
    })
    await expect(getAuthProfile("jeremy-max")).resolves.toEqual({
      id: "jeremy-max",
      vendor: "anthropic",
      method: "oauth-bearer",
      credentialRef: "keychain:anthropic:jeremy-max",
      label: "Jeremy Max",
    })
  })

  it("supports N named profiles per vendor", async () => {
    await addAuthProfile({
      id: "jeremy-max",
      vendor: "anthropic",
      method: "oauth-bearer",
      credentialRef: "ref-1",
    })
    await addAuthProfile({
      id: "work-anthropic-key",
      vendor: "anthropic",
      method: "api-key",
      credentialRef: "ref-2",
    })
    await addAuthProfile({
      id: "personal-moonshot",
      vendor: "moonshot",
      method: "api-key",
      credentialRef: "ref-3",
    })

    const anthropicProfiles = await listAuthProfiles("anthropic")
    expect(anthropicProfiles.map(p => p.id).sort()).toEqual([
      "jeremy-max",
      "work-anthropic-key",
    ])
    await expect(listAuthProfiles()).resolves.toHaveLength(3)
  })

  it("add replaces an existing profile with the same id", async () => {
    await addAuthProfile({
      id: "p1",
      vendor: "anthropic",
      method: "api-key",
      credentialRef: "ref-old",
    })
    await addAuthProfile({
      id: "p1",
      vendor: "anthropic",
      method: "oauth-bearer",
      credentialRef: "ref-new",
    })
    await expect(getAuthProfile("p1")).resolves.toEqual({
      id: "p1",
      vendor: "anthropic",
      method: "oauth-bearer",
      credentialRef: "ref-new",
    })
    await expect(listAuthProfiles()).resolves.toHaveLength(1)
  })

  it("remove deletes a profile and reports prior existence", async () => {
    await addAuthProfile({
      id: "p1",
      vendor: "anthropic",
      method: "api-key",
      credentialRef: "ref",
    })
    await expect(removeAuthProfile("p1")).resolves.toBe(true)
    await expect(removeAuthProfile("p1")).resolves.toBe(false)
    await expect(getAuthProfile("p1")).resolves.toBeUndefined()
  })

  it("writes auth-profiles.json with mode 0600", async () => {
    await addAuthProfile({
      id: "p1",
      vendor: "anthropic",
      method: "api-key",
      credentialRef: "ref",
    })
    const { mode } = await stat(authProfilesPath())
    expect(mode & 0o777).toBe(0o600)
  })

  it("never inlines a secret — only credentialRef is stored", async () => {
    await addAuthProfile({
      id: "p1",
      vendor: "anthropic",
      method: "api-key",
      credentialRef: "keychain:anthropic:p1",
    })
    const file = await loadAuthProfiles()
    const raw = JSON.stringify(file)
    expect(raw).toContain("keychain:anthropic:p1")
    expect(raw).not.toMatch(/sk-ant-|sk-or-/)
  })
})
