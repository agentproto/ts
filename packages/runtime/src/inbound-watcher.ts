/**
 * InboundWatcher — polls agentpush `poll_inbound` on a timer and
 * spawns one agent per contact_ref that has unread inbound messages.
 *
 * Flow per tick:
 *   mcp_imported_call(alias, "poll_inbound", {source, since:cursor})
 *   → group events by contact_ref
 *   → spawn one agent per contact with prompt from promptTemplate
 *   → advance + persist cursor to ~/.agentproto/agentpush-cursors.json
 *
 * Cursor key = "${alias}:${source}" — stable across daemon restarts so
 * cursor resume actually works (a random watcherId would break it).
 *
 * Prompt template variables: {{source}}, {{contact_ref}},
 *   {{messages_json}}, {{count}}.
 *
 * The mcpServersForChild array is forwarded to the spawned agent's
 * startSession + spawnAgent so the child can call dispatch_request
 * directly on the mounted agentpush MCP server.
 *
 * State is in-memory; cursors persist to disk (debounced async write
 * + sync flush at shutdown), matching the supervisor.ts pattern.
 */

import { randomUUID } from "node:crypto"
import { resolve, dirname } from "node:path"
import { homedir } from "node:os"
import { mkdirSync, writeFileSync, readFileSync, promises as fsp } from "node:fs"
import type { McpProxyRegistry } from "./mcp-proxy.js"
import type { SessionsRegistry } from "./sessions.js"
import type { AgentAdapterResolver } from "./http-server.js"

// ── Types ─────────────────────────────────────────────────────────────

export interface WatcherStartInput {
  /** Imported MCP alias (e.g. "agentpush"). */
  alias: string
  /** Contact ref / channel to watch — forwarded as `source` to poll_inbound. */
  source: string
  /** Agent adapter slug (e.g. "claude-code"). */
  adapter: string
  /**
   * Prompt template with placeholders:
   *   {{source}}        — the watched source
   *   {{contact_ref}}   — the sender's contact_ref
   *   {{messages_json}} — JSON array of the new events
   *   {{count}}         — number of new messages
   */
  promptTemplate: string
  /** Poll interval in ms. Default 5 000. */
  pollIntervalMs?: number
  /** Working directory for spawned agents. Default process.cwd(). */
  cwd?: string
  /** Optional label suffix on spawned sessions. */
  label?: string
  /**
   * MCP servers to mount in the child agent at spawn time.
   * Pass agentpush here so the child can call dispatch_request.
   */
  mcpServersForChild?: Array<{
    name: string
    transport: "stdio" | "http" | "sse"
    ref?: string
  }>
}

export interface WatcherDescriptor {
  watcherId: string
  alias: string
  source: string
  adapter: string
  pollIntervalMs: number
  status: "running" | "stopped"
  /** Next `since` value for poll_inbound (exclusive lower bound). */
  cursor: number
  lastPollAt?: string
  lastFireAt?: string
  /** Total agent sessions spawned since the watcher started. */
  spawned: number
}

export interface InboundWatcher {
  start(input: WatcherStartInput): WatcherDescriptor
  /** Returns false when watcherId is unknown. */
  stop(watcherId: string): boolean
  list(): WatcherDescriptor[]
  /** Stops all watchers and flushes cursor state to disk synchronously. */
  shutdown(): void
}

// ── Internal ─────────────────────────────────────────────────────────

interface InboundEvent {
  timestamp?: number
  contact_ref?: string
  [key: string]: unknown
}

interface WatcherState {
  readonly watcherId: string
  readonly input: {
    alias: string
    source: string
    adapter: string
    promptTemplate: string
    pollIntervalMs: number
    cwd: string
    label?: string
    mcpServersForChild?: WatcherStartInput["mcpServersForChild"]
  }
  status: "running" | "stopped"
  cursor: number
  /** True while a poll tick is still in-flight — prevents overlap. */
  inFlight: boolean
  lastPollAt?: string
  lastFireAt?: string
  spawned: number
  timer: ReturnType<typeof setInterval> | null
}

export const CURSORS_FILE_PATH = (): string =>
  resolve(homedir(), ".agentproto", "agentpush-cursors.json")

const PERSIST_DEBOUNCE_MS = 1_500

// ── Factory ───────────────────────────────────────────────────────────

export function createInboundWatcher(opts: {
  mcpProxy: McpProxyRegistry
  registry: SessionsRegistry
  resolveAgentAdapter: AgentAdapterResolver
  /** Override persist path (tests). Implies persist:true unless set explicitly. */
  persistPath?: string
  /** Disable disk persistence entirely (unit tests). Default false. */
  persist?: boolean
}): InboundWatcher {
  const { mcpProxy, registry, resolveAgentAdapter } = opts
  const persistPath = opts.persistPath ?? CURSORS_FILE_PATH()
  const persist = opts.persist ?? opts.persistPath !== undefined
  const watchers = new Map<string, WatcherState>()
  let persistTimer: ReturnType<typeof setTimeout> | null = null

  // ── Cursor persistence (mirrors supervisor.ts pattern) ────────────

  const loadCursors = (): Record<string, number> => {
    try {
      const raw = readFileSync(persistPath, "utf8")
      return JSON.parse(raw) as Record<string, number>
    } catch {
      return {}
    }
  }

  // Cursor key uses alias + source — stable identity that survives
  // daemon restarts (unlike watcherId which is a new UUID per start()).
  const buildSnapshot = (): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const state of watchers.values()) {
      out[`${state.input.alias}:${state.input.source}`] = state.cursor
    }
    return out
  }

  const schedulePersist = (): void => {
    if (!persist) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      void (async () => {
        try {
          const snap = buildSnapshot()
          await fsp.mkdir(dirname(persistPath), { recursive: true })
          await fsp.writeFile(persistPath, JSON.stringify(snap, null, 2) + "\n")
        } catch (err) {
          console.warn(
            `[inbound-watcher] persist failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      })()
    }, PERSIST_DEBOUNCE_MS)
  }

  const flushSync = (): void => {
    if (!persist) return
    try {
      const snap = buildSnapshot()
      mkdirSync(dirname(persistPath), { recursive: true })
      writeFileSync(persistPath, JSON.stringify(snap, null, 2) + "\n")
    } catch {
      // best-effort — never throw in shutdown path
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────

  const renderPrompt = (
    template: string,
    vars: {
      source: string
      contact_ref: string
      messages_json: string
      count: number
    },
  ): string =>
    template
      .replaceAll("{{source}}", vars.source)
      .replaceAll("{{contact_ref}}", vars.contact_ref)
      .replaceAll("{{messages_json}}", vars.messages_json)
      .replaceAll("{{count}}", String(vars.count))

  // ── Agent spawn ───────────────────────────────────────────────────

  const spawnForContact = async (
    state: WatcherState,
    contactRef: string,
    events: InboundEvent[],
  ): Promise<void> => {
    const resolved = await resolveAgentAdapter(state.input.adapter).catch(
      () => null,
    )
    if (!resolved) {
      console.warn(
        `[inbound-watcher:${state.watcherId}] adapter "${state.input.adapter}" not found`,
      )
      return
    }

    const prompt = renderPrompt(state.input.promptTemplate, {
      source: state.input.source,
      contact_ref: contactRef,
      messages_json: JSON.stringify(events),
      count: events.length,
    })

    const mcpServers = state.input.mcpServersForChild

    try {
      const agentSession = await resolved.startSession({
        cwd: state.input.cwd,
        ...(mcpServers ? { mcpServers } : {}),
      })

      const labelParts = ["inbound", state.watcherId, contactRef]
      if (state.input.label) labelParts.push(state.input.label)

      registry.spawnAgent({
        workspaceSlug: "default",
        cwd: state.input.cwd,
        agentSession,
        adapterSlug: state.input.adapter,
        initialPrompt: prompt,
        label: labelParts.join(":"),
        ...(mcpServers ? { mcpServers } : {}),
        ...(resolved.commandPreview
          ? { commandPreview: resolved.commandPreview }
          : {}),
      })

      state.spawned++
      state.lastFireAt = new Date().toISOString()
    } catch (err) {
      console.warn(
        `[inbound-watcher:${state.watcherId}] spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // ── Poll ──────────────────────────────────────────────────────────

  const doPoll = async (state: WatcherState): Promise<void> => {
    if (state.status !== "running") return
    // Anti-race: skip this tick if the previous one hasn't finished yet.
    if (state.inFlight) return
    state.inFlight = true
    state.lastPollAt = new Date().toISOString()

    try {
      const out = await mcpProxy.callTool(state.input.alias, "poll_inbound", {
        source: state.input.source,
        ...(state.cursor > 0 ? { since: state.cursor } : {}),
      })

      if (!out.ok) {
        console.warn(
          `[inbound-watcher:${state.watcherId}] poll_inbound error: ${out.error}`,
        )
        return
      }

      // Unwrap MCP content envelope: { content: [{type:"text", text:"...json..."}] }
      const raw = out.result as {
        content?: Array<{ type: string; text?: string }>
      }
      const text = raw?.content?.find(c => c.type === "text")?.text
      if (!text) return

      let data: { events?: InboundEvent[] }
      try {
        data = JSON.parse(text) as { events?: InboundEvent[] }
      } catch {
        return
      }

      const events = data.events ?? []
      if (events.length === 0) return

      // Advance cursor past the highest timestamp seen (filter is `>= since`
      // so +1 avoids re-delivering the last event on the next tick).
      // Guard against NaN/non-finite values from malformed events.
      const maxTs = events.reduce((m, e) => {
        const ts = typeof e.timestamp === "number" ? e.timestamp : -Infinity
        return Number.isFinite(ts) ? Math.max(m, ts) : m
      }, -Infinity)
      if (Number.isFinite(maxTs) && maxTs >= state.cursor) {
        state.cursor = maxTs + 1
        schedulePersist()
      }

      // Group by contact_ref, spawn one agent per contact
      const byContact = new Map<string, InboundEvent[]>()
      for (const ev of events) {
        const ref = typeof ev.contact_ref === "string" ? ev.contact_ref : "unknown"
        const bucket = byContact.get(ref) ?? []
        bucket.push(ev)
        byContact.set(ref, bucket)
      }

      await Promise.all(
        Array.from(byContact.entries()).map(([ref, evs]) =>
          spawnForContact(state, ref, evs),
        ),
      )
    } finally {
      state.inFlight = false
    }
  }

  // ── Public interface ──────────────────────────────────────────────

  return {
    start(input: WatcherStartInput): WatcherDescriptor {
      const watcherId = randomUUID()
      const pollIntervalMs = input.pollIntervalMs ?? 5_000
      const cwd = input.cwd ?? process.cwd()

      // Restore persisted cursor using the stable alias:source key so
      // a restarted daemon picks up where it left off.
      const savedCursors = loadCursors()

      const state: WatcherState = {
        watcherId,
        input: {
          alias: input.alias,
          source: input.source,
          adapter: input.adapter,
          promptTemplate: input.promptTemplate,
          pollIntervalMs,
          cwd,
          label: input.label,
          mcpServersForChild: input.mcpServersForChild,
        },
        status: "running",
        cursor: savedCursors[`${input.alias}:${input.source}`] ?? 0,
        inFlight: false,
        spawned: 0,
        timer: null,
      }

      state.timer = setInterval(() => {
        void doPoll(state).catch(err => {
          console.warn(
            `[inbound-watcher:${watcherId}] unhandled poll error: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
      }, pollIntervalMs)

      watchers.set(watcherId, state)
      return toDescriptor(state)
    },

    stop(watcherId: string): boolean {
      const state = watchers.get(watcherId)
      if (!state) return false
      if (state.timer) clearInterval(state.timer)
      state.timer = null
      state.status = "stopped"
      return true
    },

    list(): WatcherDescriptor[] {
      return Array.from(watchers.values()).map(toDescriptor)
    },

    shutdown(): void {
      for (const state of watchers.values()) {
        if (state.timer) clearInterval(state.timer)
        state.timer = null
        state.status = "stopped"
      }
      if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      flushSync()
    },
  }
}

function toDescriptor(state: WatcherState): WatcherDescriptor {
  return {
    watcherId: state.watcherId,
    alias: state.input.alias,
    source: state.input.source,
    adapter: state.input.adapter,
    pollIntervalMs: state.input.pollIntervalMs,
    status: state.status,
    cursor: state.cursor,
    lastPollAt: state.lastPollAt,
    lastFireAt: state.lastFireAt,
    spawned: state.spawned,
  }
}
