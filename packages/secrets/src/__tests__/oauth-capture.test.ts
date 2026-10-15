/**
 * The oauth field map + capture flow: recipes carry PATHS (never values), the
 * login document is read only to build the AIP-19 oauth value shape, and the
 * capture command seals it into a local vault entry without ever printing or
 * logging a token value. All fixtures are fake recipes against temp files —
 * nothing here touches a real `~/.claude/.credentials.json` or the Keychain.
 */

import { describe, it, expect, beforeAll, vi, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, statSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  defineProvisionRecipe,
  registerRecipe,
  extractOauthJson,
  readRecipeOauthJson,
  claudeCodeOauthRecipe,
  codexRecipe,
  type OauthFieldMap,
} from "../provision/recipe/index.js"
import { capture, captureCommand } from "../cli.js"
import { unseal } from "../seal/index.js"

const dir = mkdtempSync(join(tmpdir(), "oauth-capture-"))

const CLAUDE_DOC = JSON.stringify({
  claudeAiOauth: {
    accessToken: "at-live-sk-ant-oat01-x",
    refreshToken: "rt-live-1",
    expiresAt: 1790587204596,
  },
})

const CODEX_DOC = JSON.stringify({
  tokens: {
    id_token: "id-live",
    access_token: "at-codex-live",
    refresh_token: "rt-codex-live",
  },
  last_refresh: "2026-10-05T23:52:32.529162Z",
})

beforeAll(() => {
  writeFileSync(join(dir, "claude-creds.json"), CLAUDE_DOC)
  writeFileSync(join(dir, "codex-auth.json"), CODEX_DOC)

  registerRecipe(
    defineProvisionRecipe({
      id: "test-capture",
      description: "fake capture recipe: file source + oauth map",
      methods: [
        {
          id: "oauth",
          source: { file: join(dir, "claude-creds.json") },
          oauth: {
            accessToken: "claudeAiOauth.accessToken",
            refreshToken: "claudeAiOauth.refreshToken",
            expiresAt: "claudeAiOauth.expiresAt",
          },
        },
      ],
    }),
  )

  registerRecipe(
    defineProvisionRecipe({
      id: "test-capture-nologin",
      description: "fake recipe whose only source is an env var (no login file)",
      methods: [{ id: "oauth", source: { env: "TEST_CAPTURE_NOMATCH" } }],
    }),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("extractOauthJson", () => {
  it("maps the full oauth shape and normalizes epoch-ms expiry to ISO", () => {
    const out = extractOauthJson(CLAUDE_DOC, {
      accessToken: "claudeAiOauth.accessToken",
      refreshToken: "claudeAiOauth.refreshToken",
      expiresAt: "claudeAiOauth.expiresAt",
    })
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(parsed["accessToken"]).toBe("at-live-sk-ant-oat01-x")
    expect(parsed["refreshToken"]).toBe("rt-live-1")
    expect(parsed["expiresAt"]).toBe(new Date(1790587204596).toISOString())
  })

  it("omits optional fields the document lacks (codex stores no expiry)", () => {
    const out = extractOauthJson(CODEX_DOC, {
      accessToken: "tokens.access_token",
      refreshToken: "tokens.refresh_token",
    })
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(parsed["accessToken"]).toBe("at-codex-live")
    expect(parsed["refreshToken"]).toBe("rt-codex-live")
    expect("expiresAt" in parsed).toBe(false)
  })

  it("throws when the required accessToken path is missing", () => {
    expect(() =>
      extractOauthJson(CODEX_DOC, { accessToken: "tokens.nope" }),
    ).toThrow(/tokens\.nope/)
  })

  it("throws on a non-JSON document", () => {
    expect(() => extractOauthJson("not json", { accessToken: "a.b" })).toThrow(
      /not valid JSON/,
    )
  })
})

describe("builtin recipes declare oauth maps", () => {
  it("claude-code-oauth has access + refresh + expiry paths", () => {
    expect(claudeCodeOauthRecipe.methods[0]!.oauth).toEqual({
      accessToken: "claudeAiOauth.accessToken",
      refreshToken: "claudeAiOauth.refreshToken",
      expiresAt: "claudeAiOauth.expiresAt",
    })
  })

  it("codex oauth-subscription has access + refresh (CLI stores no expiry)", () => {
    const m = codexRecipe.methods.find(x => x.id === "oauth-subscription")!
    expect(m.oauth).toEqual({
      accessToken: "tokens.access_token",
      refreshToken: "tokens.refresh_token",
    })
  })

  it("rejects a literal value smuggled into an oauth map", () => {
    expect(() =>
      defineProvisionRecipe({
        id: "acme",
        description: "x",
        // @ts-expect-error accessToken must be a string path
        methods: [{ id: "oauth", source: { env: "ACME" }, oauth: { accessToken: 1 } }],
      }),
    ).toThrow()
  })
})

describe("readRecipeOauthJson", () => {
  it("resolves the full oauth shape from the fake provider's file", async () => {
    const out = JSON.parse(
      await readRecipeOauthJson("test-capture", "oauth"),
    ) as Record<string, unknown>
    expect(out["refreshToken"]).toBe("rt-live-1")
  })

  it("fails informatively for a method without an oauth map", async () => {
    await expect(
      readRecipeOauthJson("test-capture-nologin"),
    ).rejects.toThrow(/declares no oauth field map/)
  })
})

describe("capture", () => {
  it("writes a sealed 0600 entry whose content leaks no token value, and prints none", async () => {
    const vaultDir = join(dir, "vault-1")
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true)
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)

    const res = await capture({ provider: "test-capture", vaultDir })

    const entryPath = join(vaultDir, "entries", "test-capture.json")
    expect(res.entryPath).toBe(entryPath)
    expect(existsSync(entryPath)).toBe(true)
    expect(statSync(entryPath).mode & 0o777).toBe(0o600)
    expect(statSync(join(vaultDir, "key.json")).mode & 0o777).toBe(0o600)

    const entryRaw = readFileSync(entryPath, "utf8")
    expect(entryRaw).not.toContain("at-live")
    expect(entryRaw).not.toContain("rt-live")
    const entry = JSON.parse(entryRaw) as {
      sealed: string
      keyId: string
      provider: string
      methodId: string
    }
    expect(entry.provider).toBe("test-capture")
    expect(entry.methodId).toBe("oauth")

    // The sealed blob round-trips: the decrypted oauth shape is intact.
    const keyPair = JSON.parse(
      readFileSync(join(vaultDir, "key.json"), "utf8"),
    ) as { privateKey: string }
    const opened = await unseal(entry.sealed, keyPair.privateKey)
    const shape = JSON.parse(opened) as Record<string, unknown>
    expect(shape["accessToken"]).toBe("at-live-sk-ant-oat01-x")
    expect(shape["refreshToken"]).toBe("rt-live-1")

    // Pointer carries ids only — never a token value; capture() itself
    // prints nothing (captureCommand owns printing).
    expect(res.pointer).toContain("test-capture")
    expect(res.pointer).not.toContain("at-live")
    expect(res.pointer).not.toContain("rt-live")
    expect(stdout.mock.calls.map(c => String(c[0])).join("")).toBe("")
    expect(stderr.mock.calls.map(c => String(c[0])).join("")).toBe("")
  })

  it("re-capture overwrites the entry in place, reusing the same keypair", async () => {
    const vaultDir = join(dir, "vault-1")
    const first = await capture({ provider: "test-capture", vaultDir })
    const second = await capture({ provider: "test-capture", vaultDir })
    expect(second.pointer).toBe(first.pointer)
    expect(existsSync(second.entryPath)).toBe(true)
  })

  it("reuses the minted keypair for later captures in the same vault", async () => {
    const vaultDir = join(dir, "vault-2")
    const a = await capture({ provider: "test-capture", vaultDir })
    const keyJson = JSON.parse(
      readFileSync(join(vaultDir, "key.json"), "utf8"),
    ) as { keyId: string }
    const b = await capture({ provider: "test-capture", vaultDir })
    expect(b.pointer).toContain(keyJson.keyId.slice(0, 12))
    expect(b.pointer).toBe(a.pointer)
  })
})

describe("captureCommand (not-logged-in path)", () => {
  it("exit 1 + login guidance on stderr; stdout stays empty (never a token)", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true)
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    const rc = await captureCommand({ provider: "test-capture-nologin" })
    expect(rc).toBe(1)
    const printed = stderr.mock.calls.map(c => String(c[0])).join("")
    expect(printed).toContain("login")
    expect(stdout.mock.calls.map(c => String(c[0])).join("")).toBe("")
  })

  it("exit 0 and prints the capability pointer — never a token value", async () => {
    const vaultDir = join(dir, "vault-cmd")
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true)
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    const rc = await captureCommand({ provider: "test-capture", vaultDir })
    expect(rc).toBe(0)
    const printed = stdout.mock.calls.map(c => String(c[0])).join("")
    expect(printed).toContain("agentproto-secrets://vault/test-capture?method=oauth&key=")
    expect(printed).not.toContain("at-live")
    expect(printed).not.toContain("rt-live")
    expect(stderr.mock.calls.map(c => String(c[0])).join("")).toBe("")
  })
})
