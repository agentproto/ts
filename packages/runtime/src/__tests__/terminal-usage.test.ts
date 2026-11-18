import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createTerminalUsageReaders,
  detectClaudeBilling,
  detectCodexBilling,
  normalizeTerminalUsage,
  opencodeBilling,
  paidCostFor,
  parseCodexRolloutUsage,
  readCodexRolloutUsage,
  resetCodexUsageCache,
} from "../terminal-usage.js"

const line = (o: unknown): string => JSON.stringify(o)

const ROLLOUT = [
  line({ type: "session_meta", payload: { id: "01a1f058-8263-79b2-9f8c-b69032793e16", cwd: "/tmp" } }),
  line({ type: "turn_context", payload: { model: "gpt-5.4" } }),
  line({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 400,
          cache_write_input_tokens: 0,
          output_tokens: 50,
          reasoning_output_tokens: 20,
        },
      },
    },
  }),
  line({ type: "turn_context", payload: { model: "gpt-5.5" } }),
  line({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 17742,
          cached_input_tokens: 13184,
          cache_write_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      },
    },
  }),
  // a token_count with null info (rate limits only) must not reset totals
  line({ type: "event_msg", payload: { type: "token_count", info: null } }),
  "not json",
].join("\n")

describe("parseCodexRolloutUsage", () => {
  it("takes the LAST cumulative total, splits cached out of input, keeps the latest model", () => {
    expect(parseCodexRolloutUsage(ROLLOUT)).toEqual({
      model: "gpt-5.5",
      tokensIn: 17742 - 13184,
      tokensOut: 5,
      cacheReadTokens: 13184,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    })
  })

  it("returns null for a rollout with neither tokens nor model, model-only otherwise", () => {
    expect(parseCodexRolloutUsage(line({ type: "session_meta", payload: { id: "x" } }))).toBeNull()
    expect(parseCodexRolloutUsage(line({ type: "turn_context", payload: { model: "m" } }))).toEqual({ model: "m" })
  })
})

describe("readCodexRolloutUsage", () => {
  let home: string
  let prev: string | undefined
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "codex-usage-"))
    prev = process.env.CODEX_HOME
    process.env.CODEX_HOME = home
    resetCodexUsageCache()
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prev
    rmSync(home, { recursive: true, force: true })
  })

  it("finds the rollout by conversation id and tracks appended turns", async () => {
    const id = "01a1f058-8263-79b2-9f8c-b69032793e16"
    const dir = join(home, "sessions", "2026", "11", "18")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `rollout-2026-11-18T10-00-00-${id}.jsonl`)
    writeFileSync(file, ROLLOUT + "\n")
    const first = await readCodexRolloutUsage(id)
    expect(first?.tokensOut).toBe(5)
    expect(first?.model).toBe("gpt-5.5")

    const more = line({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 20000, cached_input_tokens: 15000, output_tokens: 90 } },
      },
    })
    writeFileSync(file, ROLLOUT + "\n" + more + "\n")
    const second = await readCodexRolloutUsage(id)
    expect(second?.tokensOut).toBe(90)
    expect(second?.tokensIn).toBe(5000)
    // The model line is still the latest seen
    expect(second?.model).toBe("gpt-5.5")
  })

  it("returns null for an unknown conversation", async () => {
    expect(await readCodexRolloutUsage("nope")).toBeNull()
  })
})

describe("billing classification", () => {
  it("claude: API key env wins; oauthAccount login = subscription; neither = unknown", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-billing-"))
    try {
      expect(detectClaudeBilling({}, home)).toBe("unknown")
      writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "a" } }))
      expect(detectClaudeBilling({}, home)).toBe("subscription")
      expect(detectClaudeBilling({ ANTHROPIC_API_KEY: "sk-x" }, home)).toBe("api-key")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("codex: auth_mode chatgpt = subscription, apikey = api-key", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-billing-"))
    try {
      expect(detectCodexBilling(home)).toBe("unknown")
      writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }))
      expect(detectCodexBilling(home)).toBe("subscription")
      writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "apikey" }))
      expect(detectCodexBilling(home)).toBe("api-key")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("opencode: Go plan = subscription, Zen = api-key, -free = free", () => {
    expect(opencodeBilling("opencode-go/deepseek-v4.1-flash")).toBe("subscription")
    expect(opencodeBilling("opencode/claude-sonnet-5-5")).toBe("api-key")
    expect(opencodeBilling("opencode/big-pickle")).toBe("free")
    expect(opencodeBilling("opencode-go/foo-free")).toBe("free")
    expect(opencodeBilling("anthropic/claude")).toBe("unknown")
    expect(opencodeBilling(undefined)).toBe("unknown")
  })

  it("paidCostFor separates value from what is paid", () => {
    expect(paidCostFor("api-key", 1.5)).toBe(1.5)
    expect(paidCostFor("subscription", 1.5)).toBe(0)
    expect(paidCostFor("free", 1.5)).toBe(0)
    expect(paidCostFor("unknown", 1.5)).toBeUndefined()
    expect(paidCostFor(undefined, 1.5)).toBeUndefined()
    expect(paidCostFor("api-key", undefined)).toBeUndefined()
  })
})

describe("normalizeTerminalUsage / createTerminalUsageReaders", () => {
  it("drops a zero cost sitting next to real tokens, keeps a real or tokenless one", () => {
    expect(normalizeTerminalUsage({ costUsd: 0, tokensIn: 10, tokensOut: 5 })).toEqual({ tokensIn: 10, tokensOut: 5 })
    expect(normalizeTerminalUsage({ costUsd: 0.2, tokensIn: 10 })).toEqual({ costUsd: 0.2, tokensIn: 10 })
    expect(normalizeTerminalUsage({ costUsd: 0 })).toEqual({ costUsd: 0 })
    expect(normalizeTerminalUsage(null)).toBeNull()
  })

  it("tags each harness read with its billing; null stays null", async () => {
    const readers = createTerminalUsageReaders({
      opencode: async () => ({ model: "opencode-go/glm-5.3-flash", costUsd: 0, tokensIn: 100, tokensOut: 10 }),
      hermes: async () => null,
    })
    expect(await readers.opencode!("s", {})).toEqual({
      model: "opencode-go/glm-5.3-flash",
      tokensIn: 100,
      tokensOut: 10,
      billing: "subscription",
    })
    expect(await readers.hermes!("s", {})).toBeNull()
    expect(readers["claude-code"]).toBeUndefined()
    expect(typeof readers.codex).toBe("function")
  })
})
