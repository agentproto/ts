/**
 * A Codex profile's login: the home it points at must hold a login, and a
 * pinned workspace must match that login's workspace. Fail-loud, with temp
 * homes only (never the real ~/.codex).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AuthProfile } from "@agentproto/auth"
import { resolveCodexProfileLogin } from "../codex-profile-login.js"
import { SubscriptionSourceError } from "../spawn-defaults.js"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codex-profile-login-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function writeLogin(dir: string, accountId: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ tokens: { access_token: "FAKE", refresh_token: "FAKE", id_token: "x.y.z", account_id: accountId } }),
  )
}
const profile = (o: Partial<AuthProfile> = {}): AuthProfile => ({
  id: "codex-solo",
  endpoint: "openai",
  method: "oauth-bearer",
  source: "codex",
  ...o,
})

describe("resolveCodexProfileLogin", () => {
  it("a profile with no codexHome and no pin is untouched (today's behaviour)", async () => {
    expect(await resolveCodexProfileLogin(profile())).toEqual({ handled: false })
  })

  it("a non-codex profile is untouched", async () => {
    expect(await resolveCodexProfileLogin(profile({ source: "claude-code-oauth", codexHome: "/x" }))).toEqual({
      handled: false,
    })
  })

  it("returns the resolved home when the login is there", async () => {
    const home = join(root, "solo")
    writeLogin(home, "acct-solo")
    expect(await resolveCodexProfileLogin(profile({ codexHome: home }))).toEqual({ handled: true, loginHome: home })
  })

  it("fails loud when the home has no login, naming the home but no token", async () => {
    const home = join(root, "empty")
    const err = await resolveCodexProfileLogin(profile({ codexHome: home })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SubscriptionSourceError)
    expect((err as Error).message).toContain(home)
    expect((err as Error).message).toMatch(/codex login/)
  })

  it("accepts a matching workspace pin and refuses a mismatching one", async () => {
    const home = join(root, "solo")
    writeLogin(home, "acct-solo")
    const ok = await resolveCodexProfileLogin(
      profile({ codexHome: home, subaccount: { kind: "workspace", id: "acct-solo" } }),
    )
    expect(ok).toMatchObject({ handled: true, loginHome: home })
    const err = await resolveCodexProfileLogin(
      profile({ codexHome: home, subaccount: { kind: "workspace", id: "acct-team" } }),
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SubscriptionSourceError)
    expect((err as Error).message).toContain("acct-team")
  })

  it("a pin without codexHome checks the default home and sets no loginHome", async () => {
    const home = join(root, "default")
    writeLogin(home, "acct-solo")
    const r = await resolveCodexProfileLogin(profile({ subaccount: { kind: "workspace", id: "acct-solo" } }), {
      env: { CODEX_HOME: home },
    })
    expect(r).toEqual({ handled: true })
  })

  it("a relative codexHome is refused", async () => {
    await expect(resolveCodexProfileLogin(profile({ codexHome: "rel/dir" }))).rejects.toBeInstanceOf(
      SubscriptionSourceError,
    )
  })
})
