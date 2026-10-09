import { describe, expect, it, afterEach, beforeEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { composeSpawn, RuntimeConfigError } from "@agentproto/driver-agent-cli"

import { LEAN_INLINE_CONFIG, opencode, readOpenCodeUsage } from "./index.js"

describe("@agentproto/adapter-opencode", () => {
  it("declares a `lean` context mode that drops skills, project instruction files and the global agentproto MCP", () => {
    const lean = (opencode.modes ?? []).find(m => m.id === "lean")
    expect(lean?.kind).toBe("context")
    const composed = composeSpawn(opencode, { mode: "lean" })
    expect(composed.env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("1")
    expect(composed.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1")
    expect(JSON.parse(composed.env.OPENCODE_CONFIG_CONTENT!)).toEqual(LEAN_INLINE_CONFIG)
    expect(LEAN_INLINE_CONFIG.mcp.agentproto.enabled).toBe(false)
  })

  it("declares no other mode (posture and route are not manifest modes)", () => {
    expect((opencode.modes ?? []).map(m => m.id)).toEqual(["lean"])
  })

  it("leaves the spawn env untouched without a mode (full context is the default)", () => {
    const composed = composeSpawn(opencode, {})
    expect(composed.env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBeUndefined()
    expect(composed.env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })
  it("declares model-derived api-key auth", () => {
    expect(opencode.modelDerivedApiKey).toBe(true)
    expect(opencode.routeSelection).toBe("derived-from-model")
  })

  it("declares both the anthropic- and openai-scoped external subscriptions (opencode's own Claude Pro/Max + ChatGPT logins)", () => {
    // External: the runtime injects no bearer (an agentproto-held OAT/access
    // token on opencode's x-api-key channel is rejected upstream) — it
    // verifies the CLI's own `opencode auth login` is present (per provider)
    // and scrubs api-key vars.
    expect(opencode.authSubscription).toEqual([
      { external: true, provider: "anthropic" },
      { external: true, provider: "openai" },
    ])
  })

  it("generates the model menu from the shared catalog for supported providers", () => {
    const allowed = opencode.models?.allowed ?? []
    const ids = allowed.map((entry) =>
      typeof entry === "string" ? entry : entry.id,
    )
    const providers = allowed
      .filter((entry): entry is { id: string; provider: string } =>
        typeof entry !== "string",
      )
      .map((entry) => entry.provider)

    // Anthropic and OpenAI direct prefixes.
    expect(ids).toContain("anthropic/claude-sonnet-4-5")
    expect(ids).toContain("openai/gpt-5")

    // OpenRouter router prefix.
    expect(ids.some((id) => id.startsWith("openrouter/"))).toBe(true)

    // Only supported providers are represented in the generated menu.
    expect(new Set(providers)).toEqual(
      new Set(["anthropic", "openai", "openrouter", "opencode", "opencode-go"]),
    )

    // Groq is still not a billing/auth CatalogProvider (no pricing generator),
    // so there is nothing in the shared catalog to enumerate for it — the
    // free-form `model` option and `models.env` still accept it.
    expect(providers).not.toContain("groq")
  })

  it("offers OpenCode's OWN two hosted endpoints in opencode's reference form", () => {
    const allowed = opencode.models?.allowed ?? []
    const byProvider = (provider: string) =>
      allowed
        .filter(
          (entry): entry is { id: string; provider: string } =>
            typeof entry !== "string" && entry.provider === provider,
        )
        .map((entry) => entry.id)

    // These live only in the generated route tables (deliberately not spread
    // into LLM_PRICING_CATALOG), so they reach the menu via getModelsByProvider.
    // Bounds, not exact counts: the lineups are catalog-synced, and an exact
    // length pin reddens the weekly sync when the roster gains or loses a
    // model — union-alpha moved Go 36 to 37 (cf. #1324/#1328, same pattern).
    const go = byProvider("opencode-go")
    const zen = byProvider("opencode")
    expect(go.length).toBeGreaterThan(30)
    expect(zen.length).toBeGreaterThan(90)

    // `<provider>/<bare-id>` — exactly how opencode's own config addresses
    // them, which is also what `modelIdPrefixProvider` reads to derive the
    // billing endpoint and what opencode expects on the wire. No `@route`
    // annotation may leak into a menu id.
    expect(go).toContain("opencode-go/glm-5.3")
    expect(zen).toContain("opencode/claude-sonnet-4-6")
    expect([...go, ...zen].every((id) => !id.includes("@"))).toBe(true)
    expect(go.every((id) => id.startsWith("opencode-go/"))).toBe(true)
    // A Zen id is never mislabelled as Go: `opencode` must not swallow the
    // `opencode-go/` prefix, or the menu would bill the wrong balance.
    expect(zen.every((id) => id.startsWith("opencode/"))).toBe(true)
  })

  it("keeps a canonical catalog model as the default", () => {
    expect(opencode.models?.default).toBe("anthropic/claude-sonnet-4-5")
  })

  it("has no duplicate model ids in the generated menu", () => {
    const allowed = opencode.models?.allowed ?? []
    const ids = allowed.map((entry) =>
      typeof entry === "string" ? entry : entry.id,
    )
    expect(new Set(ids).size).toBe(ids.length)
  })
})

/**
 * Spawn-time `effort` (the `[unknown_option at config.options.effort]` bug).
 *
 * opencode's ACP server DOES accept `session/set_config_option(configId:
 * "effort")` — but only for models that advertise an `effort` config option
 * (category `thought_level`), and the accepted vocabulary is model-dependent
 * (probed live against `opencode acp` 1.18.x: one reasoning model offered
 * `high | max | default`; `opencode run --variant` help also names `minimal`).
 * Hence a free-form `string`, config-applied, with no argv template — exactly
 * like `model`. Before the fix the manifest declared only `model`, so a
 * generic `agent_start({ effort })` passthrough died at compose time.
 */
describe("@agentproto/adapter-opencode — effort option", () => {
  it("declares effort as a free-form, config-applied string option", () => {
    const effort = opencode.options?.find((o) => o.id === "effort")
    expect(effort).toBeDefined()
    // string (not enum): the vocabulary is model-dependent, so a static enum
    // would reject labels valid for other models this adapter routes to.
    expect(effort?.type).toBe("string")
    expect(effort?.enum).toBeUndefined()
    // Applied via ACP set_config_option, not argv — `opencode acp` has no
    // effort/variant flag (`--variant` is a `run`-subcommand flag).
    expect(effort?.bin_args_template).toBeUndefined()
    expect(effort?.bin_args_prepend).toBeUndefined()
    expect(effort?.description).toMatch(/thought level|effort/i)
  })

  it("accepts an effort value through the driver's spawn composer (no `unknown_option`)", () => {
    const composed = composeSpawn(opencode, { options: { effort: "high" } })
    // Config-applied → the value never leaks into argv.
    expect(composed.binArgs).toEqual(opencode.bin_args)
  })

  it("passes an arbitrary label through rather than rejecting it client-side", () => {
    // The server is the authority on the model's vocabulary; the adapter must
    // not gate it. A label the model doesn't offer is ignored best-effort by
    // the ACP layer, never a spawn failure.
    const composed = composeSpawn(opencode, { options: { effort: "minimal" } })
    expect(composed.binArgs).toEqual(opencode.bin_args)
  })

  it("forwards effort alongside model without disturbing model's config apply", () => {
    const composed = composeSpawn(opencode, {
      options: { model: "openrouter/anthropic/claude-sonnet-4-6", effort: "max" },
    })
    expect(composed.binArgs).toEqual(opencode.bin_args)
  })

  it("rejects a non-string effort value with option_type_mismatch", () => {
    try {
      composeSpawn(opencode, { options: { effort: 5 as unknown as string } })
      throw new Error("expected composeSpawn to throw")
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeConfigError)
      expect((err as RuntimeConfigError).code).toBe("option_type_mismatch")
      expect((err as RuntimeConfigError).path).toBe("config.options.effort")
    }
  })

  it("still rejects a genuinely unknown option id", () => {
    expect(() => composeSpawn(opencode, { options: { bogus: "x" } })).toThrowError(
      /unknown_option/,
    )
  })
})

/**
 * `readOpenCodeUsage` (the `readUsage` hook wired for opencode in serve.ts,
 * mirroring `readHermesUsage`) — session_usage's live ACP `usage_update`
 * event for opencode only ever carries `{used, size, cost}`, no token
 * fields, so tokensIn/tokensOut must come from this reader instead. It
 * reads the same `session` table opencode.db exposes that
 * `exportOpenCodeSession` (in `@agentproto/runtime`'s transcript-export.ts)
 * already reads for `sessions export --json`.
 */
describe("readOpenCodeUsage", () => {
  let tmp: string
  let prevXdgDataHome: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "opencode-usage-test-"))
    prevXdgDataHome = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = tmp
  })

  afterEach(() => {
    if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevXdgDataHome
    rmSync(tmp, { recursive: true, force: true })
  })

  async function seedOpenCodeDb(
    rows: Array<{ id: string; cost?: number; tokens_input?: number; tokens_output?: number }>,
  ): Promise<void> {
    const { mkdirSync } = await import("node:fs")
    const dbDir = join(tmp, "opencode")
    mkdirSync(dbDir, { recursive: true })
    const dbPath = join(dbDir, "opencode.db")
    const sqliteSpecifier = ["node", "sqlite"].join(":")
    const { DatabaseSync } = (await import(sqliteSpecifier)) as unknown as {
      DatabaseSync: new (p: string) => {
        exec(sql: string): void
        prepare(sql: string): { run(...a: unknown[]): void }
        close(): void
      }
    }
    const db = new DatabaseSync(dbPath)
    db.exec(
      "CREATE TABLE session (id TEXT PRIMARY KEY, cost REAL, tokens_input INTEGER, tokens_output INTEGER)",
    )
    const insert = db.prepare(
      "INSERT INTO session (id, cost, tokens_input, tokens_output) VALUES (?, ?, ?, ?)",
    )
    for (const r of rows) {
      insert.run(r.id, r.cost ?? null, r.tokens_input ?? null, r.tokens_output ?? null)
    }
    db.close()
  }

  it("reads cost + tokens for a known session id", async () => {
    await seedOpenCodeDb([{ id: "ses_abc123", cost: 0.0456, tokens_input: 9927, tokens_output: 87 }])
    const usage = await readOpenCodeUsage("ses_abc123")
    expect(usage).toEqual({ costUsd: 0.0456, tokensIn: 9927, tokensOut: 87 })
  })

  it("omits fields that are NULL in the row instead of coercing to 0", async () => {
    await seedOpenCodeDb([{ id: "ses_no_cost_yet", tokens_input: 640, tokens_output: 128 }])
    const usage = await readOpenCodeUsage("ses_no_cost_yet")
    expect(usage).toEqual({ tokensIn: 640, tokensOut: 128 })
  })

  it("reads the cache + reasoning split when the schema has those columns", async () => {
    const dbDir = join(tmp, "opencode")
    const { mkdirSync } = await import("node:fs")
    mkdirSync(dbDir, { recursive: true })
    const sqliteSpecifier = ["node", "sqlite"].join(":")
    const { DatabaseSync } = (await import(sqliteSpecifier)) as unknown as {
      DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void }
    }
    const db = new DatabaseSync(join(dbDir, "opencode.db"))
    db.exec(
      "CREATE TABLE session (id TEXT PRIMARY KEY, cost REAL, tokens_input INTEGER, tokens_output INTEGER, " +
        "tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);" +
        "INSERT INTO session VALUES ('ses_cache', 0.5, 100, 20, 7, 3000, 400);",
    )
    db.close()
    expect(await readOpenCodeUsage("ses_cache")).toEqual({
      costUsd: 0.5,
      tokensIn: 100,
      tokensOut: 20,
      cacheReadTokens: 3000,
      cacheWriteTokens: 400,
      reasoningTokens: 7,
    })
  })

  it("prefers the session's isolated data dir (credentialDataHome) over the global db", async () => {
    await seedOpenCodeDb([{ id: "ses_iso", cost: 9, tokens_input: 1, tokens_output: 1 }])
    const { mkdirSync } = await import("node:fs")
    const configDir = join(tmp, "adapter-config", "sess_1")
    const isoDir = join(configDir, "auth-data", "opencode")
    mkdirSync(isoDir, { recursive: true })
    const sqliteSpecifier = ["node", "sqlite"].join(":")
    const { DatabaseSync } = (await import(sqliteSpecifier)) as unknown as {
      DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void }
    }
    const db = new DatabaseSync(join(isoDir, "opencode.db"))
    db.exec(
      "CREATE TABLE session (id TEXT PRIMARY KEY, cost REAL, tokens_input INTEGER, tokens_output INTEGER);" +
        "INSERT INTO session VALUES ('ses_iso', 0, 140903, 5);",
    )
    db.close()
    expect(await readOpenCodeUsage("ses_iso", { configDir })).toEqual({
      costUsd: 0,
      tokensIn: 140903,
      tokensOut: 5,
    })
    // No isolated db yet (ambient spawn) ⇒ the global one.
    expect(await readOpenCodeUsage("ses_iso", { configDir: join(tmp, "nope") })).toMatchObject({ costUsd: 9 })
  })

  it("declares the credential data home so an engaged credential can't be overridden by opencode's stored console login", () => {
    expect(opencode.credentialDataHome).toEqual({ env: "XDG_DATA_HOME" })
  })

  it("returns null when the session id is not found", async () => {
    await seedOpenCodeDb([{ id: "ses_other", cost: 1, tokens_input: 1, tokens_output: 1 }])
    const usage = await readOpenCodeUsage("ses_missing")
    expect(usage).toBeNull()
  })

  it("returns null (never throws) when opencode.db does not exist", async () => {
    const usage = await readOpenCodeUsage("ses_whatever")
    expect(usage).toBeNull()
  })
})
