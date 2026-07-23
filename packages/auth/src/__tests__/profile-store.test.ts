import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
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
      endpoint: "anthropic",
      method: "oauth-bearer",
      credentialRef: "keychain:anthropic:jeremy-max",
      label: "Jeremy Max",
    })
    await expect(getAuthProfile("jeremy-max")).resolves.toEqual({
      id: "jeremy-max",
      endpoint: "anthropic",
      method: "oauth-bearer",
      credentialRef: "keychain:anthropic:jeremy-max",
      label: "Jeremy Max",
    })
    // The public TypeScript shape is endpoint-based, but v1 disk data keeps
    // `vendor` so hand-written config and older external scripts remain valid.
    const disk = JSON.parse(await readFile(authProfilesPath(), "utf8"))
    expect(disk.profiles["jeremy-max"]).toMatchObject({ vendor: "anthropic" })
    expect(disk.profiles["jeremy-max"]).not.toHaveProperty("endpoint")
  })

  it("supports N named profiles per endpoint", async () => {
    await addAuthProfile({
      id: "jeremy-max",
      endpoint: "anthropic",
      method: "oauth-bearer",
      credentialRef: "ref-1",
    })
    await addAuthProfile({
      id: "work-anthropic-key",
      endpoint: "anthropic",
      method: "api-key",
      credentialRef: "ref-2",
    })
    await addAuthProfile({
      id: "personal-moonshot",
      endpoint: "moonshot",
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
      endpoint: "anthropic",
      method: "api-key",
      credentialRef: "ref-old",
    })
    await addAuthProfile({
      id: "p1",
      endpoint: "anthropic",
      method: "oauth-bearer",
      credentialRef: "ref-new",
    })
    await expect(getAuthProfile("p1")).resolves.toEqual({
      id: "p1",
      endpoint: "anthropic",
      method: "oauth-bearer",
      credentialRef: "ref-new",
    })
    await expect(listAuthProfiles()).resolves.toHaveLength(1)
  })

  it("remove deletes a profile and reports prior existence", async () => {
    await addAuthProfile({
      id: "p1",
      endpoint: "anthropic",
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
      endpoint: "anthropic",
      method: "api-key",
      credentialRef: "ref",
    })
    const { mode } = await stat(authProfilesPath())
    expect(mode & 0o777).toBe(0o600)
  })

  it("round-trips the additive `disabled` + `models` fields (WS2/WS3)", async () => {
    await addAuthProfile({
      id: "curated",
      endpoint: "anthropic",
      method: "api-key",
      credentialRef: "ref",
      disabled: true,
      models: { mode: "allow", ids: ["anthropic/claude-opus-4-8"] },
    })
    await expect(getAuthProfile("curated")).resolves.toEqual({
      id: "curated",
      endpoint: "anthropic",
      method: "api-key",
      credentialRef: "ref",
      disabled: true,
      models: { mode: "allow", ids: ["anthropic/claude-opus-4-8"] },
    })
    // On disk the fields sit alongside the `vendor` alias, unencrypted metadata.
    const disk = JSON.parse(await readFile(authProfilesPath(), "utf8"))
    expect(disk.profiles["curated"]).toMatchObject({
      vendor: "anthropic",
      disabled: true,
      models: { mode: "allow", ids: ["anthropic/claude-opus-4-8"] },
    })
  })

  it("round-trips the additive `origin` provenance field (WS6)", async () => {
    await addAuthProfile({
      id: "imported",
      endpoint: "openrouter",
      method: "api-key",
      credentialRef: "ref",
      origin: "env",
    })
    await expect(getAuthProfile("imported")).resolves.toMatchObject({ origin: "env" })
    const disk = JSON.parse(await readFile(authProfilesPath(), "utf8"))
    expect(disk.profiles["imported"]).toMatchObject({ vendor: "openrouter", origin: "env" })
  })

  it("a profile written without the additive fields stays byte-identical (back-compat)", async () => {
    await addAuthProfile({
      id: "plain",
      endpoint: "anthropic",
      method: "api-key",
      credentialRef: "ref",
    })
    const disk = JSON.parse(await readFile(authProfilesPath(), "utf8"))
    expect(disk.profiles["plain"]).not.toHaveProperty("disabled")
    expect(disk.profiles["plain"]).not.toHaveProperty("models")
    await expect(getAuthProfile("plain")).resolves.toEqual({
      id: "plain",
      endpoint: "anthropic",
      method: "api-key",
      credentialRef: "ref",
    })
  })

  it("never inlines a secret — only credentialRef is stored", async () => {
    await addAuthProfile({
      id: "p1",
      endpoint: "anthropic",
      method: "api-key",
      credentialRef: "keychain:anthropic:p1",
    })
    const file = await loadAuthProfiles()
    const raw = JSON.stringify(file)
    expect(raw).toContain("keychain:anthropic:p1")
    expect(raw).not.toMatch(/sk-ant-|sk-or-/)
  })
})
