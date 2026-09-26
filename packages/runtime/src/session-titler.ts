/**
 * Daemon-side session titler (opt-in) — turns a freshly-completed FIRST turn
 * of an agent-cli session into a prosaic, human sidebar title ("Gate review
 * PR #261 auth-hub") instead of leaving the spawn-slug label
 * (`chat-starter-autoprompt`) or the derived first-sentence `title`.
 *
 * Design (TITLER-BRIEF):
 *   - Trigger: the turn-end pipeline in `sessions.ts` calls
 *     `maybeTitleSession` fire-and-forget at the end of the FIRST completed
 *     turn of a `kind:"agent-cli"` session. The module itself decides
 *     eligibility, so a disabled/failed titler never blocks or fails a turn.
 *   - Idempotence: a session is titled AT MOST ONCE (in-memory guard), and
 *     ONLY when the current label is a spawn default (`chat-starter`,
 *     `chat-starter-autoprompt`, `agentproto`), empty, or identical to the
 *     derived title. A user-created label (`renamedByUser`, `session_rename`)
 *     is never overwritten.
 *   - Title generation: OpenRouter chat completions
 *     (`z-ai/glm-5.2@openrouter` by default, `titler.model` to override) —
 *     the one provider the daemon can reach without an adapter harness.
 *     No key / any failure → local fallback: first non-empty line of the
 *     first user prompt, truncated to 6 whole words.
 *   - Opt-in: `~/.agentproto/config.json` `titler: { enabled: true, model? }`
 *     — DEFAULT OFF, so nothing changes for existing users.
 */

import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { loadConfig } from "./config.js"
import { sessionEventsPath } from "./transcript-writer.js"

/** Default OpenRouter model used to generate titles. */
export const DEFAULT_TITLER_MODEL = "z-ai/glm-5.2@openrouter"

/** Labels `spawnAgent`/chat-starters mint by default — safe to overwrite.
 *  Anything else (a user's `session_rename`, a caller-chosen label) is kept. */
const DEFAULT_LABELS = new Set(["chat-starter", "chat-starter-autoprompt", "agentproto"])

/** Minimum cumulative first-turn transcript length before a title is worth
 *  generating — filters out one-word probes and empty turns. */
const MIN_TURN_CHARS = 200

/** The registry surface the titler needs — structurally satisfied by
 *  `SessionsRegistry` (only `get` + `renameSession`), so tests can stub it. */
export interface TitlerRegistry {
  get(id: string): { kind?: string; label?: string; title?: string; renamedByUser?: boolean } | undefined
  renameSession(id: string, patch: { label?: string | null }): unknown
}

/** The first-turn slice of a session's transcript the titler works from. */
export interface FirstTurnText {
  /** The caller's own ask (the `user-prompt` record's text). */
  userText: string
  /** Assistant text-delta text of the same turn, coalesced. */
  assistantText: string
}

/** Injectable seams — tests stub these; production resolves to the real
 *  OpenRouter call and the real events.jsonl reader. */
export interface MaybeTitleOptions {
  /** Title generator. `undefined`/empty result ⇒ local fallback. */
  generate?: (input: FirstTurnText) => Promise<string | undefined>
  /** First-turn transcript reader. `null` ⇒ nothing to title from. */
  readFirstTurn?: (sessionId: string) => Promise<FirstTurnText | null>
  /** Override the minimum-transcript guard (tests). */
  minChars?: number
}

/** Sessions already title-attempted this daemon process — the once-only
 *  guard. Attempted (not merely succeeded), so a failed LLM call can't
 *  re-fire on every retry of the same first turn. */
const titledSessions = new Set<string>()

/** Read the daemon's `titler` config block. Default OFF — a missing/
 *  malformed block never enables the titler by accident. */
export async function resolveTitlerConfig(): Promise<{ enabled: boolean; model: string }> {
  const cfg = await loadConfig()
  const t = cfg.titler
  return { enabled: t?.enabled === true, model: t?.model ?? DEFAULT_TITLER_MODEL }
}

/** Is this session's current label one the titler may overwrite? */
export function isDefaultLabel(desc: { label?: string; title?: string }): boolean {
  const label = desc.label?.trim() ?? ""
  if (label === "") return true
  if (desc.title !== undefined && label === desc.title) return true
  return DEFAULT_LABELS.has(label)
}

/** Local fallback title: first non-empty line of the first user prompt,
 *  truncated to 6 words — whole words only, never mid-word. */
export function fallbackTitle(userText: string): string {
  const firstLine = userText.split(/\r?\n/).find(l => l.trim().length > 0)?.trim() ?? ""
  return firstLine.split(/\s+/).filter(Boolean).slice(0, 6).join(" ")
}

/** Normalize an LLM reply into a usable title: strip quotes/markup,
 *  collapse whitespace, cap at 8 words. `undefined` when nothing usable. */
export function sanitizeTitle(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const cleaned = raw
    .replace(/[`*_"“”'']/g, "")
    .split(/\r?\n/)[0]
    ?.trim()
  if (!cleaned) return undefined
  const words = cleaned
    .split(/\s+/)
    // Trim trailing punctuation per token ("hub." → "hub"), keep interior
    // punctuation ("#261", "auth-hub"); a separator-only token ("—")
    // collapses away entirely.
    .map(w => w.replace(/[.,;:!?]+$/u, ""))
    .filter(w => /[\p{L}\p{N}]/u.test(w))
    .slice(0, 8)
  const title = words.join(" ")
  return title.length > 0 ? title : undefined
}

/** Read the FIRST turn (`user-prompt` + `text-delta` up to the first
 *  `turn-end`) from the session's durable events.jsonl. `null` when the
 *  transcript is missing/empty — never throws. */
export async function readFirstTurn(sessionId: string): Promise<FirstTurnText | null> {
  let stream: import("node:fs").ReadStream
  try {
    stream = createReadStream(sessionEventsPath(sessionId), { encoding: "utf8" })
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject)
      stream.once("open", resolve)
    })
  } catch {
    return null
  }

  let userText = ""
  let assistantText = ""
  let sawUserPrompt = false
  try {
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let rec: { kind?: string; text?: unknown }
      try {
        rec = JSON.parse(trimmed) as { kind?: string; text?: unknown }
      } catch {
        continue
      }
      if (rec.kind === "user-prompt" && typeof rec.text === "string") {
        userText = rec.text
        sawUserPrompt = true
      } else if (rec.kind === "text-delta" && typeof rec.text === "string") {
        assistantText += rec.text
      } else if (rec.kind === "turn-end") {
        break
      }
    }
  } catch {
    return null
  }
  if (!sawUserPrompt) return null
  return { userText, assistantText }
}

/** Generate a title via OpenRouter chat completions. `undefined` when no
 *  API key is configured or the call fails — the caller falls back. */
export async function generateTitleViaLlm(
  model: string,
  input: FirstTurnText,
): Promise<string | undefined> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) return undefined
  const excerpt = (s: string, n: number): string =>
    s.length <= n ? s : `${s.slice(0, n)}…`
  const body = {
    model,
    max_tokens: 64,
    messages: [
      {
        role: "system",
        content:
          "You write short prosaic titles for agent sessions. Reply with ONLY the title: " +
          "4-8 plain words, no quotes, no punctuation at the end, describing what the " +
          "session is doing.",
      },
      {
        role: "user",
        content:
          `User asked: ${excerpt(input.userText, 2000)}\n` +
          `Assistant worked on: ${excerpt(input.assistantText, 2000)}\n` +
          `Title:`,
      },
    ],
  }
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return undefined
    const parsed = (await res.json()) as {
      choices?: { message?: { content?: unknown } }[]
    }
    const content = parsed.choices?.[0]?.message?.content
    return typeof content === "string" ? content : undefined
  } catch {
    return undefined
  }
}

/**
 * Title a session once, fire-and-forget. Never throws — every failure
 * (config off, not eligible, transcript unreadable, LLM down) degrades to a
 * logged no-op returning `null`. Returns the new title when it renamed.
 */
export async function maybeTitleSession(
  registry: TitlerRegistry,
  sessionId: string,
  opts: MaybeTitleOptions = {},
): Promise<string | null> {
  try {
    // Once-only guard, set BEFORE any await so concurrent turn-ends can't
    // double-fire for the same session.
    if (titledSessions.has(sessionId)) return null
    titledSessions.add(sessionId)

    const desc = registry.get(sessionId)
    if (!desc || desc.kind !== "agent-cli") return null
    // Never overwrite a user-created label — `renamedByUser` is the
    // explicit-rename flag `renameSession` itself stamps.
    if (desc.renamedByUser === true) return null
    if (!isDefaultLabel(desc)) return null

    // Opt-in gate — an injected `generate` (tests, future callers with their
    // own model plumbing) skips the config check; production resolves the
    // `titler` block and stays a no-op while `enabled` is not explicitly true.
    const generate =
      opts.generate ??
      (async (t: FirstTurnText) => {
        const { enabled, model } = await resolveTitlerConfig()
        if (!enabled) return undefined
        return generateTitleViaLlm(model, t)
      })
    if (!opts.generate) {
      const { enabled } = await resolveTitlerConfig()
      if (!enabled) return null
    }

    const read = opts.readFirstTurn ?? readFirstTurn
    const turn = await read(sessionId)
    if (!turn) return null
    const minChars = opts.minChars ?? MIN_TURN_CHARS
    if (turn.userText.length + turn.assistantText.length < minChars) return null

    const generated = sanitizeTitle(await generate(turn))
    const title = generated ?? fallbackTitle(turn.userText)
    if (!title) return null

    registry.renameSession(sessionId, { label: title })
    return title
  } catch (err) {
    console.warn(
      `[session-titler] maybeTitleSession(${sessionId}) failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return null
  }
}

/** Test hook — clear the once-only guard. */
export function resetTitledSessions(): void {
  titledSessions.clear()
}

