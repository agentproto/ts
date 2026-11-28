/**
 * Codex login helpers: home resolution (`~`, relative, default), parsing the
 * login document (token, account id, workspace titles from the id-token
 * claim), the workspace-pin check, and that the non-secret description never
 * carries a token.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  checkCodexWorkspacePin,
  codexAuthFilePath,
  describeCodexLogin,
  parseCodexLoginDocument,
  readCodexLogin,
  resolveCodexHome,
} from "../codex-login.js"

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url")
}
function fakeJwt(claims: unknown): string {
  return `${b64url({ alg: "none" })}.${b64url(claims)}.sig`
}
const ID_TOKEN = fakeJwt({
  "https://api.openai.com/auth": {
    chatgpt_account_id: "acct-team",
    organizations: [
      { id: "org-1", is_default: true, role: "owner", title: "Team Space" },
      { id: "org-2", is_default: false, role: "owner", title: "Solo Space" },
    ],
  },
})
const DOC = {
  auth_mode: "chatgpt",
  tokens: { access_token: "SECRET-ACCESS", refresh_token: "SECRET-REFRESH", id_token: ID_TOKEN, account_id: "acct-solo" },
}

describe("resolveCodexHome", () => {
  it("defaults to ~/.codex, honours an absolute CODEX_HOME, expands ~", () => {
    expect(resolveCodexHome(undefined, { home: "/h", env: {} })).toBe("/h/.codex")
    expect(resolveCodexHome(undefined, { home: "/h", env: { CODEX_HOME: "/x/y" } })).toBe("/x/y")
    expect(resolveCodexHome("~/.codex-solo", { home: "/h", env: {} })).toBe("/h/.codex-solo")
    expect(resolveCodexHome("/abs/dir", { home: "/h", env: {} })).toBe("/abs/dir")
  })
  it("rejects a relative path (it would depend on the daemon cwd)", () => {
    expect(() => resolveCodexHome("rel/dir", { home: "/h", env: {} })).toThrow(/absolute/)
  })
  it("builds the auth file path", () => {
    expect(codexAuthFilePath("/h/.codex")).toBe("/h/.codex/auth.json")
  })
})

describe("parseCodexLoginDocument", () => {
  it("reads token, account id and workspace titles", () => {
    const info = parseCodexLoginDocument(JSON.stringify(DOC))
    expect(info?.accessToken).toBe("SECRET-ACCESS")
    expect(info?.accountId).toBe("acct-solo")
    expect(info?.workspaces.map(w => w.title)).toEqual(["Team Space", "Solo Space"])
  })
  it("falls back to the id-token account when tokens.account_id is absent", () => {
    const doc = { tokens: { access_token: "t", id_token: ID_TOKEN } }
    expect(parseCodexLoginDocument(JSON.stringify(doc))?.accountId).toBe("acct-team")
  })
  it("returns undefined for junk or a missing access token", () => {
    expect(parseCodexLoginDocument("not json")).toBeUndefined()
    expect(parseCodexLoginDocument("{}")).toBeUndefined()
    expect(parseCodexLoginDocument(JSON.stringify({ tokens: { access_token: "" } }))).toBeUndefined()
  })
  it("tolerates an unparseable id token", () => {
    const info = parseCodexLoginDocument(JSON.stringify({ tokens: { access_token: "t", id_token: "garbage" } }))
    expect(info?.workspaces).toEqual([])
  })
})

describe("describeCodexLogin", () => {
  it("never carries a token", () => {
    const info = parseCodexLoginDocument(JSON.stringify(DOC))!
    const out = JSON.stringify(describeCodexLogin(info))
    expect(out).not.toContain("SECRET")
    expect(out).toContain("Solo Space")
    expect(out).toContain("acct-solo")
  })
})

describe("checkCodexWorkspacePin", () => {
  const info = parseCodexLoginDocument(JSON.stringify(DOC))!
  it("accepts the active workspace", () => {
    expect(checkCodexWorkspacePin(info, { kind: "workspace", id: "acct-solo" })).toEqual({ ok: true })
  })
  it("refuses another workspace, naming both ids", () => {
    const r = checkCodexWorkspacePin(info, { kind: "workspace", id: "acct-team" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/acct-solo.*acct-team|acct-team.*acct-solo/)
  })
  it("ignores other pin kinds", () => {
    expect(checkCodexWorkspacePin(info, { kind: "org", id: "x" }).ok).toBe(false)
  })
})

describe("readCodexLogin", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-login-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it("reads <home>/auth.json", async () => {
    mkdirSync(join(dir, "h"))
    writeFileSync(join(dir, "h", "auth.json"), JSON.stringify(DOC))
    expect((await readCodexLogin(join(dir, "h")))?.accountId).toBe("acct-solo")
  })
  it("returns undefined when the file is absent", async () => {
    expect(await readCodexLogin(join(dir, "nope"))).toBeUndefined()
  })
})
