/**
 * Usage capture for native-TUI terminal sessions (`kind: "terminal"` PTYs
 * that run a provider's own CLI: `claude`, `codex`, `opencode`, `hermes`).
 *
 * An agent-cli session gets its tokens and cost from ACP `usage_update`
 * frames or the adapter's `readUsage` hook. A PTY has no ACP stream, so
 * nothing reached the descriptor. But every one of these TUIs journals its
 * own usage on disk, and the daemon already links the PTY to that native
 * conversation (`adapterSessionId`, see the conversation-terminal link
 * probe). This module is the glue: a per-harness reader keyed by that id,
 * normalised to `UsageReadResult`, plus a billing classification.
 *
 * Two money figures, never mixed:
 *   - `costUsd` = VALUE at API list price (catalog price x tokens, or the
 *     harness's own cost when it reports a non-zero one). What the usage
 *     would cost on pay-per-token.
 *   - `paidCostUsd` = what the account actually pays for it. Equals
 *     `costUsd` for metered (API key) billing; 0 on a flat-rate
 *     subscription (the marginal cost; the monthly fee is not per session)
 *     and for free models; absent when the billing mode is unknown.
 *
 * Per-harness status: claude-code, codex, opencode and hermes are read.
 * copilot and mistral-vibe write no per-session token journal we can
 * attribute to one PTY, and are not classified as conversation terminals
 * yet (no `CONVERSATION_STORES` entry), so they stay un-captured.
 */

import { createReadStream, existsSync, readFileSync } from "node:fs"
import { open, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { findCodexRolloutFile } from "./transcript-export.js"
import type { UsageBilling, UsageReadContext, UsageReadResult } from "./usage.js"

/** A harness usage reader for one native conversation id. */
export type TerminalUsageReader = (
  adapterSessionId: string,
  ctx: UsageReadContext,
) => Promise<UsageReadResult | null>

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined

// ── codex ──────────────────────────────────────────────────────────────

/**
 * Cumulative usage from a Codex rollout's text. Codex writes
 * `event_msg/token_count` lines whose `info.total_token_usage` is already
 * cumulative for the conversation, so the LAST one wins (no summing).
 * OpenAI semantics: `input_tokens` INCLUDES `cached_input_tokens`; the
 * runtime's `tokensIn` is uncached input only (see `UsageDetail`), so it is
 * split here. `reasoning_output_tokens` is a subset of `output_tokens`. The
 * model is the latest `turn_context.model`.
 */
export function parseCodexRolloutUsage(text: string): UsageReadResult | null {
  let total: Record<string, unknown> | undefined
  let model: string | undefined
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t) continue
    let o: { type?: string; payload?: Record<string, unknown> }
    try {
      o = JSON.parse(t)
    } catch {
      continue
    }
    const p = o.payload
    if (!p || typeof p !== "object") continue
    if (o.type === "turn_context" && typeof p.model === "string") model = p.model
    else if (o.type === "event_msg" && p.type === "token_count") {
      const info = p.info as { total_token_usage?: Record<string, unknown> } | null | undefined
      if (info?.total_token_usage) total = info.total_token_usage
    }
  }
  if (!total) return model ? { model } : null
  const input = num(total.input_tokens)
  const cached = num(total.cached_input_tokens)
  const out: UsageReadResult = {}
  if (model) out.model = model
  if (input !== undefined) out.tokensIn = Math.max(0, input - (cached ?? 0))
  const output = num(total.output_tokens)
  if (output !== undefined) out.tokensOut = output
  if (cached !== undefined) out.cacheReadTokens = cached
  const cw = num(total.cache_write_input_tokens)
  if (cw !== undefined) out.cacheWriteTokens = cw
  const reasoning = num(total.reasoning_output_tokens)
  if (reasoning !== undefined) out.reasoningTokens = reasoning
  return out
}

/** Bytes of a rollout tail read per poll. token_count and turn_context
 *  lines recur every turn, so the tail holds the latest of each. */
const CODEX_TAIL_BYTES = 768 * 1024
const CODEX_CACHE_MAX = 64
const codexCache = new Map<string, { size: number; result: UsageReadResult | null }>()

/** Best-effort cumulative usage of a Codex conversation. Never throws. */
export async function readCodexRolloutUsage(
  sessionId: string,
  ctx?: UsageReadContext,
): Promise<UsageReadResult | null> {
  try {
    const file = await findCodexRolloutFile(sessionId, ctx?.configDir)
    if (!file) return null
    const { size } = await stat(file)
    const hit = codexCache.get(file)
    if (hit && hit.size === size) return hit.result
    let text: string
    if (size <= CODEX_TAIL_BYTES) {
      text = await readWhole(file)
    } else {
      const fh = await open(file, "r")
      try {
        const buf = Buffer.alloc(CODEX_TAIL_BYTES)
        await fh.read(buf, 0, CODEX_TAIL_BYTES, size - CODEX_TAIL_BYTES)
        // Drop the first (possibly cut) line.
        const s = buf.toString("utf8")
        text = s.slice(s.indexOf("\n") + 1)
      } finally {
        await fh.close()
      }
    }
    let result = parseCodexRolloutUsage(text)
    // The model line can sit before the tail window: keep the previous one.
    if (result && !result.model && hit?.result?.model) result = { ...result, model: hit.result.model }
    codexCache.set(file, { size, result })
    // Bounded: drop the oldest entry (Map keeps insertion order).
    if (codexCache.size > CODEX_CACHE_MAX) codexCache.delete(codexCache.keys().next().value as string)
    return result
  } catch {
    return null
  }
}

async function readWhole(file: string): Promise<string> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity })
  const lines: string[] = []
  for await (const l of rl) lines.push(l)
  return lines.join("\n")
}

/** Test hook. */
export function resetCodexUsageCache(): void {
  codexCache.clear()
}

// ── billing classification ─────────────────────────────────────────────

/** Billing of a native `claude`: `ANTHROPIC_API_KEY` in the environment
 *  means pay-per-token; otherwise a logged-in Claude account
 *  (`oauthAccount` in `~/.claude.json`) is a subscription. Neither =
 *  unknown. */
export function detectClaudeBilling(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): UsageBilling {
  if (env.ANTHROPIC_API_KEY) return "api-key"
  try {
    const cfg = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as {
      oauthAccount?: unknown
    }
    if (cfg.oauthAccount && typeof cfg.oauthAccount === "object") return "subscription"
  } catch {
    // no login file
  }
  return "unknown"
}

/** Billing of a native `codex`: `auth.json` `auth_mode` is `chatgpt`
 *  (ChatGPT plan, flat rate) or `apikey`. */
export function detectCodexBilling(codexHome?: string): UsageBilling {
  const dir = codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex")
  try {
    const p = join(dir, "auth.json")
    if (!existsSync(p)) return "unknown"
    const a = JSON.parse(readFileSync(p, "utf8")) as { auth_mode?: unknown }
    if (a.auth_mode === "chatgpt") return "subscription"
    if (a.auth_mode === "apikey" || a.auth_mode === "api_key") return "api-key"
  } catch {
    // unreadable
  }
  return "unknown"
}

/** Billing of an opencode model ref `provider/model`: the Go plan is a flat
 *  subscription, Zen is a pay-per-token wallet, a `-free` model is free. */
export function opencodeBilling(model: string | undefined): UsageBilling {
  if (!model) return "unknown"
  if (/-free$|(^|\/)big-pickle$/.test(model)) return "free"
  if (model.startsWith("opencode-go/")) return "subscription"
  if (model.startsWith("opencode/")) return "api-key"
  return "unknown"
}

/** What the account pays for `costUsd` of value under `billing`. */
export function paidCostFor(
  billing: UsageBilling | undefined,
  costUsd: number | undefined,
): number | undefined {
  if (costUsd === undefined || billing === undefined) return undefined
  if (billing === "api-key") return costUsd
  if (billing === "subscription" || billing === "free") return 0
  return undefined
}

// ── composition ────────────────────────────────────────────────────────

/**
 * A reader returning a zero cost next to real tokens is reporting "I did
 * not price this" (opencode on the Go plan), not a measured free session:
 * drop the zero so the catalog prices the tokens.
 */
export function normalizeTerminalUsage(r: UsageReadResult | null): UsageReadResult | null {
  if (!r) return null
  const tokens =
    (r.tokensIn ?? 0) + (r.tokensOut ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0)
  if (r.costUsd === 0 && tokens > 0) {
    const { costUsd: _drop, ...rest } = r
    return rest
  }
  return r
}

/** Harness readers handed in by the CLI (they live in adapter packages the
 *  runtime does not depend on). Codex is read in-runtime. */
export interface TerminalUsageSources {
  "claude-code"?: TerminalUsageReader
  opencode?: TerminalUsageReader
  hermes?: TerminalUsageReader
}

/** The slug → reader table the session manager consumes. */
export function createTerminalUsageReaders(
  sources: TerminalUsageSources,
): Record<string, TerminalUsageReader> {
  const readers: Record<string, TerminalUsageReader> = {}
  const claude = sources["claude-code"]
  if (claude) {
    readers["claude-code"] = async (id, ctx) => {
      const r = normalizeTerminalUsage(await claude(id, ctx))
      return r ? { ...r, billing: detectClaudeBilling() } : null
    }
  }
  const opencode = sources.opencode
  if (opencode) {
    readers.opencode = async (id, ctx) => {
      const r = normalizeTerminalUsage(await opencode(id, ctx))
      return r ? { ...r, billing: opencodeBilling(r.model) } : null
    }
  }
  const hermes = sources.hermes
  if (hermes) {
    readers.hermes = async (id, ctx) => {
      const r = normalizeTerminalUsage(await hermes(id, ctx))
      return r ? { ...r, billing: "unknown" } : null
    }
  }
  readers.codex = async (id, ctx) => {
    const r = await readCodexRolloutUsage(id, ctx)
    return r ? { ...r, billing: detectCodexBilling(ctx.configDir) } : null
  }
  return readers
}
