/**
 * The file/keychain-backed re-login adapters (Claude Code, Codex, Gemini): how
 * each login document is read, which state it yields, and what `verify` can
 * and cannot claim. Fixtures carry fake tokens and example.test identities.
 */

import { afterEach, describe, expect, it } from "vitest"
import { profileAuthStatus, registerReauthAdapter, unregisterReauthAdapter } from "@agentproto/auth"
import { createClaudeCodeReauthAdapter, parseClaudeCodeLogin } from "../reauth/claude-code.js"
import { createCodexReauthAdapter, parseCodexLogin } from "../reauth/codex.js"
import { createGeminiReauthAdapter, parseGeminiLogin } from "../reauth/gemini.js"

// verify() reads the wall clock, so fixtures are relative to it
const NOW = Math.floor(Date.now() / 1000) * 1000
const HOUR = 3_600_000
const jwt = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`

const claudeDoc = (over: Record<string, unknown> = {}) => ({
  claudeAiOauth: { accessToken: "sk-FAKE-claude-1", refreshToken: "rt-FAKE-1", expiresAt: NOW + 48 * HOUR, ...over },
})
const codexDoc = (over: { exp?: number; account_id?: string; refresh?: boolean } = {}) => ({
  tokens: {
    access_token: jwt({ exp: Math.floor((over.exp ?? NOW + 48 * HOUR) / 1000) }),
    ...(over.refresh === false ? {} : { refresh_token: "rt-FAKE-2" }),
    account_id: over.account_id ?? "acct_codex_1",
  },
})
const geminiDoc = (over: Record<string, unknown> = {}) => ({
  access_token: "ya29.FAKE-1",
  refresh_token: "1//FAKE",
  expiry_date: NOW + 48 * HOUR,
  id_token: jwt({ sub: "gem_sub_1" }),
  ...over,
})

describe("login document parsers", () => {
  it("claude: access token expiry in ms, refresh token presence, no account id", () => {
    expect(parseClaudeCodeLogin(claudeDoc())).toMatchObject({ expiresAtMs: NOW + 48 * HOUR, hasRefreshToken: true })
    expect(parseClaudeCodeLogin(JSON.stringify(claudeDoc({ refreshToken: undefined })))).toMatchObject({ hasRefreshToken: false })
    expect(() => parseClaudeCodeLogin({})).toThrow(/accessToken/)
  })
  it("codex: expiry from the JWT exp, account id from the document", () => {
    expect(parseCodexLogin(codexDoc())).toMatchObject({ expiresAtMs: NOW + 48 * HOUR, accountId: "acct_codex_1", hasRefreshToken: true })
    expect(() => parseCodexLogin({ tokens: {} })).toThrow(/access_token/)
  })
  it("gemini: expiry_date in ms, account id from the id_token subject", () => {
    expect(parseGeminiLogin(geminiDoc())).toMatchObject({ expiresAtMs: NOW + 48 * HOUR, accountId: "gem_sub_1", hasRefreshToken: true })
    expect(parseGeminiLogin(geminiDoc({ id_token: "garbage" })).accountId).toBeUndefined()
    expect(() => parseGeminiLogin({})).toThrow(/access_token/)
  })
})

describe("inspect", () => {
  afterEach(() => {
    unregisterReauthAdapter("codex")
    unregisterReauthAdapter("gemini")
  })

  it("claude: an expired access token is expired, because nothing renews it for agentproto", async () => {
    const a = createClaudeCodeReauthAdapter(async () => claudeDoc({ expiresAt: NOW - HOUR }))
    const info = await a.inspect({ source: a.source })
    expect(info).toMatchObject({ loggedIn: true, expiresAtMs: NOW - HOUR })
    expect(info.selfRefreshing).toBeUndefined()
  })
  it("codex and gemini: a refresh token makes the state unknown, with the expiry still shown", async () => {
    for (const make of [
      () => createCodexReauthAdapter(async () => codexDoc({ exp: NOW - HOUR })),
      () => createGeminiReauthAdapter(async () => geminiDoc({ expiry_date: NOW - HOUR })),
    ]) {
      const a = make()
      registerReauthAdapter(a)
      const st = await profileAuthStatus({ id: "p", endpoint: "e", method: "oauth-bearer", source: a.source }, { now: NOW })
      expect(st.state).toBe("unknown")
      expect(st.expiresAt).toBe(new Date(NOW - HOUR).toISOString())
      expect(st.note).toMatch(/renews this access token itself/)
    }
  })
  it("nothing stored, an unreadable or malformed document: not logged in, with the reason", async () => {
    const none = await createCodexReauthAdapter(async () => undefined).inspect({ source: "codex" })
    expect(none).toMatchObject({ loggedIn: false })
    expect(none.note).toMatch(/no Codex login is stored/)
    const bad = await createClaudeCodeReauthAdapter(async () => ({ nope: 1 })).inspect({ source: "claude-code-oauth" })
    expect(bad.loggedIn).toBe(false)
    expect(bad.note).toMatch(/not usable/)
    const boom = await createGeminiReauthAdapter(async () => {
      throw new Error("keychain locked")
    }).inspect({ source: "gemini" })
    expect(boom.note).toMatch(/keychain locked/)
  })
  it("never returns a token", async () => {
    const info = await createClaudeCodeReauthAdapter(async () => claudeDoc()).inspect({ source: "claude-code-oauth" })
    expect(JSON.stringify(info)).not.toContain("sk-FAKE-claude-1")
    expect(JSON.stringify(info)).not.toContain("rt-FAKE-1")
  })
})

describe("plan", () => {
  const target = { source: "x" }
  it("claude and codex delegate to their own CLI login", () => {
    expect(createClaudeCodeReauthAdapter().plan(target, { loggedIn: true })).toMatchObject({ kind: "command", command: "claude", args: ["auth", "login"] })
    expect(createCodexReauthAdapter().plan(target, { loggedIn: true })).toMatchObject({ kind: "command", command: "codex", args: ["login"] })
  })
  it("gemini has no login command: manual instructions", () => {
    const plan = createGeminiReauthAdapter().plan(target, { loggedIn: true })
    expect(plan.kind).toBe("manual")
  })
})

describe("verify", () => {
  const target = { source: "codex" }
  async function run(before: unknown, after: unknown, make = createCodexReauthAdapter) {
    let current = before
    const a = make(async () => current)
    const info = await a.inspect(target)
    current = after
    return a.verify(target, info)
  }

  it("verified: the login was replaced, is for the same account and is not expired", async () => {
    const v = await run(codexDoc({ exp: NOW - HOUR, refresh: false }), codexDoc({ exp: NOW + 72 * HOUR }))
    expect(v.status).toBe("verified")
    expect(v.checked.join("\n")).toMatch(/replaced/)
    expect(v.checked.join("\n")).toMatch(/same account as before/)
  })
  it("always says the provider's acceptance of the new login was not exercised", async () => {
    const v = await run(codexDoc({ exp: NOW - HOUR }), codexDoc({ exp: NOW + 72 * HOUR }))
    expect(v.notChecked.join("\n")).toMatch(/provider accepts the new login/)
  })
  it("failed: nothing changed in the document", async () => {
    const same = codexDoc({ exp: NOW - HOUR })
    const v = await run(same, same)
    expect(v.status).toBe("failed")
    expect(v.problems.join("\n")).toMatch(/did not change/)
  })
  it("failed: the login is for a different account", async () => {
    const v = await run(codexDoc({ exp: NOW - HOUR }), codexDoc({ exp: NOW + 72 * HOUR, account_id: "acct_codex_2" }))
    expect(v.status).toBe("failed")
    expect(v.problems.join("\n")).toMatch(/different account/)
  })
  it("failed: no login is stored afterwards", async () => {
    const v = await run(codexDoc(), undefined)
    expect(v.status).toBe("failed")
  })
  it("failed: a claude login that is still expired afterwards", async () => {
    const v = await run(claudeDoc({ expiresAt: NOW - 2 * HOUR }), claudeDoc({ accessToken: "sk-FAKE-claude-2", expiresAt: NOW - HOUR }), createClaudeCodeReauthAdapter)
    expect(v.status).toBe("failed")
    expect(v.problems.join("\n")).toMatch(/already expired/)
  })
  it("claude carries no account id: says it could not check which account", async () => {
    const v = await run(claudeDoc({ expiresAt: NOW - HOUR }), claudeDoc({ accessToken: "sk-FAKE-claude-2" }), createClaudeCodeReauthAdapter)
    expect(v.status).toBe("verified")
    expect(v.notChecked.join("\n")).toMatch(/which account was meant/)
  })
  it("a first login (none stored before) verifies as new", async () => {
    const v = await run(undefined, geminiDoc(), createGeminiReauthAdapter)
    expect(v.status).toBe("verified")
    expect(v.checked.join("\n")).toMatch(/now exists where none was stored/)
  })
})
