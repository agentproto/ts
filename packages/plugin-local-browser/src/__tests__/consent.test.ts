import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChromeProfilePort } from "@agentproto/browser-profiles"
import { FullProfileGrantError, NonInteractiveConsentError } from "@agentproto/browser-profiles"
import { describe, expect, it } from "vitest"
import {
  createLocalBrowserConsent,
  grantFullProfileClone,
  LOCAL_BROWSER_SESSION_ID,
  setup,
} from "../index.js"

const fakeChrome: ChromeProfilePort = {
  countByDomain: () => ({ unknown: "fake" }),
  countAll: () => ({ known: 12 }),
  readCookies: () => {
    throw new Error("a full-profile grant never decrypts cookie values")
  },
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "lb-consent-"))
  const cloneDir = join(home, ".agentproto", "chrome-profile")
  const host = createLocalBrowserConsent({ home, chrome: fakeChrome, cloneDir })
  return { home, cloneDir, host, ledgerPath: join(home, ".agentproto", "bureau", "consent.jsonl") }
}

describe("profile clone is an explicit full-profile grant", () => {
  it("setup refuses to clone without a grant, before reading any Chrome state", async () => {
    await expect(setup({ profileDirectory: "Default", skipInstall: true })).rejects.toBeInstanceOf(
      FullProfileGrantError
    )
  })

  it("--yes alone (no full-profile flag reaching the host) is not consent: a non-interactive host refuses", async () => {
    const { host } = await fixture()
    await expect(
      grantFullProfileClone({ host, profile: "Default" })
    ).rejects.toBeInstanceOf(NonInteractiveConsentError)
  })

  it("records a full-profile ledger row and returns the loud warning", async () => {
    const { host, ledgerPath } = await fixture()
    const consent = await grantFullProfileClone({ host, profile: "Default", yes: true })
    expect(consent.warning).toMatch(/^WARNING/)
    expect(consent.proof.isActive()).toBe(true)
    const rows = (await readFile(ledgerPath, "utf8")).trim().split("\n").map(l => JSON.parse(l) as Record<string, unknown>)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ event: "grant", fullProfile: true, sessionId: LOCAL_BROWSER_SESSION_ID })
    expect((await stat(ledgerPath)).mode & 0o777).toBe(0o600)
  })

  it("revoke deletes the clone dir, appends a revoke row, and the proof stops unlocking setup", async () => {
    const { host, cloneDir, ledgerPath } = await fixture()
    const consent = await grantFullProfileClone({ host, profile: "Default", yes: true })
    await mkdir(cloneDir, { recursive: true })
    await writeFile(join(cloneDir, "Cookies"), "clone")
    const res = await host.revoke(consent.grantId)
    expect(res.derived.local).toBe("deleted")
    expect(existsSync(cloneDir)).toBe(false)
    const rows = (await readFile(ledgerPath, "utf8")).trim().split("\n").map(l => JSON.parse(l) as { event: string })
    expect(rows.map(r => r.event)).toEqual(["grant", "revoke"])
    expect(consent.proof.isActive()).toBe(false)
    await expect(
      setup({ profileDirectory: "Default", skipInstall: true, fullProfileGrant: consent.proof })
    ).rejects.toBeInstanceOf(FullProfileGrantError)
  })
})
