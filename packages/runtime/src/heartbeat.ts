/**
 * HEARTBEAT.md autonomy loop.
 *
 * A workspace can ship a `HEARTBEAT.md` at its root. Frontmatter:
 *
 *   schema: heartbeat/v1
 *   agent: <id>           (matches `<workspace>/.agents/<id>/AGENT.md`)
 *   every: "60s"          (Ns | Nm | Nh | Nd; cron support TODO)
 *   enabled: true         (default true; set false to register-but-skip)
 *   conversation: heartbeat-{date}   (templated id; defaults to per-day)
 *
 * Body = the prompt body the agent receives each tick. Reread fresh
 * on every tick so editing HEARTBEAT.md takes effect without restart.
 *
 * Ticks resolve the agent via the injected `buildAgent` callback,
 * call `agent.generate(prompt)`, and append the prompt + reply to a
 * conversation (default: daily-rolling `heartbeat-YYYY-MM-DD`).
 *
 * When the file is missing, frontmatter is invalid, `enabled: false`,
 * or the resolved agent has no usable model — the runner skips the
 * tick silently and emits a `heartbeat-error` event. The daemon
 * stays up.
 */

import matter from "gray-matter"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ConversationStore } from "./conversations.js"
import type { RuntimeEvents } from "./events.js"

export interface HeartbeatAgent {
  generate(prompt: string): Promise<{ text: string }>
}

export interface BuildHeartbeatAgent {
  (id: string): Promise<HeartbeatAgent | null>
}

export interface HeartbeatRunnerOptions {
  workspace: string
  conversations: ConversationStore
  events: RuntimeEvents
  /** Resolves a heartbeat-runnable agent from its workspace id. */
  buildAgent: BuildHeartbeatAgent
  /** Filename inside the workspace root. Default `HEARTBEAT.md`. */
  filename?: string
  /** Skip ticks while this returns false. Default: always true. */
  shouldFire?: () => boolean
  /** Override clock for tests. */
  now?: () => Date
}

export interface HeartbeatRunner {
  /** Start the timer loop. Idempotent. */
  start(): void
  /** Stop the timer loop. Pending ticks finish out. */
  stop(): void
  /** Force-fire one tick now (used by `POST /heartbeat/tick`). */
  fireNow(): Promise<void>
}

interface ParsedHeartbeat {
  agent: string
  everyMs: number
  enabled: boolean
  conversationTemplate: string
  body: string
}

export function startHeartbeat(opts: HeartbeatRunnerOptions): HeartbeatRunner {
  const filename = opts.filename ?? "HEARTBEAT.md"
  const path = join(opts.workspace, filename)
  const now = opts.now ?? (() => new Date())

  let timer: NodeJS.Timeout | null = null
  let currentEveryMs: number | null = null
  let firing = false

  async function load(): Promise<ParsedHeartbeat | null> {
    if (!existsSync(path)) return null
    let source: string
    try {
      source = await readFile(path, "utf8")
    } catch {
      return null
    }
    const parsed = matter(source)
    const fm = parsed.data as Record<string, unknown>
    const agent = typeof fm.agent === "string" ? fm.agent : null
    if (!agent) return null
    const enabled = fm.enabled === undefined ? true : Boolean(fm.enabled)
    const everyRaw = typeof fm.every === "string" ? fm.every : "60s"
    const everyMs = parseDuration(everyRaw)
    if (!everyMs) return null
    const conversationTemplate =
      typeof fm.conversation === "string"
        ? fm.conversation
        : "heartbeat-{date}"
    return {
      agent,
      everyMs,
      enabled,
      conversationTemplate,
      body: parsed.content.trim(),
    }
  }

  async function tick(): Promise<void> {
    if (firing) return
    if (opts.shouldFire && !opts.shouldFire()) return
    firing = true
    let agentId: string | undefined
    try {
      const hb = await load()
      if (!hb || !hb.enabled) return
      agentId = hb.agent
      const agent = await opts.buildAgent(hb.agent)
      if (!agent) {
        opts.events.emit({
          type: "heartbeat-error",
          at: now().toISOString(),
          agent: hb.agent,
          error: `buildAgent('${hb.agent}') returned null`,
        })
        return
      }
      if (!hb.body) {
        opts.events.emit({
          type: "heartbeat-error",
          at: now().toISOString(),
          agent: hb.agent,
          error: "HEARTBEAT.md body is empty",
        })
        return
      }

      const conversationId = expandTemplate(hb.conversationTemplate, now())
      await opts.conversations.open(conversationId, { agent: hb.agent })

      const startedAt = now()
      await opts.conversations.appendTurn(
        conversationId,
        "user",
        hb.body,
        { at: startedAt.toISOString(), attribution: "heartbeat" },
      )
      opts.events.emit({
        type: "conv-turn-appended",
        at: startedAt.toISOString(),
        conversationId,
        role: "user",
        contentPreview: preview(hb.body),
      })

      const t0 = Date.now()
      const reply = await agent.generate(hb.body)
      const durationMs = Date.now() - t0

      const finishedAt = now()
      await opts.conversations.appendTurn(
        conversationId,
        "assistant",
        reply.text,
        { at: finishedAt.toISOString(), attribution: hb.agent },
      )
      opts.events.emit({
        type: "conv-turn-appended",
        at: finishedAt.toISOString(),
        conversationId,
        role: "assistant",
        contentPreview: preview(reply.text),
      })
      opts.events.emit({
        type: "heartbeat-fired",
        at: finishedAt.toISOString(),
        agent: hb.agent,
        conversationId,
        prompt: hb.body,
        reply: reply.text,
        durationMs,
      })

      // Adapt the timer if `every` changed since we started.
      if (currentEveryMs !== null && currentEveryMs !== hb.everyMs) {
        reschedule(hb.everyMs)
      }
    } catch (err) {
      opts.events.emit({
        type: "heartbeat-error",
        at: now().toISOString(),
        agent: agentId,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      firing = false
    }
  }

  function reschedule(everyMs: number): void {
    if (timer) clearInterval(timer)
    currentEveryMs = everyMs
    timer = setInterval(() => {
      void tick()
    }, everyMs)
  }

  return {
    start() {
      if (timer) return
      // Bootstrap interval from the file (or fall back to 60s if
      // unreadable — first real tick will refresh from disk).
      void load().then((hb) => {
        const everyMs = hb?.everyMs ?? 60_000
        reschedule(everyMs)
      })
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
        currentEveryMs = null
      }
    },
    async fireNow() {
      await tick()
    },
  }
}

// ── helpers ──────────────────────────────────────────────────────────

const DURATION_RE = /^(\d+)\s*(s|m|h|d)$/

/**
 * Parse `Ns | Nm | Nh | Nd` into milliseconds. Returns `null` if the
 * string doesn't match. (AIP-41 supports more units, but the daemon's
 * heartbeat sticks to coarse durations to keep ticks observable.)
 */
export function parseDuration(input: string): number | null {
  const trimmed = input.trim()
  const match = trimmed.match(DURATION_RE)
  if (!match) return null
  const n = Number(match[1])
  if (!Number.isFinite(n) || n <= 0) return null
  switch (match[2]) {
    case "s":
      return n * 1_000
    case "m":
      return n * 60_000
    case "h":
      return n * 3_600_000
    case "d":
      return n * 86_400_000
    default:
      return null
  }
}

/**
 * Replace `{date}` with `YYYY-MM-DD` (UTC) in conversation templates.
 * Other tokens pass through unchanged — extend later if needed.
 */
function expandTemplate(template: string, when: Date): string {
  const date = when.toISOString().slice(0, 10)
  return template.replace(/\{date\}/g, date)
}

function preview(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
