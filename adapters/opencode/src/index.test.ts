import { describe, expect, it, afterEach, beforeEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { opencode, readOpenCodeUsage } from "./index.js"

describe("@agentproto/adapter-opencode", () => {
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
      new Set(["anthropic", "openai", "openrouter"]),
    )

    // Groq and OpenCode-hosted are not in the shared catalog today, so they do
    // not appear in the generated menu (free-form `model` still accepts them).
    expect(providers).not.toContain("groq")
    expect(providers).not.toContain("opencode")
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
