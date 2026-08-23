/**
 * AIP-45 protocol arm: `protocol: "print"`.
 *
 * Drives a headless CLI as one fresh subprocess per turn — no
 * long-lived ACP connection. Simpler than the ACP arm and immune to
 * the stale-proxy race condition: the session object itself never dies
 * between turns; only the per-turn child does.
 *
 * ## Configuration
 *
 * The adapter's `print` manifest block declares the CLI's one-shot
 * surface (flags, output format, event taxonomy). When the block is
 * absent, Claude Code defaults are applied for backward compatibility.
 *
 * ## Session tracking
 *
 * The `sessionId` property starts empty (or pre-seeded from
 * `resumeSessionId`) and is updated after the first successful turn
 * from the wire event that carries the session / thread identifier
 * (Claude: `result.session_id`; Mastra: `result.threadId`).
 * Subsequent turns pass the appropriate resume flag so the CLI
 * rehydrates the conversation.
 */

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { join } from "node:path"
import type { SandboxMode } from "@agentproto/command-sandbox"
import { toFileBasedMcpServers } from "../mcp-servers.js"
import { wrapAgentCliSpawn } from "../command-sandbox-wrap.js"
import type {
  AcpMcpServer,
  AgentCliPrintConfig,
  AgentCliRuntimeSession,
  StreamEvent,
} from "../types.js"

export interface PrintArmOptions {
  bin: string
  /** Base argv passed to the binary BEFORE print flags and prompt.
   *  Typically permission-mode and model overrides from `composeSpawn`. */
  baseArgs: string[]
  cwd: string
  env: Record<string, string>
  /** Pre-seed from `resumeSessionId` so the first turn reattaches. */
  resumeSessionId?: string
  /** Adapter-declared print surface config. Omit for Claude defaults. */
  printConfig?: AgentCliPrintConfig
  /**
   * MCP servers to mount into the agent's session. For the `mastracode`
   * print arm (`event_schema: "mastra-jsonl"`) these are written to
   * `<cwd>/.mastracode/mcp.json` before the first turn's spawn (the
   * mastracode CLI has no CLI flag / env var / config-dir override for
   * MCP config — this was exhaustively verified against its source) and
   * restored/removed on `close()`. Ignored for other print schemas
   * (e.g. Claude Code), which don't load MCP config from this path.
   */
  mcpServers?: AcpMcpServer[]
  /** OS-level confinement for the per-turn spawn — see
   *  `AgentCliStartOptions.commandSandbox` in `../types.ts` and
   *  `wrapAgentCliSpawn`'s doc for the fail-closed contract. */
  commandSandbox?: SandboxMode
  /** Extra write-capable paths beyond the default toolchain set, e.g. the
   *  per-session `CLAUDE_CONFIG_DIR` temp dir set up by the caller. */
  extraWritePaths?: string[]
  /**
   * The explicitly requested model id — when set, a wire event that
   * truthfully reports which model the agent ACTUALLY started on (today:
   * the jcode-ndjson `start` line's `model` field) is checked against it,
   * and a mismatch aborts the turn loudly (child killed, error event)
   * instead of letting the agent run on a model the operator didn't name.
   * Set by `define-agent-cli.ts` only for `routeSelection:
   * "derived-from-model"` adapters with an explicit `model` option — the
   * print-protocol counterpart of its ACP-arm guard. The bug this closes:
   * jcode's CLI silently falls back to its own default on an unknown
   * `--model` id (observed live: `--model totally-bogus-xyz` →
   * `{"type":"start","model":"gpt-5.6-sol","provider":"OpenAI"}`), which
   * for a derived-from-model adapter is a different provider on a
   * different bill. Schemas that never report the started model are
   * unaffected. Compared via {@link printModelMismatch} (basename,
   * `@suffix`/`provider/`-prefix tolerant).
   */
  expectedModel?: string
}

/**
 * Whether the agent's reported model contradicts the requested one.
 * Compares the model BASENAME (last `/` segment, `@route` suffix stripped,
 * case-insensitive) because the wire echoes a normalized form of the id:
 * jcode reports `deepseek/deepseek-v4-pro` for a requested
 * `deepseek/deepseek-v4-pro@openrouter` — same model, different spelling.
 * Basename equality keeps that a match while still catching a silent
 * default-model fallback (requested `gpt-5` vs reported `gpt-5.6-sol` IS a
 * mismatch — no substring leniency).
 */
export function printModelMismatch(requested: string, reported: string): boolean {
  const basename = (id: string): string => {
    const noSuffix = id.split("@")[0] ?? id
    const segs = noSuffix.split("/")
    return (segs[segs.length - 1] ?? noSuffix).trim().toLowerCase()
  }
  return basename(requested) !== basename(reported)
}

// ── Defaults (Claude Code backward-compatible) ──────────────────────

const DEFAULT_OUTPUT: string[] = ["--output-format", "stream-json"]
const DEFAULT_PRE_PROMPT: string[] = ["--no-interactive"]
const DEFAULT_RESUME = { flag: "--resume", kind: "value" as const }

/** The event taxonomies the print arm knows how to map. Mirrors
 *  `AgentCliPrintConfig.event_schema` (minus the optional/undefined) so the
 *  mapper dispatch and the manifest stay in lockstep. */
type PrintEventSchema = NonNullable<AgentCliPrintConfig["event_schema"]>

export function createPrintSession(
  opts: PrintArmOptions,
): AgentCliRuntimeSession {
  const config = opts.printConfig
  const outputFormat = config?.output_format ?? DEFAULT_OUTPUT
  const prePrompt = config?.pre_prompt ?? DEFAULT_PRE_PROMPT
  const promptFlag = config?.prompt_flag
  const resumeCfg = config?.resume ?? DEFAULT_RESUME
  const eventSchema = config?.event_schema ?? "claude-stream-json"

  let sessionId = opts.resumeSessionId ?? ""
  let activeChild: ReturnType<typeof spawn> | null = null

  // ── MCP server injection (mastracode print arm only) ─────────────
  // The mastracode CLI has no CLI flag, env var, or config-dir override
  // for MCP config (exhaustively verified against its source). The only
  // way to mount host-chosen MCP servers into a print-arm subprocess is
  // to write them into `<cwd>/.mastracode/mcp.json`, which mastracode
  // loads at process startup as its highest-precedence project-scope
  // config. This is done once here (before the first turn's spawn) and
  // restored on close(). Only applies when the adapter is mastracode
  // (`event_schema: "mastra-jsonl"`) — other print adapters (Claude
  // Code) don't read this path.
  const mcpRestore = setupMcpConfigFile(opts, eventSchema)

  return {
    get sessionId(): string {
      return sessionId
    },

    async *send(message: unknown): AsyncIterable<StreamEvent> {
      const prompt = extractPromptText(message)

      // Build argv: baseArgs + output_format + pre_prompt +
      //             resume_flag(+value) + prompt_flag(+text) | positional
      const args: string[] = [
        ...opts.baseArgs,
        ...outputFormat,
        ...prePrompt,
      ]

      // Resume flag
      if (sessionId) {
        args.push(resumeCfg.flag)
        if (resumeCfg.kind === "value") args.push(sessionId)
      }

      // Prompt: flag or positional
      if (promptFlag) {
        args.push(promptFlag, prompt)
      } else {
        args.push(prompt)
      }

      // OS-level confinement — same fail-closed contract as the ACP arm's
      // spawn in `define-agent-cli.ts`; see `wrapAgentCliSpawn`'s doc.
      const [execBin, execArgs] = await wrapAgentCliSpawn(opts.bin, args, {
        mode: opts.commandSandbox,
        cwd: opts.cwd,
        ...(opts.extraWritePaths ? { extraWritePaths: opts.extraWritePaths } : {}),
        label: "print-arm",
      })
      const child = spawn(execBin, execArgs, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
      })
      activeChild = child

      // Attached synchronously, before any `await`/generator suspension
      // below, so a spawn failure (bad binary, PATH miss) is never left
      // as an unhandled 'error' on the child — which would throw and
      // crash the whole daemon process. See the matching guard + incident
      // note in `define-agent-cli.ts`'s ACP spawn.
      let spawnFailure: Error | undefined
      await new Promise<void>(resolve => {
        child.once("spawn", () => resolve())
        child.once("error", err => {
          spawnFailure = err
          resolve()
        })
      })
      if (spawnFailure) {
        activeChild = null
        yield {
          kind: "error",
          error: { message: `failed to spawn '${execBin} ${execArgs.join(" ")}': ${spawnFailure.message}` },
        }
        return
      }

      const stderrLines: string[] = []
      const STDERR_KEEP = 80
      child.stderr?.setEncoding("utf8")
      child.stderr?.on("data", (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (!line) continue
          stderrLines.push(line)
          if (stderrLines.length > STDERR_KEEP) stderrLines.shift()
        }
      })

      try {
        if (!child.stdout)
          throw new Error("print-arm: child has no stdout pipe")

        let capturedSessionId = ""
        const mastraState =
          eventSchema === "mastra-jsonl"
            ? createMastraMapperState()
            : undefined
        const jcodeState =
          eventSchema === "jcode-ndjson"
            ? createJcodeMapperState()
            : undefined

        // ── Decouple pipe draining from downstream consumption ────────
        // A `for await (const line of rl)` loop backpressures onto
        // `child.stdout`: when the loop suspends at a slow downstream
        // consumer (e.g. an SSE write to the orchestrator client that has
        // stopped reading), readline pauses the stream, the child's stdout
        // OS pipe buffer fills, and the child's next `write()` fails with
        // `ENOBUFS` and the process dies. High-volume producers (kimi via
        // mastracode: 900+ tool results / 1200+ lines) hit this reliably.
        //
        // Instead, readline's `"line"` event (flowing mode) drains the
        // pipe CONTINUOUSLY — parsing and mapping each line the instant it
        // arrives — and pushes mapped events into an in-memory queue. The
        // generator below yields from that queue at whatever pace
        // downstream consumes. The child therefore never observes
        // backpressure from a slow client.
        const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
        const queue = new EventQueue()
        let modelMismatchAborted = false

        rl.on("line", (line: string) => {
          if (!line.trim()) return
          if (modelMismatchAborted) return
          let evt: Record<string, unknown>
          try {
            evt = JSON.parse(line) as Record<string, unknown>
          } catch {
            return
          }

          // Derived-from-model guard (see PrintArmOptions.expectedModel):
          // the jcode-ndjson `start` line truthfully names the model the
          // agent actually chose — if that contradicts the explicitly
          // requested one, the CLI silently fell back to its own default.
          // Abort the turn NOW, before the model call completes, instead
          // of running (and billing) a model the operator didn't name.
          if (
            opts.expectedModel &&
            eventSchema === "jcode-ndjson" &&
            evt.type === "start" &&
            typeof evt.model === "string" &&
            printModelMismatch(opts.expectedModel, evt.model)
          ) {
            modelMismatchAborted = true
            const provider =
              typeof evt.provider === "string" ? ` (provider ${evt.provider})` : ""
            queue.push({
              kind: "error",
              error: {
                message:
                  `model mismatch: requested "${opts.expectedModel}" but the agent ` +
                  `started on "${evt.model}"${provider} — its CLI silently fell back ` +
                  `to a default it resolved itself. This adapter routes AND bills by ` +
                  `the model id, so the turn was aborted instead of silently running ` +
                  `(and billing) a model you didn't ask for. Check the id against ` +
                  `the adapter's model menu.`,
              },
            })
            queue.end()
            child.kill("SIGTERM")
            return
          }

          // Capture the session/thread id from the wire event
          const csid = captureSessionId(evt, eventSchema)
          if (csid) capturedSessionId = csid

          const sid = capturedSessionId || sessionId || ""
          const mapped = mapEvent(evt, sid, stderrLines, eventSchema, mastraState, jcodeState)
          // A single wire line can fan out to several StreamEvents — e.g. an
          // Antigravity tool step carries both the call and its result, and its
          // terminal `result` line carries usage + turn-end together.
          if (Array.isArray(mapped)) {
            for (const m of mapped) queue.push(m)
          } else if (mapped) {
            queue.push(mapped)
          }
        })
        rl.once("close", () => queue.end())

        // Yield mapped events as downstream pulls them; the `"line"`
        // handler above keeps draining the pipe regardless of how far
        // behind this loop is.
        for await (const mapped of queue) {
          yield mapped
        }

        const exitCode = await waitForExit(child)
        if (capturedSessionId) sessionId = capturedSessionId

        if (exitCode !== 0 && exitCode !== null) {
          const binLabel =
            eventSchema === "mastra-jsonl"
              ? "mastracode"
              : eventSchema === "antigravity-stream-json"
                ? "agy"
                : eventSchema === "jcode-ndjson"
                  ? "jcode"
                  : "claude"
          const errEvt: StreamEvent = {
            kind: "error",
            error: {
              message: `${binLabel} exited with code ${exitCode}`,
              ...(stderrLines.length
                ? { data: { stderr: stderrLines.join("\n") } }
                : {}),
            },
          }
          yield errEvt
        }
      } finally {
        activeChild = null
      }
    },

    async cancel(): Promise<void> {
      activeChild?.kill("SIGTERM")
    },

    // The print arm spawns a fresh subprocess PER TURN from `baseArgs`,
    // which already has the model baked in (composed once, before this
    // session object was even constructed — see `bin_args_template`
    // handling in define-agent-cli.ts/compose.ts). There is no live
    // connection to apply a mid-session config change to, and rebuilding
    // `baseArgs` would mean a fresh session, not a live switch — so this
    // is honestly `requires-restart`, same as the `arg` model-apply
    // strategy for ACP arms.
    async setModel(): Promise<{ applied: false; reason: string }> {
      return { applied: false, reason: "requires-restart" }
    },

    // No ACP session — no wrapper-advertised capability read-surface and
    // no `session/set_mode` RPC to switch live. Mirrors the "arm has no
    // mid-session config surface" case `define-agent-cli.ts` reports for
    // `setModel` on other arms.
    availableConfigOptions: [],
    availableModes: [],
    currentModeId: undefined,
    async setSessionMode(): Promise<{ applied: false; reason: string }> {
      return { applied: false, reason: "not-supported" }
    },

    // Same as `setSessionMode`: a print arm has no live ACP session to apply
    // `set_config_option(configId:"effort")` against — effort is baked into
    // the spawn argv/env, so a live change is honestly `not-supported`.
    async setEffort(): Promise<{ applied: false; reason: string }> {
      return { applied: false, reason: "not-supported" }
    },

    async close(): Promise<void> {
      activeChild?.kill("SIGTERM")
      mcpRestore?.()
    },
  }
}

// ── MCP config file injection (mastracode print arm) ────────────────

/**
 * Before the first turn's spawn, shallow-merges our injected MCP servers
 * into `<cwd>/.mastracode/mcp.json` (the highest-precedence project-scope
 * config mastracode loads). Returns a restore function that reverts the
 * file to its pre-session state on `close()`, or `undefined` if no
 * injection was performed.
 *
 * Only activates when `eventSchema === "mastra-jsonl"` (mastracode) AND
 * `opts.mcpServers` is non-empty. Other print adapters (Claude Code)
 * don't read this path and are left untouched.
 *
 * Our injected servers win on key collision — this matches mastracode's
 * own "higher precedence overrides lower, by server name" merge
 * semantics, and the SDK's documented "merged with, and overriding,
 * file-based configs" behavior for the in-process arm, so both arms
 * behave consistently.
 *
 * KNOWN LIMITATION: two concurrent mastracode print sessions sharing
 * the SAME `cwd` will race on this read-merge-write (last writer wins
 * on the shared file). This is an upstream mastracode CLI limitation —
 * no config-dir isolation exists to route around it. This is a real but
 * narrow edge case (only matters for concurrent orchestrator children
 * spawned into the identical directory); no locking mechanism is built
 * here, by design.
 */
function setupMcpConfigFile(
  opts: PrintArmOptions,
  eventSchema: PrintEventSchema,
): (() => void) | undefined {
  if (eventSchema !== "mastra-jsonl") return undefined
  if (!opts.mcpServers || opts.mcpServers.length === 0) return undefined

  const dir = join(opts.cwd, ".mastracode")
  const file = join(dir, "mcp.json")
  const injected = toFileBasedMcpServers(opts.mcpServers)
  if (!injected) return undefined

  // Snapshot the pre-session state so close() can restore it.
  const fileExisted = existsSync(file)
  let originalContent: string | undefined
  if (fileExisted) {
    try {
      originalContent = readFileSync(file, "utf8")
    } catch {
      originalContent = undefined
    }
  }
  const dirExisted = existsSync(dir)

  // Ensure `.mastracode/` exists, then read-merge-write.
  if (!dirExisted) {
    mkdirSync(dir, { recursive: true })
  }

  let existingServers: Record<string, unknown> = {}
  if (originalContent !== undefined) {
    try {
      const parsed = JSON.parse(originalContent) as Record<string, unknown>
      if (parsed && typeof parsed.mcpServers === "object" && parsed.mcpServers !== null) {
        existingServers = parsed.mcpServers as Record<string, unknown>
      }
    } catch {
      // Corrupt or unparseable file — start fresh with just our servers.
      existingServers = {}
    }
  }

  // Shallow-merge: our injected servers override on key collision.
  const merged: Record<string, unknown> = { ...existingServers, ...injected }
  const output = JSON.stringify({ mcpServers: merged }, null, 2)
  writeFileSync(file, output, "utf8")

  // Return the restore function.
  return () => {
    try {
      if (!fileExisted) {
        // We created the file — remove it. Also remove the `.mastracode/`
        // dir only if we created that too AND it's now empty (don't
        // rm -rf someone's existing directory).
        rmSync(file, { force: true })
        if (!dirExisted) {
          try {
            // `rmdirSync` (not `rmSync`) — only removes an EMPTY
            // directory, throwing ENOTEMPTY otherwise. `rmSync` without
            // `recursive: true` throws on any directory regardless of
            // contents, which would always land in the catch below and
            // silently leave the directory behind even when empty.
            rmdirSync(dir)
          } catch {
            // Directory not empty (other files were added) — leave it.
          }
        }
      } else if (originalContent !== undefined) {
        // File existed before — restore its original content, but first
        // remove only our injected keys from the merged object so any
        // concurrent changes (if the file was modified externally) are
        // preserved minus our entries. If that produces an empty
        // mcpServers map, restore the original file verbatim.
        let current: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
          if (parsed && typeof parsed.mcpServers === "object" && parsed.mcpServers !== null) {
            current = parsed.mcpServers as Record<string, unknown>
          }
        } catch {
          // Can't read current state — restore original verbatim.
          writeFileSync(file, originalContent, "utf8")
          return
        }
        for (const key of Object.keys(injected)) {
          delete current[key]
        }
        if (Object.keys(current).length === 0) {
          // All servers were ours — restore original file content.
          writeFileSync(file, originalContent, "utf8")
        } else {
          writeFileSync(file, JSON.stringify({ mcpServers: current }, null, 2), "utf8")
        }
      }
    } catch {
      // Best-effort — never throw from close().
    }
  }
}

// ── Prompt extraction ───────────────────────────────────────────────

function extractPromptText(message: unknown): string {
  if (typeof message === "string") return message
  if (message !== null && typeof message === "object") {
    const m = message as Record<string, unknown>
    if (typeof m.text === "string") return m.text
    if (Array.isArray(message)) {
      return (message as Array<Record<string, unknown>>)
        .filter(b => b.type === "text" && typeof b.text === "string")
        .map(b => b.text as string)
        .join("\n")
    }
  }
  return JSON.stringify(message)
}

// ── Session id capture per event schema ─────────────────────────────

function captureSessionId(
  evt: Record<string, unknown>,
  schema: PrintEventSchema,
): string | null {
  switch (schema) {
    case "claude-stream-json":
      if (
        evt.type === "result" &&
        typeof evt.session_id === "string" &&
        evt.session_id
      )
        return evt.session_id
      return null
    case "antigravity-stream-json": {
      // `agy` stamps `conversation_id` on every line, but at two different
      // levels: top-level on the opening `init` event, and nested in the
      // payload on `result`. Capture it from the `init` (available before
      // the turn produces any text — so a mid-turn crash still resumes) and
      // re-confirm it from the authoritative terminal `result`. A pre-flight
      // failure (e.g. unknown --model) emits `result` with an empty
      // conversation_id; the `&& id` guard drops that so we never clobber a
      // good id with "". Verified against antigravity.google/docs/cli/headless.
      if (evt.event === "init" && typeof evt.conversation_id === "string" && evt.conversation_id)
        return evt.conversation_id
      if (evt.event === "result") {
        const r = evt.result as Record<string, unknown> | undefined
        if (typeof r?.conversation_id === "string" && r.conversation_id)
          return r.conversation_id
      }
      return null
    }
    case "mastra-jsonl":
      // Mastra Code writes exactly one authoritative final line per run
      // regardless of success/failure path: { type: "result", threadId,
      // text, finishReason, exitCode, ... }. Reading it here (rather than
      // the incidental om_status event, which only fires when
      // Observational Memory is enabled) guarantees the thread id is
      // captured on every turn.
      if (
        evt.type === "result" &&
        typeof evt.threadId === "string" &&
        evt.threadId
      )
        return evt.threadId
      return null
    case "jcode-ndjson":
      // jcode stamps `session_id` on the opening `start` line (available
      // before any text — so a mid-turn crash still resumes) and again on
      // the terminal `done` line, which re-confirms it.
      if (
        (evt.type === "start" || evt.type === "done") &&
        typeof evt.session_id === "string" &&
        evt.session_id
      )
        return evt.session_id
      return null
  }
}

// ── Event mapping ───────────────────────────────────────────────────

function mapEvent(
  evt: Record<string, unknown>,
  sessionId: string,
  stderrLines: string[],
  schema: PrintEventSchema,
  mastraState?: MastraMapperState,
  jcodeState?: JcodeMapperState,
): StreamEvent | StreamEvent[] | null {
  switch (schema) {
    case "claude-stream-json":
      return mapClaudeEvent(evt, sessionId, stderrLines)
    case "antigravity-stream-json":
      return mapAntigravityEvent(evt, sessionId, stderrLines)
    case "mastra-jsonl": {
      if (!mastraState) {
        // Should never happen — mastra-jsonl schema always creates state
        return mapClaudeEvent(evt, sessionId, stderrLines)
      }
      return mapMastraEvent(evt, sessionId, stderrLines, mastraState)
    }
    case "jcode-ndjson":
      return mapJcodeEvent(evt, sessionId, jcodeState ?? createJcodeMapperState())
    default:
      return mapClaudeEvent(evt, sessionId, stderrLines)
  }
}

// ── Claude Code stream-json mapper ──────────────────────────────────

function mapClaudeEvent(
  evt: Record<string, unknown>,
  sessionId: string,
  stderrLines: string[],
): StreamEvent | null {
  switch (evt.type) {
    case "text":
      return typeof evt.text === "string"
        ? { kind: "text-delta", sessionId, text: evt.text }
        : null

    case "thinking":
      return typeof evt.thinking === "string"
        ? { kind: "thought", sessionId, text: evt.thinking }
        : null

    case "tool_use":
      return {
        kind: "tool-call",
        sessionId,
        toolCallId: typeof evt.id === "string" ? evt.id : "",
        toolName: typeof evt.name === "string" ? evt.name : "?",
        arguments: evt.input ?? {},
      }

    case "tool_result":
      return {
        kind: "tool-result",
        sessionId,
        toolCallId:
          typeof evt.tool_use_id === "string" ? evt.tool_use_id : "",
        result: evt.content ?? null,
        isError: evt.is_error === true,
      }

    case "result":
      if (
        evt.subtype === "error_during_execution" ||
        evt.is_error === true
      ) {
        return {
          kind: "error",
          sessionId,
          error: {
            message:
              typeof evt.error === "string"
                ? evt.error
                : "Unknown error",
            ...(stderrLines.length
              ? { data: { stderr: stderrLines.join("\n") } }
              : {}),
          },
        }
      }
      if (evt.subtype === "success") {
        return { kind: "turn-end", sessionId, reason: "completed" }
      }
      return null

    case "system":
    case "assistant":
      return null

    default:
      return null
  }
}

// ── Google Antigravity stream-json mapper ──────────────────────────

/**
 * Maps a single Google Antigravity (`agy --output-format stream-json`)
 * NDJSON line to this repo's {@link StreamEvent} taxonomy.
 *
 * The wire shape was verified against antigravity.google/docs/cli/headless.
 * Despite `agy` mirroring Claude Code's headless FLAGS (`-p`,
 * `--output-format stream-json`, `--continue`), its EVENTS are a different
 * taxonomy discriminated by an `event` field, not Claude's `type`:
 *
 *   {"event":"init","conversation_id":"…","init":{cwd,tools,permission_mode,…}}
 *   {"event":"step_update","step_update":{conversation_id,step_index,state,
 *       step_type,text_delta?,tool_name?,tool_info?,usage?,…}}
 *   {"event":"result","result":{conversation_id,status,response,error?,usage,…}}
 *
 * - Text streams as INCREMENTAL `step_update.text_delta` fragments on
 *   `agent_response` steps (the docs' own `jq -j … .text_delta` recipe
 *   concatenates them, so fragments never overlap — emit each verbatim, no
 *   accumulation state needed, unlike the Mastra mapper).
 * - A `tool` step's terminal `DONE` carries the call AND its result in one
 *   `tool_info` ({name, parameters, output, error?}). `agy` assigns no tool
 *   call id, so we synthesize one from `step_index` to correlate the pair.
 *   Returning a two-element array fans that single line out to a `tool-call`
 *   + `tool-result` (the print-arm line handler flattens arrays).
 * - The terminal `result` carries the run's total `usage` and its `status`;
 *   we emit a `usage_update` then the terminal `turn-end`/`error`.
 */
function mapAntigravityEvent(
  evt: Record<string, unknown>,
  sessionId: string,
  stderrLines: string[],
): StreamEvent | StreamEvent[] | null {
  switch (evt.event) {
    case "step_update": {
      const su = evt.step_update as Record<string, unknown> | undefined
      if (!su) return null
      const stepType = su.step_type

      // Incremental assistant text.
      if (
        stepType === "agent_response" &&
        typeof su.text_delta === "string" &&
        su.text_delta
      ) {
        return { kind: "text-delta", sessionId, text: su.text_delta }
      }

      // A completed tool step carries the call and its result together.
      // Emit the pair only on DONE; a preceding ACTIVE tool step (if any)
      // is skipped so the call isn't announced twice.
      if (stepType === "tool" && su.state === "DONE") {
        const ti = su.tool_info as Record<string, unknown> | undefined
        const toolName =
          typeof su.tool_name === "string" && su.tool_name
            ? su.tool_name
            : typeof ti?.name === "string" && ti.name
              ? (ti.name as string)
              : "?"
        const toolCallId =
          typeof su.step_index === "number" ? `step-${su.step_index}` : ""
        const err = ti?.error as Record<string, unknown> | undefined
        const call: StreamEvent = {
          kind: "tool-call",
          sessionId,
          toolCallId,
          toolName,
          arguments: ti?.parameters ?? {},
        }
        const result: StreamEvent = {
          kind: "tool-result",
          sessionId,
          toolCallId,
          result: err
            ? typeof err.message === "string"
              ? err.message
              : err
            : (ti?.output ?? null),
          isError: !!err,
        }
        return [call, result]
      }

      // user_input / checkpoint / subagent steps carry no host-facing
      // StreamEvent — skip them (subagents are surfaced by their own run).
      return null
    }

    case "result": {
      const r = evt.result as Record<string, unknown> | undefined
      if (!r) return null
      const status = typeof r.status === "string" ? r.status : ""
      const out: StreamEvent[] = []

      const usage = mapAntigravityUsage(r.usage, sessionId)
      if (usage) out.push(usage)

      if (status === "ERROR" || status === "INVALID") {
        out.push({
          kind: "error",
          sessionId,
          error: {
            message:
              typeof r.error === "string" && r.error
                ? r.error
                : `agy run ended with status ${status || "ERROR"}`,
            ...(stderrLines.length
              ? { data: { stderr: stderrLines.join("\n") } }
              : {}),
          },
        })
      } else {
        out.push({
          kind: "turn-end",
          sessionId,
          reason: mapAntigravityStatus(status),
        })
      }
      return out.length ? out : null
    }

    // init and any unknown event carry no host-facing StreamEvent.
    default:
      return null
  }
}

/**
 * Normalize `agy` terminal `result.status` to a StreamEvent turn-end reason.
 * ERROR / INVALID are handled as `error` events upstream, so only the
 * non-error terminal statuses land here.
 */
function mapAntigravityStatus(
  raw: string,
): "completed" | "cancelled" | "max_turns" | "error" {
  switch (raw) {
    case "CANCELED":
    case "INTERRUPTED":
      return "cancelled"
    // SUCCESS, WAITING, RUNNING (or anything else non-error): the turn ended.
    default:
      return "completed"
  }
}

/**
 * Map `agy`'s `result.usage` ({input_tokens, output_tokens, thinking_tokens,
 * cache_read_tokens, total_tokens}) to a `usage_update` StreamEvent. `agy`
 * reports no context-window size/used or per-turn cost here, so those stay 0
 * / absent (the daemon's projector guards on >0 and never clobbers a real
 * size). Returns null when no token counts are present.
 */
function mapAntigravityUsage(
  usage: unknown,
  sessionId: string,
): StreamEvent | null {
  if (usage === null || typeof usage !== "object") return null
  const u = usage as Record<string, unknown>
  const tokensIn = typeof u.input_tokens === "number" ? u.input_tokens : undefined
  const tokensOut =
    typeof u.output_tokens === "number" ? u.output_tokens : undefined
  if (tokensIn === undefined && tokensOut === undefined) return null
  return {
    kind: "usage_update",
    sessionId,
    size: 0,
    used: 0,
    ...(tokensIn !== undefined ? { tokensIn } : {}),
    ...(tokensOut !== undefined ? { tokensOut } : {}),
  }
}

// ── jcode NDJSON mapper ─────────────────────────────────────────────

/**
 * Mutable per-stream state for the jcode NDJSON mapper. Tool arguments
 * arrive as JSON-string `tool_input` deltas between `tool_start` and
 * `tool_exec`, so the pending call accumulates here until complete.
 */
export interface JcodeMapperState {
  pending?: { id: string; name: string; input: string }
}

export function createJcodeMapperState(): JcodeMapperState {
  return {}
}

/**
 * Maps a single `jcode run --ndjson` line to this repo's
 * {@link StreamEvent} taxonomy. Wire shape verified against a live
 * `jcode run --ndjson` (2026-08-14):
 *
 *   {type:"start", session_id, model, provider}          → session capture
 *   {type:"status_detail"|"connection_phase"|
 *    "connection_type"|"message_end", …}                 → dropped (noise)
 *   {type:"text_delta", text}                            → text-delta
 *   {type:"tool_start", id, name}                        → open pending call
 *   {type:"tool_input", delta}                           → accumulate args
 *   {type:"tool_exec", id, name}                         → tool-call
 *   {type:"tool_done", id, name, output, error}          → tool-result
 *   {type:"tokens", input, output, cache_read_input, …}  → usage_update
 *   {type:"done", text, session_id, usage}               → turn-end
 *
 * `tokens` fires once per upstream API call (a tool round-trip produces
 * several), so usage arrives as successive updates, not one total.
 */
export function mapJcodeEvent(
  evt: Record<string, unknown>,
  sessionId: string,
  state: JcodeMapperState,
): StreamEvent | StreamEvent[] | null {
  switch (evt.type) {
    case "text_delta":
      return typeof evt.text === "string"
        ? { kind: "text-delta", sessionId, text: evt.text }
        : null

    case "tool_start":
      state.pending = {
        id: typeof evt.id === "string" ? evt.id : "",
        name: typeof evt.name === "string" ? evt.name : "?",
        input: "",
      }
      return null

    case "tool_input":
      if (state.pending && typeof evt.delta === "string")
        state.pending.input += evt.delta
      return null

    case "tool_exec":
      return flushPendingJcodeCall(state, sessionId)

    case "tool_done": {
      // Defensive: if `tool_exec` never arrived, flush the call here so
      // the result is never orphaned from its call.
      const call = flushPendingJcodeCall(state, sessionId)
      const result: StreamEvent = {
        kind: "tool-result",
        sessionId,
        toolCallId: typeof evt.id === "string" ? evt.id : "",
        result: evt.output ?? null,
        isError: evt.error !== null && evt.error !== undefined,
      }
      return call ? [call, result] : result
    }

    case "tokens": {
      const tokensIn = typeof evt.input === "number" ? evt.input : undefined
      const tokensOut = typeof evt.output === "number" ? evt.output : undefined
      if (tokensIn === undefined && tokensOut === undefined) return null
      // jcode reports no context-window size/used here, so those stay 0
      // (the daemon's projector guards on >0 and never clobbers a real
      // size) — same contract as the antigravity usage mapper.
      return {
        kind: "usage_update",
        sessionId,
        size: 0,
        used: 0,
        ...(tokensIn !== undefined ? { tokensIn } : {}),
        ...(tokensOut !== undefined ? { tokensOut } : {}),
      }
    }

    case "done":
      return { kind: "turn-end", sessionId, reason: "completed" }

    default:
      return null
  }
}

function flushPendingJcodeCall(
  state: JcodeMapperState,
  sessionId: string,
): StreamEvent | null {
  const pending = state.pending
  state.pending = undefined
  if (!pending) return null
  let args: unknown
  try {
    args = JSON.parse(pending.input)
  } catch {
    args = { raw: pending.input }
  }
  return {
    kind: "tool-call",
    sessionId,
    toolCallId: pending.id,
    toolName: pending.name,
    arguments: args,
  }
}

// ── Mastra Code JSONL mapper ────────────────────────────────────────

/**
 * Mutable per-stream state for the Mastra Code event mapper.
 * Mastra Code sends the FULL accumulated text on each `message_update`,
 * so we track the previous length to emit only the new portion.
 *
 * Exported so other Mastra Code protocol arms (e.g. the in-process
 * `proprietary` arm in `@agentproto/adapter-mastracode-inprocess`) can
 * reuse the same event mapper instead of reimplementing it — the wire
 * shape here is `AgentControllerEvent` regardless of whether it arrived
 * over a JSONL subprocess pipe or as a live in-process object.
 */
export interface MastraMapperState {
  lastTextLength: number
}

export function createMastraMapperState(): MastraMapperState {
  return { lastTextLength: 0 }
}

/**
 * Extract text from Mastra Code content blocks.
 * Blocks are normally a `{ type: "text", text: "..." }` array directly on
 * `message.content`, but newer Mastra Code builds wrap them in an object —
 * `{ format: 2, parts: [...] }` — so unwrap that shape to the blocks array
 * first.
 */
function extractTextFromBlocks(
  content: unknown,
): string {
  let blocks = content
  if (
    blocks !== null &&
    typeof blocks === "object" &&
    !Array.isArray(blocks) &&
    Array.isArray((blocks as Record<string, unknown>).parts)
  ) {
    blocks = (blocks as Record<string, unknown>).parts
  }
  if (!Array.isArray(blocks)) return ""
  return (blocks as Array<Record<string, unknown>>)
    .filter(c => c.type === "text" && typeof c.text === "string")
    .map(c => c.text as string)
    .join("")
}

/**
 * Maps a single Mastra Code `AgentControllerEvent` (already a plain
 * object — JSON-parsed from a subprocess line, or handed over directly
 * by an in-process arm) to this repo's {@link StreamEvent} taxonomy.
 * `stderrLines` enriches `error` events for arms that have a real
 * subprocess to report on; pass `[]` when there is none (e.g. the
 * in-process arm).
 */
export function mapMastraEvent(
  evt: Record<string, unknown>,
  sessionId: string,
  stderrLines: string[],
  state: MastraMapperState,
): StreamEvent | null {
  switch (evt.type) {
    // ── Text streaming ──────────────────────────────────────────
    case "message_update": {
      const content = (evt.message as Record<string, unknown>)?.content
      const fullText = extractTextFromBlocks(content)
      if (fullText.length > state.lastTextLength) {
        const delta = fullText.slice(state.lastTextLength)
        state.lastTextLength = fullText.length
        return delta ? { kind: "text-delta", sessionId, text: delta } : null
      }
      return null
    }

    case "message_end": {
      const msg = evt.message as Record<string, unknown> | undefined
      if (msg?.role !== "assistant") return null
      const fullText = extractTextFromBlocks(msg?.content)
      // Emit any remaining text not covered by message_update deltas
      if (fullText.length > state.lastTextLength) {
        const delta = fullText.slice(state.lastTextLength)
        state.lastTextLength = fullText.length
        return delta ? { kind: "text-delta", sessionId, text: delta } : null
      }
      return null
    }

    // ── Tool calls ──────────────────────────────────────────────
    case "tool_start":
      return {
        kind: "tool-call",
        sessionId,
        toolCallId:
          typeof evt.toolCallId === "string" ? evt.toolCallId : "",
        toolName:
          typeof evt.toolName === "string" ? evt.toolName : "?",
        // Mastra's controller event carries the tool call payload under
        // `args`, not `input` (that's the Claude Code stream-json field
        // name used by the sibling mapClaudeEvent tool_use case below).
        arguments: evt.args ?? {},
      }

    case "tool_end":
      return {
        kind: "tool-result",
        sessionId,
        toolCallId:
          typeof evt.toolCallId === "string" ? evt.toolCallId : "",
        result: evt.result ?? null,
        isError: evt.isError === true,
      }

    // ── Turn end ────────────────────────────────────────────────
    case "agent_end": {
      const rawReason =
        typeof evt.reason === "string"
          ? evt.reason
          : "complete"
      const reason = mapMastraFinishReason(rawReason)
      return { kind: "turn-end", sessionId, reason }
    }

    // ── Final result line ────────────────────────────────────────
    // Always written last, once, whether or not `agent_end` fired —
    // pre-flight failures (bad model, unresolvable thread, missing API
    // key) call straight into this without ever streaming an
    // `agent_end` or `error` event. `turn-end` already came from
    // `agent_end` on the success path, so this only needs to surface
    // an error for the pre-flight-failure path.
    case "result": {
      const err = evt.error as Record<string, unknown> | undefined
      if (!err) return null
      return {
        kind: "error",
        sessionId,
        error: {
          message:
            typeof err.message === "string" ? err.message : "Unknown error",
          ...(stderrLines.length
            ? { data: { stderr: stderrLines.join("\n") } }
            : {}),
        },
      }
    }

    // ── Errors ─────────────────────────────────────────────────
    case "error": {
      const err = evt.error as Record<string, unknown> | undefined
      return {
        kind: "error",
        sessionId,
        error: {
          message:
            typeof err?.message === "string"
              ? err.message
              : "Unknown error",
          ...(stderrLines.length
            ? { data: { stderr: stderrLines.join("\n") } }
            : {}),
        },
      }
    }

    // ── Token usage ─────────────────────────────────────────────
    // Mastra Code DOES expose usage: its `AgentController` emits a native
    // `usage_update` event ({ type: "usage_update", usage: TokenUsage })
    // on every model step-finish — verified against @mastra/core 1.48.0's
    // AgentControllerEvent union and its emit site
    // (`this.#session.emit({ type: "usage_update", usage: stepUsage })`).
    // `TokenUsage` carries `{ promptTokens, completionTokens, totalTokens }`.
    // Map it to this repo's `usage_update` StreamEvent (the SAME shape
    // claude-code emits over ACP) so mastracode sessions — both the print
    // arm and the in-process arm, which share this mapper — carry token
    // telemetry in the transcript. mastracode reports these cumulatively
    // (its own headless `runMC` result-usage is last-write-wins over these
    // events), and last-write-wins on the descriptor matches that. It
    // carries no context-window size/used or per-turn cost here, so those
    // stay 0 / absent (projectEvent guards on >0, never clobbering a real
    // size).
    case "usage_update": {
      const usage = evt.usage as Record<string, unknown> | undefined
      const promptTokens =
        typeof usage?.promptTokens === "number" ? usage.promptTokens : undefined
      const completionTokens =
        typeof usage?.completionTokens === "number"
          ? usage.completionTokens
          : undefined
      if (promptTokens === undefined && completionTokens === undefined)
        return null
      return {
        kind: "usage_update",
        sessionId,
        size: 0,
        used: 0,
        ...(promptTokens !== undefined ? { tokensIn: promptTokens } : {}),
        ...(completionTokens !== undefined
          ? { tokensOut: completionTokens }
          : {}),
      }
    }

    // ── Shell output (tool-like) ────────────────────────────────
    case "shell_output":
      return typeof evt.output === "string"
        ? {
            kind: "tool-result",
            sessionId,
            toolCallId: "",
            result: evt.output,
            isError: false,
          }
        : null

    // ── Skipped events ─────────────────────────────────────────
    case "agent_start":
    case "subagent_start":
    case "subagent_end":
    case "tool_approval_required":
    case "tool_suspended":
      return null

    default:
      return null
  }
}

// ── Decoupling queue ────────────────────────────────────────────────

/**
 * High-water mark (in buffered events) at which {@link EventQueue} logs a
 * single warning. This does NOT cap the buffer or drop events: the whole
 * point of this queue is to keep draining `child.stdout` so the subprocess
 * never hits `ENOBUFS`, and dropping mapped events would corrupt the
 * transcript / ring buffer this feeds. The mark exists purely to make a
 * genuinely stuck downstream consumer (one that has stopped pulling for an
 * extended period, letting the buffer grow toward a memory problem)
 * observable to operators instead of failing silently.
 *
 * Sized well above the worst incident seen in the wild (a mastracode run
 * emitting ~1200 lines / ~900 tool results): a transient burst is absorbed
 * without noise, while a persistently slow client trips the warning.
 */
const QUEUE_HIGH_WATER_MARK = 10_000

/**
 * A bounded-signal async FIFO that decouples a fast push-side producer
 * (readline draining a subprocess pipe) from a slow pull-side consumer
 * (the daemon's event projector → transcript + ring buffer + SSE stream).
 *
 * `push()` never blocks and never rejects — the producer keeps draining
 * the OS pipe so the child never backpressures into `ENOBUFS`. The
 * consumer drives it as an async iterable; each `next()` resolves as soon
 * as an event is available (or immediately if one is already buffered),
 * and completes once {@link end} is called and the buffer is exhausted.
 *
 * Backpressure is applied to the CONSUMER, not the producer: the iterator
 * only advances when the caller pulls. If the caller stops pulling for a
 * long time the buffer grows; crossing {@link QUEUE_HIGH_WATER_MARK} emits
 * one warning so the condition is never silent (see the constant's doc for
 * why we favour bounded-visibility growth over dropping events).
 */
class EventQueue implements AsyncIterable<StreamEvent> {
  private readonly buffer: StreamEvent[] = []
  private resolveNext: (() => void) | null = null
  private ended = false
  private highWaterWarned = false

  push(evt: StreamEvent): void {
    this.buffer.push(evt)
    if (
      this.buffer.length > QUEUE_HIGH_WATER_MARK &&
      !this.highWaterWarned
    ) {
      this.highWaterWarned = true
      console.warn(
        `print-arm: event backlog exceeded ${QUEUE_HIGH_WATER_MARK} ` +
          `buffered events — downstream consumer is not keeping up. The ` +
          `child's stdout is still being drained (no ENOBUFS), but memory ` +
          `will grow until the consumer catches up.`,
      )
    }
    // Wake a consumer parked in next().
    const resolve = this.resolveNext
    this.resolveNext = null
    resolve?.()
  }

  /** Signal that no further events will be pushed. */
  end(): void {
    this.ended = true
    const resolve = this.resolveNext
    this.resolveNext = null
    resolve?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    for (;;) {
      const evt = this.buffer.shift()
      if (evt !== undefined) {
        yield evt
        continue
      }
      if (this.ended) return
      // Nothing buffered and not ended — park until push()/end() wakes us.
      await new Promise<void>(resolve => {
        this.resolveNext = resolve
      })
    }
  }
}

// ── Process helpers ─────────────────────────────────────────────────

/**
 * Normalize Mastra Code `agent_end.finishReason` to StreamEvent turn-end reason.
 * Mastra uses: "complete", "aborted", "error", "suspended"
 * StreamEvent expects: "completed", "cancelled", "error", "max_turns"
 */
function mapMastraFinishReason(
  raw: string,
): "completed" | "cancelled" | "max_turns" | "error" {
  switch (raw) {
    case "complete":
      return "completed"
    case "aborted":
    case "suspended":
      return "cancelled"
    case "error":
      return "error"
    default:
      return "completed"
  }
}

function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<number | null> {
  return new Promise(resolve => {
    child.once("exit", code => resolve(code))
    child.once("error", () => resolve(null))
  })
}
