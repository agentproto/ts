/**
 * The box-login bridge copies the host's Codex login into a box. For a profile
 * with its own login home the copy must come from THAT home's auth.json (never
 * the default one), still redacted, and still land at the box's default path.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { uploadBoxLoginCopy } from "../session-spawn.js"
import type { BoxLoginDecl } from "../box-login-bridge.js"

const DECL: BoxLoginDecl = {
  recipe: "codex",
  keep: ["tokens.access_token", "tokens.id_token", "tokens.account_id", "tokens.refresh_token", "last_refresh"],
}

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "box-login-home-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("uploadBoxLoginCopy: hostLoginHome", () => {
  it("reads <hostLoginHome>/auth.json, redacts the refresh token, writes to the box's default path", async () => {
    const home = join(root, "solo")
    mkdirSync(home)
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        tokens: { access_token: "FAKE-ACCESS", id_token: "a.b.c", account_id: "acct-solo", refresh_token: "FAKE-REFRESH" },
        last_refresh: "2026-11-28T00:00:00Z",
      }),
    )
    const writes: Array<{ path: string; body: string }> = []
    const r = await uploadBoxLoginCopy({
      decl: DECL,
      homeDir: "/box/home",
      hostLoginHome: home,
      writeFile: async (path, data) => {
        writes.push({ path, body: new TextDecoder().decode(data) })
      },
    })
    expect(r.ok).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.path).toBe("/box/home/.codex/auth.json")
    expect(writes[0]!.body).toContain("acct-solo")
    expect(writes[0]!.body).toContain("FAKE-ACCESS")
    expect(writes[0]!.body).not.toContain("FAKE-REFRESH")
  })

  it("an unreadable home degrades (ok: false), never throws, and names no token", async () => {
    const r = await uploadBoxLoginCopy({
      decl: DECL,
      homeDir: "/box/home",
      hostLoginHome: join(root, "missing"),
      writeFile: async () => {},
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/could not be read/)
  })
})
