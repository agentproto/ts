/**
 * `agentproto sessions [--watch] [--attach <id>] [--json]`
 * `agentproto sessions start <slug> [--cwd <dir>] [--workspace <slug>]
 *                                    [--prompt <text>] [--label <text>]
 *                                    [--title <text>] [--attach] [--json]`
 * `agentproto sessions stop <id>`
 *
 * Browse and control the daemon's live sessions (terminals, agent
 * CLIs, custom commands) without leaving the shell:
 *
 *   agentproto sessions                  one-shot table dump
 *   agentproto sessions --watch          re-render every 2s, q to quit
 *   agentproto sessions --attach <id>    SSE-stream a session's output
 *   agentproto sessions start <slug>     POST /sessions/agent to spawn
 *                                        a persistent agent-cli session
 *   agentproto sessions prompt <id> -p .. POST /sessions/:id/prompt to send a
 *                                        message into an already-running session
 *   agentproto sessions stop <id>        POST /sessions/:id/kill (SIGTERM)
 *
 * The TUI is intentionally minimal — raw stdin keypresses, no inquirer
 * / blessed dep. Terminal emulator quirks (xterm vs iTerm, key
 * sequences for arrow keys) are limited to a couple lines below.
 *
 * Endpoint discovery: layered fallback, first live candidate wins — env
 * override (`AGENTPROTO_DAEMON_URL`/`_TOKEN`) > home
 * `~/.agentproto/runtime.json` (only if its pid is still alive) > the
 * central registry `~/.agentproto/daemons/<port>.json` for the port
 * declared in config.json > each workspace's own runtime.json. A
 * descriptor whose pid is dead is skipped, never trusted — see
 * `discoverDaemon()` in `_daemon-helpers.ts` and this package's README
 * ("Discovery + token") for the full order and the daemon-restart race
 * it's guarding against.
 */
import { parseArgs } from "node:util"
import { basename, resolve } from "node:path"
import http from "node:http"
import https from "node:https"
import WebSocket from "ws"
import { loadConfig } from "@agentproto/runtime/config"
import {
  presenceFor,
  resolveAttentionDelaySec,
} from "@agentproto/runtime/session-presence"
import {
  resolveTerminalPreset,
  type TerminalPresetCliValues,
} from "../terminal-preset.js"
import {
  discoverDaemon,
  readRuntimeJsonWithStatus,
  printNoDaemonError,
  httpPostJson,
  httpGetJson,
  httpDelete,
  humaniseDelta,
  type DaemonEndpoint,
} from "./_daemon-helpers.js"
import { waitForPolicy } from "./_policy-wait.js"
import { parseDuration, formatDuration } from "../util/duration.js"
import {
  hasResumeStrategy,
  decideRestartStrategy,
  augmentWithFsResume,
  describeResumePath,
  tokenizeCommand,
  RESUME_ID_REJECTED_RE,
} from "@agentproto/runtime/resume-strategies"
import {
  buildStory,
  type Story,
  type StoryStepKind,
  type ExportedSession,
} from "@agentproto/runtime/session-story"
import type { SessionDescriptor } from "@agentproto/runtime"
import type { AcpMcpServer } from "@agentproto/acp"

const USAGE = `agentproto sessions — browse and control daemon sessions

Usage:
  agentproto sessions [--watch] [--json]
  agentproto sessions --attach <id-or-name> [--no-color]
  agentproto sessions start <adapter> [--cwd <dir>] [--workspace <slug>]
                                      [--model <id>] [--auth subscription|api-key]
                                      [--base-url <url>] [--auth-token <token>]
                                      [--options-json <json|@file>]
                                      [--prompt <text>]
                                      [--label <text>] [--title <text>]
                                      [--attach] [--json]
                                      [--orchestrator | --orchestrator-json <json>]
                                      [--mcp-servers-json <json|@file>]
                                      [--access-profile <ref>]
                                      [--worktree | --no-worktree]
                                      [--hold-permissions] [--no-color]
  agentproto sessions terminal [--preset <name>] [-- <argv...>] [--cwd <dir>]
                                            [--workspace <slug>] [--name <slug>]
                                            [--label <text>] [--cols <n>] [--rows <n>]
                                            [--attach] [--json] [--no-color]
  agentproto sessions export <id-or-name> [--json] [-o <file>]
                             [--source auto|native|daemon]
  agentproto sessions story <id-or-name> [--json] [--no-color]
                             [--source auto|native|daemon]
  agentproto sessions prompt <id-or-name> --prompt <text>
                              [--wait] [--interrupt] [--force] [--json]
                              (default: fire-and-forget, queued behind any
                               in-flight turn — the reply isn't printed,
                               read it back with 'sessions story'/'export'.
                               --wait blocks until the turn this prompt
                               starts finishes (still no reply text — just
                               confirms the turn drained). --interrupt
                               cancels a mid-turn session and dispatches
                               immediately instead of queuing. --force
                               jumps the queue — only meaningful without
                               --wait.)
  agentproto sessions stop <id-or-name> [--json]
  agentproto sessions pin <id-or-name> [--json]
  agentproto sessions unpin <id-or-name> [--json]
                              (list-visibility only — pinned sessions sort to
                               the top of the table, marked with a PIN
                               indicator. No effect on keepAlive/reaper/
                               notifications.)
  agentproto sessions gc [--older-than-days <n>] [--forget] [--json]
                              (archive terminal sessions by default; --forget
                               DROPS descriptors instead. Never touches live.)
  agentproto sessions wait <id-or-name> [--until <event>] [--policy <policyId>]
                              [--timeout <duration>] [--json]
                              (duration: bare integer = ms, unchanged — or an
                               explicit unit: 500ms, 30s, 5m, 2h. default
                               timeout: 900000ms/15m with --until, 60000ms/60s
                               bare — --timeout always wins)
  agentproto sessions queue <id-or-name> [--force <n>] [--deliver <n>]
                              [--drop <n>] [--json]
                              (inspect the prompt FIFO, and optionally act on
                               an item. With no action flag, lists what's
                               queued: each item's position (1 = next to
                               dispatch), origin (user/agent/child), preview and
                               queuedAt. --force <n> jumps position n to the
                               FRONT without touching the in-flight turn.
                               --deliver <n> interrupts whatever is running and
                               dispatches position n NOW. --drop <n> removes it
                               without delivering. Positions are 1-indexed here,
                               matching 'sessions prompt' output. After any
                               action the queue is re-listed to show the result.)

Discovers the daemon in this order — first live candidate wins:
  1. AGENTPROTO_DAEMON_URL env var (token from AGENTPROTO_DAEMON_TOKEN, or
     looked up from a matching runtime.json if that's unset)
  2. ~/.agentproto/runtime.json, only if its pid is still alive
  3. the central registry ~/.agentproto/daemons/<port>.json, for the port
     declared in config.json (falling back to any other live entry)
  4. each configured workspace's own <workspace>/.agentproto/runtime.json
A descriptor whose pid is dead is ignored, never trusted — see this
package's README ("Discovery + token") for the full explanation. The
token from whichever descriptor wins is sent as Bearer on mutating
routes. A 401 here almost always means the few-second window right after
a daemon restart, where the previous process is still alive with a
now-stale token; the error diagnoses that case and names the file it
came from — AGENTPROTO_DAEMON_TOKEN is the manual override.

sessions start flags:
  --auth subscription|api-key   deterministic billing-auth mode for adapters that
                                 declare it (today: claude-code). subscription
                                 (default) scrubs API-key/gateway env vars so the
                                 child uses its stored OAuth login; api-key requires
                                 ANTHROPIC_API_KEY and fails the spawn without it.
  --base-url <url>              manifest 'base_url' option (claude-code/claude-sdk) —
                                 injected as ANTHROPIC_BASE_URL, fronts a custom
                                 Anthropic-compatible gateway (proxy, LiteLLM, …).
                                 Shorthand for --options-json '{"base_url":"<url>"}'.
  --auth-token <token>          manifest 'auth_token' option — injected as
                                 ANTHROPIC_AUTH_TOKEN (sent as 'Authorization: Bearer').
                                 Pair with --base-url to authenticate against a gateway
                                 instead of the ambient ANTHROPIC_API_KEY.
  --options-json <json>         object form of any manifest-declared AIP-45 options
                                 (e.g. '{"base_url":"...","effort":"high"}') — merged
                                 with --base-url/--auth-token when both are given
                                 (the discrete flags win on key collision)
  --options-json @<file>        same, read from a file instead of inline JSON
  --orchestrator                shorthand for orchestrator: true
  --orchestrator-json <json>    object form: {"tools":[...],"maxDepth":N,"maxChildren":N}
                                 (wins over --orchestrator when both are given)
  --mcp-servers-json <json>     JSON array of {name, transport, ref?} servers
  --mcp-servers-json @<file>    same, read from a file instead of inline JSON
  --access-profile <ref>        bill this spawn through the named auth profile
                                 (CLI twin of the MCP agent_start access.profileRef
                                 — pin endpoint + credential, never silently the
                                 default). Overrides the daemon's default profile.
  --worktree                    isolate this spawn in its OWN git worktree (auto-
                                 minted slug/branch on origin/main) regardless of
                                 the daemon's worktrees.isolation policy. Mirrors
                                 MCP agent_start.worktree=true.
  --no-worktree                 spawn in cwd directly, overriding an isolation
                                 policy that would otherwise isolate. Mirrors
                                 MCP agent_start.worktree=false.
  --mode <id>                   manifest-declared mode id applied at spawn (e.g.
                                 claude-code 'plan' / codex 'read-only'). Mirrors
                                 MCP agent_start.mode.
  --effort <level>              reasoning effort ('low'|'medium'|'high'|'xhigh'|
                                 'max'|'ultracode'). Calibrated per model. Mirrors
                                 MCP agent_start.effort.
  --hold-permissions            park each tool-permission request in the inbox
                                 (approve/deny with \`agentproto permissions\`)
                                 instead of auto-answering it

sessions terminal flags:
  --preset <name>              use a named 'terminalPresets' entry from
                                 ~/.agentproto/config.json. The preset may define
                                 argv, env, cwd, workspace, name and label.
                                 Explicit CLI flags win over preset values.
                                 Example config:
                                   {
                                     "terminalPresets": {
                                       "local-tui": {
                                         "argv": ["claude"],
                                         "env": { "ANTHROPIC_BASE_URL": "http://localhost:4000" },
                                         "name": "local-tui"
                                       }
                                     }
                                   }

In the watch list (--watch):
  ↑/↓ or j/k   move selection
  Enter         attach selected — opens the PTY directly for terminal
                 sessions (kind terminal / pty), SSE stream otherwise
  s             show the selected session's Story / conversation
  m             read-only mirror
  R             restart · K kill · d forget · r refresh
  q or Ctrl-C   quit

While attached:
  Ctrl-] q   detach (session keeps running on the daemon)
  Ctrl-C     send to the child (PTY mode) / detach (SSE mode)
`

// SessionDescriptor is imported from @agentproto/runtime — its
// canonical shape covers adapterSlug / adapterSessionId / cwd / argv
// / resumeMetadata, which the resume/restart flow below relies on.
// Keeping a local re-declaration here in the past drifted out of
// sync with the runtime, breaking type-check on every field added.

export async function runSessions(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }

  // Route `start` / `stop` / `terminal` subverbs before the flag
  // parser — they take positionals the flag parser would reject.
  const sub = args[0]
  if (sub === "start") return runStart(args.slice(1))
  if (sub === "prompt") return runPrompt(args.slice(1))
  if (sub === "stop") return runStop(args.slice(1))
  if (sub === "pin") return runPin(args.slice(1), true)
  if (sub === "unpin") return runPin(args.slice(1), false)
  if (sub === "gc") return runGc(args.slice(1))
  if (sub === "terminal") return runTerminal(args.slice(1))
  if (sub === "export") return runExport(args.slice(1))
  if (sub === "story") return runStory(args.slice(1))
  if (sub === "mirror") return runMirror(args.slice(1))
  if (sub === "restart") return runRestart(args.slice(1))
  if (sub === "wait") return runWait(args.slice(1))
  if (sub === "queue") return runQueue(args.slice(1))

  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      watch: { type: "boolean" },
      json: { type: "boolean" },
      attach: { type: "string" },
      simple: { type: "boolean" },
      "no-color": { type: "boolean" },
    },
  })

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sessions")
    return 2
  }
  const endpoint = report.found

  if (values.attach) {
    return runAttach({
      endpoint,
      idOrName: values.attach,
      colour: !values["no-color"],
    })
  }

  if (values.json) {
    const list = await fetchSessions(endpoint.url)
    process.stdout.write(JSON.stringify(list, null, 2) + "\n")
    return 0
  }

  if (values.watch) {
    // Grace window for the presence classifier — daemon config could override
    // the 60s default; resolved once here and threaded through every renderer.
    const attentionDelaySec = await resolveAttentionDelaySec()
    return values.simple
      ? runWatchSimple(endpoint, !values["no-color"], attentionDelaySec)
      : runWatch(endpoint, !values["no-color"], attentionDelaySec)
  }

  // One-shot
  const list = await fetchSessions(endpoint.url)
  printTable(list, await resolveAttentionDelaySec())
  return 0
}

async function runStart(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      cwd: { type: "string" },
      workspace: { type: "string" },
      preset: { type: "string" },
      model: { type: "string" },
      auth: { type: "string" },
      "base-url": { type: "string" },
      "auth-token": { type: "string" },
      "options-json": { type: "string" },
      prompt: { type: "string", short: "p" },
      label: { type: "string" },
      title: { type: "string" },
      attach: { type: "boolean" },
      json: { type: "boolean" },
      "no-color": { type: "boolean" },
      orchestrator: { type: "boolean" },
      "orchestrator-json": { type: "string" },
      "mcp-servers-json": { type: "string" },
      "hold-permissions": { type: "boolean" },
      "access-profile": { type: "string" },
      worktree: { type: "boolean" },
      "no-worktree": { type: "boolean" },
      mode: { type: "string" },
      effort: { type: "string" },
    },
  })
  const slug = positionals[0]
  if (!slug && !values.preset) {
    process.stderr.write(
      "agentproto sessions start: missing adapter slug or --preset.\n" +
        "  Try: agentproto sessions start claude-code --attach\n" +
        "       agentproto sessions start --preset fast-deepseek --attach\n"
    )
    return 2
  }
  if (positionals.length > 1) {
    process.stderr.write(
      `agentproto sessions start: unexpected extra positionals: ${positionals
        .slice(1)
        .join(" ")}\n`
    )
    return 2
  }

  // Parse --orchestrator-json / --mcp-servers-json client-side, before any
  // network activity, so malformed JSON fails fast with a clear message
  // instead of surfacing as an opaque 400 from the daemon.
  let orchestrator: boolean | Record<string, unknown> | undefined
  if (values["orchestrator-json"] !== undefined) {
    try {
      orchestrator = JSON.parse(values["orchestrator-json"])
    } catch (err) {
      process.stderr.write(
        `agentproto sessions start: invalid --orchestrator-json: ${err instanceof Error ? err.message : String(err)}\n`
      )
      return 2
    }
  } else if (values.orchestrator) {
    orchestrator = true
  }

  let mcpServers: AcpMcpServer[] | undefined
  if (values["mcp-servers-json"] !== undefined) {
    const raw = values["mcp-servers-json"]
    let text: string
    if (raw.startsWith("@")) {
      const filePath = resolve(raw.slice(1))
      try {
        const { readFile } = await import("node:fs/promises")
        text = await readFile(filePath, "utf8")
      } catch (err) {
        process.stderr.write(
          `agentproto sessions start: could not read --mcp-servers-json file "${filePath}": ${err instanceof Error ? err.message : String(err)}\n`
        )
        return 2
      }
    } else {
      text = raw
    }
    try {
      const parsed = JSON.parse(text)
      if (!Array.isArray(parsed)) {
        throw new Error("expected a JSON array of {name, transport, ref?}")
      }
      mcpServers = parsed
    } catch (err) {
      process.stderr.write(
        `agentproto sessions start: invalid --mcp-servers-json: ${err instanceof Error ? err.message : String(err)}\n`
      )
      return 2
    }
  }

  // Parse --options-json client-side (same @file convention as
  // --mcp-servers-json) so malformed JSON fails fast, before any network
  // activity. --base-url / --auth-token are sugar for the same manifest
  // `options` map (claude-code/claude-sdk's `base_url`/`auth_token` — see
  // adapters/claude-code and adapters/claude-sdk); merged in after so the
  // discrete flags win over a colliding key in --options-json.
  let options: Record<string, boolean | number | string> | undefined
  if (values["options-json"] !== undefined) {
    const raw = values["options-json"]
    let text: string
    if (raw.startsWith("@")) {
      const filePath = resolve(raw.slice(1))
      try {
        const { readFile } = await import("node:fs/promises")
        text = await readFile(filePath, "utf8")
      } catch (err) {
        process.stderr.write(
          `agentproto sessions start: could not read --options-json file "${filePath}": ${err instanceof Error ? err.message : String(err)}\n`
        )
        return 2
      }
    } else {
      text = raw
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected a JSON object of option id -> value")
      }
      options = parsed as Record<string, boolean | number | string>
    } catch (err) {
      process.stderr.write(
        `agentproto sessions start: invalid --options-json: ${err instanceof Error ? err.message : String(err)}\n`
      )
      return 2
    }
  }
  if (values["base-url"] || values["auth-token"]) {
    options = { ...options }
    if (values["base-url"]) options.base_url = values["base-url"]
    if (values["auth-token"]) options.auth_token = values["auth-token"]
  }

  // --worktree and --no-worktree are opposite overrides — both being set is a
  // usage error, rejected before any network activity like the other fast-fail
  // checks above.
  if (values.worktree && values["no-worktree"]) {
    process.stderr.write(
      "agentproto sessions start: --worktree and --no-worktree are mutually exclusive.\n"
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sessions start")
    return 2
  }
  const endpoint = report.found

  if (values.auth !== undefined && values.auth !== "subscription" && values.auth !== "api-key") {
    process.stderr.write(
      `agentproto sessions start: invalid --auth "${values.auth}" (expected subscription|api-key).\n`
    )
    return 2
  }

  const body: Record<string, unknown> = {}
  if (slug) body.adapter = slug
  if (values.preset) body.presetId = values.preset
  // Default cwd to the shell directory (like git/npm) when neither --cwd nor
  // --workspace is given, instead of silently using the daemon active
  // workspace. An explicit --workspace still resolves its cwd daemon-side.
  if (values.cwd) body.cwd = resolve(values.cwd)
  else if (!values.workspace) body.cwd = process.cwd()
  if (values.workspace) body.workspaceSlug = values.workspace
  if (values.model) body.model = values.model
  // Mode selection only — no --auth-token/--auth-api-key flag. Passing a
  // secret as a bare CLI arg would land in shell history + process listing
  // (ps); the credential itself must come from
  // ~/.agentproto/config.json's defaults.adapters.<slug>.auth.{token,apiKey}
  // (never inherited from the shell, per the auth-mode design).
  if (values.auth) body.auth = { mode: values.auth }
  // Named billing profile — the CLI twin of the MCP `agent_start` tool's
  // `access.profileRef` field. A bare `--auth subscription|api-key` says the
  // MODE but never names a profile; this pins the exact auth profile (billed
  // endpoint + method/credential) the daemon resolves via
  // `resolveAccessProfileAuth`. Mutation-free: the secret itself is resolved
  // daemon-side, never carried over HTTP/on the command line.
  if (values["access-profile"]) body.access = { profileRef: values["access-profile"] }
  // Worktree isolation — the CLI twin of the MCP `agent_start` tool's
  // `worktree` field. `--worktree` requests True (auto-mint a slug/branch on
  // `origin/main`); `--no-worktree` forces False even when the daemon's
  // `worktrees.isolation` policy would otherwise isolate. Omitted ⇒ the
  // daemon's policy decides, matching today's behaviour.
  if (values.worktree) body.worktree = true
  if (values["no-worktree"]) body.worktree = false
  // Manifest-declared mode id + reasoning effort — the CLI twins of the MCP
  // `agent_start` `mode`/`effort` fields. Sent verbatim; the daemon validates
  // them against each adapter's declared modes / each model's effort calibration.
  if (values.mode) body.mode = values.mode
  if (values.effort) body.effort = values.effort
  if (options !== undefined && Object.keys(options).length > 0) body.options = options
  if (values.prompt) body.prompt = values.prompt
  if (values.label) body.label = values.label
  // Explicit title (FIX C): overrides the first-sentence-of-prompt derivation
  // the daemon would otherwise apply. `label` still out-ranks it in the UI.
  if (values.title) body.title = values.title
  if (orchestrator !== undefined) body.orchestrator = orchestrator
  if (mcpServers !== undefined) body.mcpServers = mcpServers
  if (values["hold-permissions"]) body.permissionHold = true
  // Source label: this spawn came from the agentproto CLI (#575).
  body.origin = "cli"

  let desc: SessionDescriptor
  try {
    desc = await httpPostJson<SessionDescriptor>(
      `${endpoint.url}/sessions/agent`,
      body,
      endpoint.token,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 401/.test(msg)) {
      process.stderr.write(
        (await explain401(endpoint, "agentproto sessions start")) + "\n",
      )
    } else {
      process.stderr.write(`agentproto sessions start: ${describeSpawnFailure(msg)}\n`)
    }
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(desc, null, 2) + "\n")
  } else {
    process.stdout.write(
      `agentproto sessions start: spawned ${desc.kind} ${desc.id}` +
        ` (${desc.status}) — ${desc.command}` +
        // The worktree this session was provisioned into, when it has one —
        // surfaced in the plain-text success line (not just `--json`) so a
        // caller who asked for `--worktree` can immediately `cd` / verify.
        (desc.worktreePath ? `\n  worktree: ${desc.worktreePath}` : "") +
        `\n`
    )
  }

  if (values.attach) {
    return runAttach({
      endpoint,
      idOrName: desc.id,
      colour: !values["no-color"],
    })
  }
  return 0
}

/**
 * Re-frame a daemon spawn failure (`POST /sessions/agent`) into an
 * actionable CLI message. The daemon returns structured error bodies like
 *
 *   HTTP 400: {"error":"access_profile_ineligible","message":"profile \"x\" ..."}
 *
 * for the named-access-profile path (`session-spawn.ts`'s
 * `resolveAccessProfileAuth`). Raw, that reads as an opaque HTTP status +
 * JSON blob; here we surface the daemon's own `message` (which already names
 * the profile, adapter, route, and billed endpoint) inside a hint that tells
 * the caller the flag they passed (`--access-profile`) is what's being
 * rejected and where to look for eligible profiles. Any other failure is
 * returned unchanged.
 */
export function describeSpawnFailure(msg: string): string {
  const m = /^HTTP \d+:\s*/i.exec(msg)
  const bodyText = m ? msg.slice(m[0].length) : null
  if (!bodyText) return msg
  let body: { error?: string; message?: string } | null = null
  try {
    body = JSON.parse(bodyText) as { error?: string; message?: string }
  } catch {
    return msg
  }
  if (
    body &&
    (body.error === "access_profile_ineligible" ||
      body.error === "access_profile_not_found")
  ) {
    const why = body.message ?? "the named access profile was rejected."
    return (
      `${body.error}: ${why}\n` +
      "  --access-profile rejected this spawn. ProfileRef and its billed endpoint are shown above; " +
      "re-run with an eligible profileRef (see `agentproto preset list` and `agentproto usage " +
      "rollup --json` for your configured profileRefs), or drop --access-profile to let the daemon " +
      "pick its default profile."
    )
  }
  return msg
}

/**
 * `agentproto sessions prompt <id-or-name> --prompt <text> [--wait] [--interrupt]
 *                              [--force] [--json]`
 *
 * CLI parity for the daemon's `POST /sessions/:id/prompt` — the same route
 * `agent_prompt` (MCP) and the VS Code panel already use to send a follow-up
 * message into a session that's already running, but which had no `sessions`
 * verb of its own. Without it, reaching a live session from the shell meant
 * hand-crafting a `curl -X POST .../sessions/:id/prompt` against daemon
 * internals (endpoint discovery + bearer token) that every other verb here
 * already wraps.
 *
 * Default is fire-and-forget + queued (`?wait=false`, `queue: true`): safe
 * against a busy session (appends to its FIFO instead of the 409 a bare
 * `queue: false` admission would hit) and doesn't block the CLI on however
 * long the session's turn takes. `--wait` switches to the blocking route
 * (`sendPrompt`, no `queue`/`force` — see the HTTP route's own comment for
 * why those are blocking-mode-incompatible) for callers who want the command
 * to return only once the turn this prompt starts has drained.
 */
async function runPrompt(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      prompt: { type: "string", short: "p" },
      wait: { type: "boolean" },
      interrupt: { type: "boolean" },
      force: { type: "boolean" },
      json: { type: "boolean" },
    },
  })
  const id = positionals[0]
  if (!id || !values.prompt) {
    process.stderr.write(
      "agentproto sessions prompt: missing session id or --prompt.\n" +
        "  Try: agentproto sessions prompt <id-or-name> --prompt \"go check X\"\n" +
        "       agentproto sessions prompt <id-or-name> --prompt \"redirect now\" --interrupt\n" +
        "       agentproto sessions prompt <id-or-name> --prompt \"...\" --wait\n",
    )
    return 2
  }
  if (positionals.length > 1) {
    process.stderr.write(
      `agentproto sessions prompt: unexpected extra positionals: ${positionals
        .slice(1)
        .join(" ")}\n`,
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sessions prompt")
    return 2
  }
  const endpoint = report.found

  const url = values.wait
    ? `${endpoint.url}/sessions/${encodeURIComponent(id)}/prompt`
    : `${endpoint.url}/sessions/${encodeURIComponent(id)}/prompt?wait=false`
  const body: Record<string, unknown> = { prompt: values.prompt }
  if (values.interrupt) body.interrupt = true
  // queue/force are blocking-mode-incompatible server-side (see the route's
  // own comment) — only sent on the fire-and-forget arm.
  if (!values.wait) {
    body.queue = true
    if (values.force) body.force = true
  }

  try {
    const result = await httpPostJson<Record<string, unknown>>(url, body, endpoint.token)
    if (values.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    } else if (values.wait) {
      process.stdout.write(`agentproto sessions prompt: ${id} turn complete\n`)
    } else {
      const pending = result.pending === true
      process.stdout.write(
        pending
          ? `agentproto sessions prompt: queued for ${id}` +
              ` (position ${String(result.queuePosition)})\n`
          : `agentproto sessions prompt: sent to ${id}\n`,
      )
    }
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 401/.test(msg)) {
      process.stderr.write(
        (await explain401(endpoint, "agentproto sessions prompt")) + "\n",
      )
      return 1
    }
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(`agentproto sessions prompt: no session "${id}".\n`)
      return 2
    }
    if (/HTTP 409/.test(msg)) {
      process.stderr.write(
        `agentproto sessions prompt: ${id} is not alive or mid-turn` +
          " (retry with --interrupt or --wait, or omit --wait to queue).\n",
      )
      return 1
    }
    process.stderr.write(`agentproto sessions prompt: ${msg}\n`)
    return 1
  }
}

async function runStop(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean" },
    },
  })
  const id = positionals[0]
  if (!id) {
    process.stderr.write(
      "agentproto sessions stop: missing session id.\n" +
        "  Try: agentproto sessions stop <id-or-name>  (find ids with `agentproto sessions`)\n"
    )
    return 2
  }
  if (positionals.length > 1) {
    process.stderr.write(
      `agentproto sessions stop: unexpected extra positionals: ${positionals
        .slice(1)
        .join(" ")}\n`
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sessions stop")
    return 2
  }
  const endpoint = report.found

  try {
    const result = await httpPostJson<{ ok: boolean; sessionId: string }>(
      `${endpoint.url}/sessions/${encodeURIComponent(id)}/kill`,
      {},
      endpoint.token,
    )
    if (values.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    } else {
      process.stdout.write(
        result.ok
          ? `agentproto sessions stop: SIGTERM sent to ${id}\n`
          : `agentproto sessions stop: ${id} not running\n`
      )
    }
    return result.ok ? 0 : 1
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 401/.test(msg)) {
      process.stderr.write(
        (await explain401(endpoint, "agentproto sessions stop")) + "\n",
      )
      return 1
    }
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(
        `agentproto sessions stop: no session "${id}".\n`
      )
      return 2
    }
    process.stderr.write(`agentproto sessions stop: ${msg}\n`)
    return 1
  }
}

/**
 * `agentproto sessions pin <id-or-name> [--json]` / `sessions unpin` — CLI
 * parity for the `session_set_pinned` MCP verb. Structurally identical to
 * `runStop`: resolve the daemon, POST the mutation, print/return the result.
 * Pure list-visibility toggle — pinned sessions sort to the top of
 * `printTable`'s output with a PIN marker. No effect on keepAlive, the
 * idle-reaper, or notifications.
 */
async function runPin(args: readonly string[], pinned: boolean): Promise<number> {
  const verb = pinned ? "pin" : "unpin"
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean" },
    },
  })
  const id = positionals[0]
  if (!id) {
    process.stderr.write(
      `agentproto sessions ${verb}: missing session id.\n` +
        `  Try: agentproto sessions ${verb} <id-or-name>  (find ids with \`agentproto sessions\`)\n`
    )
    return 2
  }
  if (positionals.length > 1) {
    process.stderr.write(
      `agentproto sessions ${verb}: unexpected extra positionals: ${positionals
        .slice(1)
        .join(" ")}\n`
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, `agentproto sessions ${verb}`)
    return 2
  }
  const endpoint = report.found

  try {
    const result = await httpPostJson<{ ok: boolean; sessionId: string; pinned: boolean }>(
      `${endpoint.url}/sessions/${encodeURIComponent(id)}/pin`,
      { pinned },
      endpoint.token,
    )
    if (values.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    } else {
      process.stdout.write(
        result.ok
          ? `agentproto sessions ${verb}: ${id} ${pinned ? "pinned" : "unpinned"}\n`
          : `agentproto sessions ${verb}: ${id} not found\n`
      )
    }
    return result.ok ? 0 : 1
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 401/.test(msg)) {
      process.stderr.write(
        (await explain401(endpoint, `agentproto sessions ${verb}`)) + "\n",
      )
      return 1
    }
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(
        `agentproto sessions ${verb}: no session "${id}".\n`
      )
      return 2
    }
    process.stderr.write(`agentproto sessions ${verb}: ${msg}\n`)
    return 1
  }
}

/**
 * `agentproto sessions gc [--older-than-days <n>] [--forget] [--json]` —
 * CLI parity for the `session_gc` MCP verb (which had no CLI surface). Bulk
 * garbage-collects TERMINAL-status sessions (exited/killed/error) so the
 * list stops accumulating dead rows. ARCHIVES by default (reversible —
 * hidden from the default view, still readable + importable); `--forget`
 * instead DROPS each descriptor to reclaim `~/.agentproto/sessions.json`
 * space (the native conversation on disk survives). `--older-than-days`
 * keeps anything more recent. Never touches a live (running/starting)
 * session — the registry guards that. Hits `POST /sessions/gc`.
 */
async function runGc(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      "older-than-days": { type: "string" },
      forget: { type: "boolean" },
      json: { type: "boolean" },
    },
  })
  if (positionals.length > 0) {
    process.stderr.write(
      `agentproto sessions gc: unexpected positional(s): ${positionals.join(" ")}\n` +
        "  Try: agentproto sessions gc --older-than-days 7\n" +
        "       agentproto sessions gc --forget\n",
    )
    return 2
  }

  let olderThanDays: number | undefined
  if (values["older-than-days"] !== undefined) {
    const n = Number(values["older-than-days"])
    if (!Number.isFinite(n) || n <= 0) {
      process.stderr.write(
        `agentproto sessions gc: invalid --older-than-days "${values["older-than-days"]}" ` +
          "(expected a positive number of days).\n",
      )
      return 2
    }
    olderThanDays = n
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sessions gc")
    return 2
  }
  const endpoint = report.found

  const body: Record<string, unknown> = {}
  if (olderThanDays !== undefined) body.olderThanDays = olderThanDays
  if (values.forget) body.forget = true

  try {
    const result = await httpPostJson<{ mode: string; ids: string[]; count: number }>(
      `${endpoint.url}/sessions/gc`,
      body,
      endpoint.token,
    )
    if (values.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    } else {
      const scope = olderThanDays !== undefined ? ` older than ${olderThanDays}d` : ""
      process.stdout.write(
        `agentproto sessions gc: ${result.mode} ${result.count} terminal ` +
          `session${result.count === 1 ? "" : "s"}${scope}.\n`,
      )
    }
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 401/.test(msg)) {
      process.stderr.write(
        (await explain401(endpoint, "agentproto sessions gc")) + "\n",
      )
      return 1
    }
    process.stderr.write(`agentproto sessions gc: ${msg}\n`)
    return 1
  }
}

/**
 * `agentproto sessions queue <id-or-name> [--force <n>] [--deliver <n>]
 *                              [--drop <n>] [--json]` — CLI parity for the
 * daemon's queue-surface (`GET /sessions/:id/queue` + the per-item
 * promote/deliver/drop routes, the same ops the `session_queue_*` MCP tools
 * expose). Lists what's sitting in a session's prompt FIFO right now, and
 * optionally acts on one item by 1-indexed position.
 *
 * Positions are 1-INDEXED here (the first queued item is `1`, reading as
 * "next to dispatch") — matching the "position N" message `sessions prompt`
 * already prints at enqueue time, so the two surfaces agree. The daemon's
 * raw `position` field is 0-indexed; this command maps `n` (1-indexed) onto
 * the item at `n - 1` before calling the op, and labels its own output
 * 1-indexed.
 *
 * The three action flags are deliberately DISTINCT (mirroring the daemon's
 * two force ops + drop — never one flag with two meanings):
 *   --force <n>    promote position n to the FRONT (reorder-only; the
 *                  current in-flight turn is untouched, the item just
 *                  becomes next to dispatch when it ends)
 *   --deliver <n>  interrupt whatever's running and dispatch position n NOW
 *                  (the "I need this NOW" op)
 *   --drop <n>     remove position n without ever delivering it
 * After any action the queue is re-listed so the caller sees the result.
 */
async function runQueue(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      force: { type: "string" },
      deliver: { type: "string" },
      drop: { type: "string" },
      json: { type: "boolean" },
    },
  })
  const id = positionals[0]
  if (!id) {
    process.stderr.write(
      "agentproto sessions queue: missing session id.\n" +
        "  Try: agentproto sessions queue <id-or-name>\n" +
        "       agentproto sessions queue <id-or-name> --force 2\n" +
        "       agentproto sessions queue <id-or-name> --deliver 2\n" +
        "       agentproto sessions queue <id-or-name> --drop 1\n",
    )
    return 2
  }
  if (positionals.length > 1) {
    process.stderr.write(
      `agentproto sessions queue: unexpected extra positionals: ${positionals.slice(1).join(" ")}\n`,
    )
    return 2
  }
  // Exactly one action at a time — force/deliver/drop are mutually exclusive.
  const actions = (["force", "deliver", "drop"] as const).filter(f => values[f] !== undefined)
  if (actions.length > 1) {
    process.stderr.write(
      `agentproto sessions queue: choose one of --force/--deliver/--drop, not multiple.\n`,
    )
    return 2
  }
  const action: "force" | "deliver" | "drop" | undefined = actions[0]

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sessions queue")
    return 2
  }
  const endpoint = report.found

  // Fetch the current queue to (a) render it and (b) resolve the 1-indexed
  // action position onto a real queued item's id, which the ops address by.
  const listResult = await httpGetJson<{ ok: boolean; queue: QueueViewItem[] }>(
    `${endpoint.url}/sessions/${encodeURIComponent(id)}/queue`,
  )
  if (!listResult || !Array.isArray(listResult.queue)) {
    process.stderr.write(`agentproto sessions queue: no session "${id}".\n`)
    return 2
  }
  const queue = listResult.queue

  if (action) {
    let n: number
    try {
      n = Number.parseInt(values[action]!, 10)
    } catch {
      n = NaN
    }
    if (Number.isNaN(n) || n < 1 || !Number.isInteger(n)) {
      process.stderr.write(
        `agentproto sessions queue: invalid position "${values[action]}" (expected a positive integer).\n`,
      )
      return 2
    }
    const item = queue[n - 1]
    if (!item) {
      process.stderr.write(
        `agentproto sessions queue: position ${n} is out of range (${queue.length} queued) on "${id}".\n`,
      )
      return 2
    }
    let result: Record<string, unknown>
    try {
      if (action === "drop") {
        result = await httpDelete<Record<string, unknown>>(
          `${endpoint.url}/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(item.id)}`,
          endpoint.token,
        )
      } else {
        const verb = action === "force" ? "promote" : "deliver"
        result = await httpPostJson<Record<string, unknown>>(
          `${endpoint.url}/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(item.id)}/${verb}`,
          {},
          endpoint.token,
        )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/HTTP 404/.test(msg)) {
        process.stderr.write(
          `agentproto sessions queue: position ${n} (item ${item.id}) is no longer queued on "${id}".\n`,
        )
        return 1
      }
      process.stderr.write(`agentproto sessions queue: ${msg}\n`)
      return 1
    }
    if (!values.json) {
      const verbLabel =
        action === "force" ? "promoted to front" : action === "deliver" ? "delivered now" : "dropped"
      process.stdout.write(
        `agentproto sessions queue: position ${n} ${verbLabel} on ${id}.\n`,
      )
    }
    // Re-list so the caller sees the post-action state (drop shifts positions).
    const refreshed = await httpGetJson<{ ok: boolean; queue: QueueViewItem[] }>(
      `${endpoint.url}/sessions/${encodeURIComponent(id)}/queue`,
    )
    const newQueue = refreshed?.queue ?? queue
    if (values.json) {
      process.stdout.write(
        JSON.stringify(
          { ok: true, id, action, position: n, result, queue: newQueue },
          null,
          2,
        ) + "\n",
      )
    } else {
      printQueueTable(id, newQueue)
    }
    return 0
  }

  // No action — just list.
  if (values.json) {
    process.stdout.write(JSON.stringify({ ok: true, id, queue }, null, 2) + "\n")
  } else {
    printQueueTable(id, queue)
  }
  return 0
}

/** Shape of one item in `GET /sessions/:id/queue` — see `QueuedPromptView`. */
export interface QueueViewItem {
  id: string
  origin: string
  preview: string
  queuedAt: string
  /** 0 = next to dispatch (the daemon's index); display 1-indexed. */
  position: number
}

function printQueueTable(id: string, queue: QueueViewItem[]): void {
  process.stdout.write(`\x1b[2mqueue · ${id}\x1b[0m\n`)
  if (queue.length === 0) {
    process.stdout.write("(nothing queued)\n")
    return
  }
  const widths = {
    position: Math.max(...queue.map(q => String(q.position + 1).length), 3),
    origin: Math.max(...queue.map(q => q.origin.length), 6),
    queuedAt: 12,
  }
  const header =
    pad("#", widths.position) +
    "  " +
    pad("ORIGIN", widths.origin) +
    "  " +
    pad("QUEUED", widths.queuedAt) +
    "  PREVIEW"
  process.stdout.write(`\x1b[2m${header}\x1b[0m\n`)
  for (const q of queue) {
    const ts = q.queuedAt.slice(0, 16).replace("T", " ")
    process.stdout.write(
      pad(String(q.position + 1), widths.position) +
        "  " +
        pad(q.origin, widths.origin) +
        "  " +
        pad(ts, widths.queuedAt) +
        "  " +
        truncate(q.preview, 60) +
        "\n",
    )
  }
}

/**
 * `agentproto sessions wait <id-or-name>` — scriptable blocking wait.
 *
 * Blocks until the session fires a lifecycle event (default: any) or, when
 * `--policy <policyId>` is set, until the named policy resolves
 * (done/blocked/awaiting-ack/cancelled). Then exits with a code the caller
 * can branch on:
 *   0  condition met (session event) / policy `done`
 *   1  reserved for hard/unexpected CLI failures (the top-level catch in
 *      cli.ts) — this command's own code paths never return 1
 *   2  timeout (no resolution within `--timeout`) OR a usage error (bad
 *      arguments) OR policy `blocked`/`cancelled`
 *   3  session/policy not found or daemon unreachable
 *
 * Timeout used to share exit code 1 with hard CLI failures, so a caller
 * couldn't tell "just needs a bigger --timeout" from "something broke" —
 * it now gets its own code (2) and a message pointing at `--timeout`.
 *
 * Default `--timeout`: an explicit lifecycle wait (`--until <event>`) gets
 * 900000ms/15m, since a real agent turn commonly runs 5-20 minutes; a bare
 * `sessions wait` (no `--until`) keeps the original 60000ms/60s default.
 * An explicit `--timeout` always wins over either default.
 *
 * The daemon-side single-call timeout is capped (~55s, under typical HTTP
 * client timeouts). When the user's `--timeout` exceeds that, the CLI
 * loops, calling the endpoint again with an advancing `since` cursor until
 * the total budget is exhausted or the condition matches.
 */
/**
 * Default `--timeout` (ms) for `sessions wait` when the caller doesn't pass
 * one explicitly. An explicit `--until <event>` is a real lifecycle wait —
 * a single agent turn commonly runs 5-20 minutes — so it defaults to 15
 * minutes; a bare `sessions wait` keeps the original 60s default.
 */
export function resolveWaitDefaultTimeout(hasExplicitUntil: boolean): number {
  return hasExplicitUntil ? 900_000 : 60_000
}

async function runWait(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      until: { type: "string" },
      policy: { type: "string" },
      timeout: { type: "string" },
      json: { type: "boolean" },
    },
  })

  const target = positionals[0]
  if (!target && !values.policy) {
    process.stderr.write(
      "agentproto sessions wait: missing session id or policy id.\n" +
        "  Try: agentproto sessions wait <id-or-name>\n" +
        "       agentproto sessions wait <id-or-name> --until turn-end --timeout 30000\n" +
        "       agentproto sessions wait --policy <policyId> --timeout 60000\n",
    )
    return 2
  }
  if (positionals.length > 1) {
    process.stderr.write(
      `agentproto sessions wait: unexpected extra positionals: ${positionals
        .slice(1)
        .join(" ")}\n`,
    )
    return 2
  }

  // Validate --until early so a typo fails fast instead of after daemon work.
  const rawUntil = values.until
  const untilEvent =
    rawUntil === "turn-end" ||
    rawUntil === "awaiting-input" ||
    rawUntil === "exited" ||
    rawUntil === "any" ||
    rawUntil === undefined
      ? ((rawUntil ?? "any") as "turn-end" | "awaiting-input" | "exited" | "any")
      : null
  if (untilEvent === null) {
    process.stderr.write(
      `agentproto sessions wait: invalid --until "${rawUntil}". ` +
        `Expected one of: turn-end, awaiting-input, exited, any.\n`,
    )
    return 2
  }

  const defaultTimeout = resolveWaitDefaultTimeout(rawUntil !== undefined)
  const totalTimeout = (() => {
    const raw = values.timeout
    if (!raw) return defaultTimeout
    const parsed = parseDuration(raw, "--timeout")
    if (!parsed.ok) {
      process.stderr.write(`agentproto sessions wait: ${parsed.error}\n`)
      return NaN
    }
    return parsed.ms
  })()
  if (Number.isNaN(totalTimeout)) return 2

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sessions wait")
    return 3
  }
  const endpoint = report.found

  // --policy wins: wait on the policy resolution endpoint instead of the
  // session-event endpoint. The positional (if any) is ignored in that mode.
  if (values.policy) {
    return runWaitPolicy({
      endpoint,
      policyId: values.policy,
      totalTimeout,
      json: values.json === true,
    })
  }

  // Reachable only with `target` set — the guard above already rejected
  // `!target && !values.policy`, and `values.policy` is falsy on this path.
  if (!target) {
    process.stderr.write("agentproto sessions wait: missing session id.\n")
    return 2
  }

  return runWaitSession({
    endpoint,
    idOrName: target,
    untilEvent,
    totalTimeout,
    json: values.json === true,
  })
}

/**
 * Loop GET /sessions/:id/wait with an advancing `since` cursor until the
 * total timeout budget is exhausted or a matching event fires. Mirrors how
 * a client would chain multiple `session_monitor` calls.
 */
async function runWaitSession(opts: {
  endpoint: DaemonEndpoint
  idOrName: string
  untilEvent: "turn-end" | "awaiting-input" | "exited" | "any"
  totalTimeout: number
  json: boolean
}): Promise<number> {
  const { endpoint, idOrName, untilEvent, totalTimeout, json } = opts
  const deadline = Date.now() + totalTimeout
  // Per-call server cap is 55s; pick a slice that leaves headroom.
  const sliceMs = 50_000
  let cursor: number | undefined = undefined

  // Stated BEFORE blocking, not just on timeout: the incident this whole
  // module exists for was a wrong unit that looked exactly like a stuck
  // session — a caller who reads "waiting up to 3s (3000ms)" catches a
  // 1000x units slip immediately instead of after it's already blocked.
  // Suppressed under --json: a JSON caller gets the same numbers back as
  // fields (see emitWaitTimeout / the matched-result branch below) instead
  // of a stray prose line on stderr.
  if (!json) {
    process.stderr.write(
      `agentproto sessions wait: waiting up to ${formatDuration(totalTimeout)} ` +
        `(${totalTimeout}ms) for ${untilEvent} on ${idOrName}…\n`,
    )
  }

  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return emitWaitTimeout(json, { idOrName, timeoutMs: totalTimeout })
    }
    const callTimeout = Math.min(sliceMs, remaining)
    const qs = new URLSearchParams({
      event: untilEvent,
      timeoutMs: String(callTimeout),
    })
    if (cursor !== undefined) qs.set("since", String(cursor))
    const url = `${endpoint.url}/sessions/${encodeURIComponent(idOrName)}/wait?${qs.toString()}`
    let result: Record<string, unknown>
    try {
      result = await httpGetJson<Record<string, unknown>>(url)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/HTTP 404/.test(msg)) {
        process.stderr.write(
          `agentproto sessions wait: no session "${idOrName}".\n`,
        )
        return 3
      }
      if (/HTTP 501/.test(msg)) {
        process.stderr.write(
          `agentproto sessions wait: daemon does not expose the wait endpoint (${msg}).\n`,
        )
        return 3
      }
      process.stderr.write(`agentproto sessions wait: ${msg}\n`)
      return 3
    }
    if (result.timedOut === true) {
      // Advance the cursor from the server's response when available so the
      // next call doesn't replay the same window.
      if (typeof result.nextCursor === "number") cursor = result.nextCursor
      continue
    }
    // Matched.
    if (json) {
      process.stdout.write(
        JSON.stringify(
          { ...result, timeoutMs: totalTimeout, timeout: formatDuration(totalTimeout) },
          null,
          2,
        ) + "\n",
      )
    } else {
      const ev = typeof result.event === "string" ? result.event : "event"
      const sid = typeof result.sessionId === "string" ? result.sessionId : idOrName
      const status = typeof result.status === "string" ? result.status : ""
      process.stdout.write(
        `agentproto sessions wait: ${sid} → ${ev}` +
          (status ? ` (${status})` : "") +
          "\n",
      )
    }
    return 0
  }
}

/**
 * Loop GET /policies/:id/wait until the total timeout budget is exhausted
 * or the policy resolves. Exit codes: 0 done, 2 blocked, 1 timeout, 3 not
 * found / unreachable. Thin wrapper — the loop itself lives in
 * `_policy-wait.ts` so `agentproto policy wait` shares the exact same
 * semantics against the exact same route.
 */
async function runWaitPolicy(opts: {
  endpoint: DaemonEndpoint
  policyId: string
  totalTimeout: number
  json: boolean
}): Promise<number> {
  return waitForPolicy({
    endpoint: opts.endpoint,
    policyId: opts.policyId,
    totalTimeoutMs: opts.totalTimeout,
    json: opts.json,
    verb: "agentproto sessions wait",
  })
}

function emitWaitTimeout(
  json: boolean,
  ctx: { idOrName: string; timeoutMs: number },
): number {
  if (json) {
    process.stdout.write(
      JSON.stringify(
        { timedOut: true, ...ctx, timeout: formatDuration(ctx.timeoutMs) },
        null,
        2,
      ) + "\n",
    )
  } else {
    process.stdout.write(
      `agentproto sessions wait: session "${ctx.idOrName}" timed out after ` +
        `${formatDuration(ctx.timeoutMs)}. Pass a longer --timeout ` +
        `(e.g. --timeout 30s) if the task is still running.\n`,
    )
  }
  return 2
}

/**
 * `agentproto sessions terminal -- <argv...>` — spawn a PTY-backed
 * session via POST /sessions/terminal. The `--` separator is the
 * idiomatic way to pass argv that includes flags the verb's own
 * parser would otherwise eat. Without `--`, the first positional is
 * the binary and the rest are arguments.
 */
async function runTerminal(args: readonly string[]): Promise<number> {
  // Split on `--` so users can pass arbitrary argv (including flags
  // that look like the verb's own). Everything after `--` is argv;
  // anything before is verb flags.
  const sepIdx = args.indexOf("--")
  const verbArgs = sepIdx === -1 ? [...args] : args.slice(0, sepIdx)
  const argvFromSeparator = sepIdx === -1 ? [] : args.slice(sepIdx + 1)

  const { values, positionals } = parseArgs({
    args: verbArgs,
    allowPositionals: true,
    strict: true,
    options: {
      preset: { type: "string" },
      cwd: { type: "string" },
      workspace: { type: "string" },
      name: { type: "string" },
      label: { type: "string" },
      cols: { type: "string" },
      rows: { type: "string" },
      attach: { type: "boolean" },
      json: { type: "boolean" },
      "no-color": { type: "boolean" },
    },
  })

  // argv = positionals before `--` (legacy lenient form) OR everything after `--`.
  // Pre-`--` positionals are tolerated for the common case
  //   `agentproto sessions terminal bash --attach`.
  const explicitArgv =
    argvFromSeparator.length > 0 ? argvFromSeparator : [...positionals]

  // Resolve the named preset before daemon discovery so config errors fail
  // fast. CLI values always win over preset values.
  let argv: string[]
  let presetEnv: Record<string, string> | undefined
  let resolvedCwd = values.cwd
  let resolvedWorkspace = values.workspace
  let resolvedName = values.name
  let resolvedLabel = values.label

  if (values.preset) {
    const cfg = await loadConfig()
    const cliValues: TerminalPresetCliValues = {
      argv: explicitArgv.length > 0 ? explicitArgv : undefined,
      cwd: values.cwd,
      workspace: values.workspace,
      name: values.name,
      label: values.label,
    }
    const result = resolveTerminalPreset(values.preset, cfg, cliValues)
    if (!result.ok) {
      process.stderr.write(`agentproto sessions terminal: ${result.error}\n`)
      return 2
    }
    const preset = result.preset
    argv = explicitArgv.length > 0 ? explicitArgv : preset.argv ?? []
    if (argv.length === 0) {
      process.stderr.write(
        `agentproto sessions terminal: preset "${values.preset}" does not define argv, ` +
          "and no command was given.\n" +
          `  Try: agentproto sessions terminal --preset ${values.preset} -- claude\n`,
      )
      return 2
    }
    presetEnv = preset.env
    resolvedCwd ??= preset.cwd
    resolvedWorkspace ??= preset.workspace
    resolvedName ??= preset.name
    resolvedLabel ??= preset.label
  } else {
    if (explicitArgv.length === 0) {
      process.stderr.write(
        "agentproto sessions terminal: missing argv.\n" +
          "  Try: agentproto sessions terminal -- bash\n" +
          "       agentproto sessions terminal -- claude --resume <id>\n" +
          "       agentproto sessions terminal --preset <name> --attach\n",
      )
      return 2
    }
    argv = explicitArgv
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sessions terminal")
    return 2
  }
  const endpoint = report.found

  const cols = values.cols ? Number.parseInt(values.cols, 10) : undefined
  const rows = values.rows ? Number.parseInt(values.rows, 10) : undefined
  const body: Record<string, unknown> = {
    argv,
    cols:
      cols && Number.isFinite(cols) && cols > 0
        ? cols
        : process.stdout.columns && process.stdout.columns > 0
          ? process.stdout.columns
          : 80,
    rows:
      rows && Number.isFinite(rows) && rows > 0
        ? rows
        : process.stdout.rows && process.stdout.rows > 0
          ? process.stdout.rows
          : 24,
  }
  if (resolvedCwd) body.cwd = resolve(resolvedCwd)
  if (resolvedWorkspace) body.workspaceSlug = resolvedWorkspace
  if (resolvedName) body.name = resolvedName
  if (resolvedLabel) body.label = resolvedLabel
  if (presetEnv) body.env = presetEnv

  let desc: SessionDescriptor
  try {
    desc = await httpPostJson<SessionDescriptor>(
      `${endpoint.url}/sessions/terminal`,
      body,
      endpoint.token,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 401/.test(msg)) {
      process.stderr.write(
        (await explain401(endpoint, "agentproto sessions terminal")) + "\n",
      )
    } else {
      process.stderr.write(`agentproto sessions terminal: ${msg}\n`)
    }
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(desc, null, 2) + "\n")
  } else {
    process.stdout.write(
      `agentproto sessions terminal: spawned ${desc.id}` +
        `${desc.name ? ` (${desc.name})` : ""} — ${desc.command}\n`,
    )
  }

  if (values.attach) {
    return runAttach({
      endpoint,
      idOrName: desc.id,
      colour: !values["no-color"],
    })
  }
  return 0
}

/**
 * `agentproto sessions export <id-or-name> [--json] [-o <file>] [--source auto|native|daemon]`
 *
 * Renders a clean transcript via the daemon's GET /sessions/:id/export route.
 * `--source auto` (default) prefers the adapter's native persistence layer
 * (claude-code JSONL / hermes SQLite) and falls back to agentproto's own
 * events.jsonl capture when there isn't one; `native`/`daemon` force one.
 * Defaults to markdown on stdout; --json switches to the raw JSON
 * representation; -o writes to a file instead of stdout.
 */
async function runExport(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean" },
      output: { type: "string", short: "o" },
      adapter: { type: "string" },
      cwd: { type: "string" },
      source: { type: "string" },
    },
  })
  const id = positionals[0]
  if (!id) {
    process.stderr.write(
      "agentproto sessions export: missing session id.\n" +
        "  Try: agentproto sessions export <id-or-name>\n" +
        "       agentproto sessions export <id-or-name> --json -o transcript.json\n",
    )
    return 2
  }
  if (positionals.length > 1) {
    process.stderr.write(
      `agentproto sessions export: unexpected extra positionals: ${positionals.slice(1).join(" ")}\n`,
    )
    return 2
  }
  if (values.source && !["auto", "native", "daemon"].includes(values.source)) {
    process.stderr.write(
      `agentproto sessions export: invalid --source "${values.source}" (expected auto|native|daemon).\n`,
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sessions export")
    return 2
  }
  const endpoint = report.found

  const fmt = values.json ? "json" : "markdown"
  const qs = new URLSearchParams({ format: fmt })
  if (values.adapter) qs.set("adapter", values.adapter)
  if (values.cwd) qs.set("cwd", values.cwd)
  if (values.source) qs.set("source", values.source)

  let result: { content: string; format: string; adapter: string }
  try {
    result = await httpGetJson<{ content: string; format: string; adapter: string }>(
      `${endpoint.url}/sessions/${encodeURIComponent(id)}/export?${qs.toString()}`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(
        `agentproto sessions export: session "${id}" not found or export failed.\n`,
      )
      return 2
    }
    if (/HTTP 422/.test(msg)) {
      process.stderr.write(`agentproto sessions export: ${msg}\n`)
      return 1
    }
    process.stderr.write(`agentproto sessions export: ${msg}\n`)
    return 1
  }

  const outFile = values.output
  if (outFile) {
    const { writeFileSync } = await import("node:fs")
    writeFileSync(outFile, result.content, "utf8")
    process.stderr.write(
      `agentproto sessions export: wrote ${result.content.length} bytes to ${outFile}\n`,
    )
  } else {
    process.stdout.write(result.content)
    if (!result.content.endsWith("\n")) process.stdout.write("\n")
  }
  return 0
}

/**
 * `agentproto sessions story <id-or-name>` — CLI parity for the daemon's
 * `agentproto_session_story` MCP app. That app's panel computes its
 * chapters/steps client-side (a JS port of session-story.ts's heuristics,
 * driven live over a postMessage bridge — see session-story-panel-app.ts).
 * The CLI can't run that HTML/JS, so it reuses the canonical TS source of
 * truth directly: fetch the same transcript `sessions export --json`
 * already exposes over HTTP, then fold it with `buildStory` (the same
 * function the panel's JS is ported from) and render it as text.
 */
async function runStory(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean" },
      adapter: { type: "string" },
      cwd: { type: "string" },
      source: { type: "string" },
      "no-color": { type: "boolean" },
    },
  })
  const id = positionals[0]
  if (!id) {
    process.stderr.write(
      "agentproto sessions story: missing session id.\n" +
        "  Try: agentproto sessions story <id-or-name>\n" +
        "       agentproto sessions story <id-or-name> --json\n",
    )
    return 2
  }
  if (positionals.length > 1) {
    process.stderr.write(
      `agentproto sessions story: unexpected extra positionals: ${positionals.slice(1).join(" ")}\n`,
    )
    return 2
  }
  if (values.source && !["auto", "native", "daemon"].includes(values.source)) {
    process.stderr.write(
      `agentproto sessions story: invalid --source "${values.source}" (expected auto|native|daemon).\n`,
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sessions story")
    return 2
  }
  const endpoint = report.found

  const qs = new URLSearchParams({ format: "json" })
  if (values.adapter) qs.set("adapter", values.adapter)
  if (values.cwd) qs.set("cwd", values.cwd)
  if (values.source) qs.set("source", values.source)

  let result: { sessionId: string; adapter: string; format: string; content: string }
  try {
    result = await httpGetJson<{
      sessionId: string
      adapter: string
      format: string
      content: string
    }>(`${endpoint.url}/sessions/${encodeURIComponent(id)}/export?${qs.toString()}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(
        `agentproto sessions story: session "${id}" not found or export failed.\n`,
      )
      return 2
    }
    if (/HTTP 422/.test(msg)) {
      process.stderr.write(`agentproto sessions story: ${msg}\n`)
      return 1
    }
    process.stderr.write(`agentproto sessions story: ${msg}\n`)
    return 1
  }

  let session: ExportedSession
  try {
    session = JSON.parse(result.content) as ExportedSession
  } catch (err) {
    process.stderr.write(
      `agentproto sessions story: failed to parse transcript: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    )
    return 1
  }

  const story = buildStory(session.messages)

  if (values.json) {
    process.stdout.write(
      JSON.stringify(
        { sessionId: result.sessionId, adapter: result.adapter, ...story },
        null,
        2,
      ) + "\n",
    )
    return 0
  }

  process.stdout.write(
    renderStory(story, result.sessionId, result.adapter, !values["no-color"]),
  )
  return 0
}

const STORY_KIND_LABEL: Record<StoryStepKind, string> = {
  user: "user",
  text: "note",
  edit: "edit",
  bash: "bash",
  read: "read",
}

function storyKindColour(kind: StoryStepKind, c: Record<string, string>): string {
  switch (kind) {
    case "user":
      return c.cyan!
    case "edit":
      return c.green!
    case "bash":
      return c.amber!
    case "read":
      return c.blue!
    default:
      return c.dim!
  }
}

/** Terminal rendering of a Story — the CLI-appropriate counterpart to the
 *  MCP panel's HTML/JS view over the same `buildStory` output. */
export function renderStory(
  story: Story,
  sessionLabel: string,
  adapter: string,
  colour: boolean,
): string {
  const c = colour
    ? {
        reset: "\x1b[0m",
        dim: "\x1b[2m",
        bold: "\x1b[1m",
        green: "\x1b[32m",
        amber: "\x1b[33m",
        cyan: "\x1b[36m",
        blue: "\x1b[34m",
      }
    : {
        reset: "",
        dim: "",
        bold: "",
        green: "",
        amber: "",
        cyan: "",
        blue: "",
      }

  const out: string[] = []
  out.push(`${c.bold}STORY${c.reset} ${c.dim}${sessionLabel} · ${adapter}${c.reset}`)
  out.push("")

  if (story.chapters.length === 0) {
    out.push(`${c.dim}(no steps — empty transcript)${c.reset}`)
    return out.join("\n") + "\n"
  }

  out.push(
    story.chapters
      .map(ch => {
        const marker = ch.status === "cur" ? `${c.cyan}▸${c.reset}` : `${c.green}✓${c.reset}`
        return `${marker} ${ch.title}`
      })
      .join(`  ${c.dim}→${c.reset}  `),
  )
  out.push("")

  let lastChap: string | undefined
  for (const step of story.steps) {
    if (step.chap !== lastChap) {
      const chapter = story.chapters.find(ch => ch.id === step.chap)
      out.push(`${c.dim}── ${chapter?.title ?? step.chap} ──${c.reset}`)
      lastChap = step.chap
    }
    const tone = storyKindColour(step.kind, c)
    const badge = `${tone}[${STORY_KIND_LABEL[step.kind]}]${c.reset}`
    const ts = step.ts ? `${c.dim}${step.ts}${c.reset} ` : ""
    const countSuffix = step.count > 1 ? ` ${c.dim}×${step.count}${c.reset}` : ""
    out.push(`  ${ts}${badge} ${step.sum}${countSuffix}`)
    for (const fact of step.facts) {
      out.push(`      ${c.dim}${fact}${c.reset}`)
    }
  }
  out.push("")
  return out.join("\n") + "\n"
}

async function resolveDaemon(): Promise<DaemonEndpoint | null> {
  const report = await discoverDaemon()
  return report.found
}

/** @deprecated Kept for callers that only need the URL. */
async function resolveDaemonUrl(): Promise<string | null> {
  const ep = await resolveDaemon()
  return ep ? ep.url : null
}

async function readRuntimeJson(workspacePath: string): Promise<DaemonEndpoint | null> {
  const out = await readRuntimeJsonWithStatus(workspacePath)
  return out.endpoint
}

async function fetchSessions(baseUrl: string): Promise<SessionDescriptor[]> {
  const body = await httpGetJson(`${baseUrl}/sessions`)
  if (!body || !Array.isArray((body as { sessions?: unknown }).sessions)) {
    return []
  }
  return (body as { sessions: SessionDescriptor[] }).sessions
}

/** Wide enough for a realistic branch-shaped worktree name
 *  (`session-worktree-identity`, 25) without letting one outlier push COMMAND
 *  off the terminal. The column sizes to its widest row, so this is only a
 *  ceiling, not the usual width. */
const WORKTREE_COL_MAX = 32

/** A session's worktree as a table cell: the leaf directory name, which is
 *  what identifies a worktree to a human (`session-worktree-identity`) —
 *  the full path and the generation id are in the DETAIL pane and `--json`.
 *  See `SessionDescriptor.worktreePath`. */
function worktreeCell(s: SessionDescriptor): string {
  return s.worktreePath ? truncate(basename(s.worktreePath), WORKTREE_COL_MAX) : "—"
}

/** QUEUED column cell — "N queued", or blank when nothing is waiting. */
function queuedCell(s: SessionDescriptor): string {
  const n = s.queuedPrompts ?? 0
  return n > 0 ? `${n} queued` : ""
}

/** Pinned sessions first, each side keeping its incoming relative order —
 *  a stable sort on a single boolean key (`Array.prototype.sort` is
 *  guaranteed stable since ES2019). Exported for direct unit coverage. */
export function sortPinnedFirst(rows: readonly SessionDescriptor[]): SessionDescriptor[] {
  return rows
    .slice()
    .sort((a, b) => (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0))
}

function printTable(rows: SessionDescriptor[], attentionDelaySec?: number): void {
  if (rows.length === 0) {
    process.stdout.write("No sessions.\n")
    return
  }
  // Pinned sessions surface at the top of the table — see sortPinnedFirst.
  const sorted = sortPinnedFirst(rows)
  // The WORKTREE column earns its width only when something is actually in a
  // worktree — a column of em-dashes is noise for the (common) case of a
  // daemon whose sessions all run in plain checkouts.
  const showWorktree = sorted.some(r => r.worktreePath !== undefined)
  // A session is only "N queued"-worthy once something actually sits in its
  // prompt FIFO — a column of dashes is noise for the common no-queue case.
  const showQueued = sorted.some(r => (r.queuedPrompts ?? 0) > 0)
  const widths = {
    pin: 3,
    id: Math.max(...sorted.map(r => r.id.length), 4),
    kind: Math.max(...sorted.map(r => r.kind.length), 4),
    workspace: Math.max(...sorted.map(r => r.workspaceSlug.length), 9),
    worktree: Math.max(...sorted.map(r => worktreeCell(r).length), 8),
    queued: showQueued ? Math.max(...sorted.map(r => queuedCell(r).length), 6) : 0,
    status: Math.max(...sorted.map(r => statusLabel(r, attentionDelaySec).length), 8),
    age: 8,
  }
  const header =
    pad("PIN", widths.pin) +
    "  " +
    pad("ID", widths.id) +
    "  " +
    pad("KIND", widths.kind) +
    "  " +
    pad("WORKSPACE", widths.workspace) +
    "  " +
    (showWorktree ? pad("WORKTREE", widths.worktree) + "  " : "") +
    (showQueued ? pad("QUEUED", widths.queued) + "  " : "") +
    pad("STATUS", widths.status) +
    "  " +
    pad("AGE", widths.age) +
    "  COMMAND"
  process.stdout.write(`\x1b[2m${header}\x1b[0m\n`)
  const now = Date.now()
  for (const r of sorted) {
    const age = humaniseDelta(now - new Date(r.startedAt).getTime())
    const tone = statusColour(r, attentionDelaySec)
    process.stdout.write(
      pad(r.pinned === true ? "●" : "", widths.pin) +
        "  " +
        pad(r.id, widths.id) +
        "  " +
        pad(terminalKindMark(r) || r.kind, widths.kind) +
        "  " +
        pad(r.workspaceSlug, widths.workspace) +
        "  " +
        (showWorktree ? pad(worktreeCell(r), widths.worktree) + "  " : "") +
        (showQueued ? `\x1b[33m${pad(queuedCell(r), widths.queued)}\x1b[0m  ` : "") +
        `${tone}${pad(statusLabel(r, attentionDelaySec), widths.status)}\x1b[0m` +
        "  " +
        pad(age, widths.age) +
        "  " +
        truncate(r.command, 60) +
        "\n"
    )
  }
}

/** True when the descriptor claims `status: "running"` but the underlying
 *  OS process is confirmed gone (`processAlive` computed fresh from the pid
 *  at read time — see `stampProcessAlive` in runtime/sessions.ts). Happens
 *  when a daemon restart reaps the child without the registry catching up;
 *  surfaced distinctly everywhere status is rendered so it never reads as a
 *  healthy session. */
export function isStaleRunning(
  s: { status?: string; processAlive?: boolean },
): boolean {
  return s.status === "running" && s.processAlive === false
}

/** Single-character badge for the session's presence state, driven by the
 *  shared dashboard classifier (`presenceFor` in @agentproto/runtime/session-
 *  presence) — the SAME source the VS Code tree/panel render from, so the two
 *  can no longer drift. Busy/just-finished → ● (running), active children or
 *  background tasks pending → ◐ (tending), something waiting on the human →
 *  ?/! / ✗ (attention), nothing → ○ (quiet). Plus the stale-running ⚠ which
 *  is purely a dead-pid lifecycle flag the classifier doesn't know about.
 *
 *  Empty string for a terminal (non-running) session — the STATUS column shows
 *  the raw `status` word for those instead.
 */
export type PresenceRenderSession = {
  status?: string
  processAlive?: boolean
  busy?: boolean
  awaitingInput?: boolean
  awaitingPermission?: boolean
  childrenBusy?: number
  pendingBgTasks?: number
  lastActivityAt?: string
  lastOutputAt?: string
  lastTurnErroredAt?: string
  exitCode?: number
}

export function statusBadge(
  s: PresenceRenderSession,
  attentionDelaySec?: number,
): string {
  if (isStaleRunning(s)) return "⚠" // ⚠ — running, but the pid is dead
  if (s.status !== "running" && s.status !== "starting") return ""
  const presence = presenceFor(s, { attentionDelaySec })
  switch (presence) {
    case "running":
      return "●" // ● — turning, or just finished (inside the grace window)
    case "tending":
      return "◐" // ◐ — idle but busy through children / background tasks
    case "attention":
      if (s.awaitingPermission) return "!" // ! — held permission awaiting decide
      if (s.awaitingInput) return "?" // ? — blocked on the user
      if (s.lastTurnErroredAt) return "✗" // ✗ — last turn failed in-band
      return "!" // terminal-error fold-in — colour carries the warning
    case "quiet":
      return "○" // ○ — parked, nothing new
    default:
      return ""
  }
}

/** STATUS column/field text — presence badge for a live session, else the
 *  raw lifecycle `status` word for a terminal one. */
export function statusLabel(
  s: PresenceRenderSession,
  attentionDelaySec?: number,
): string {
  if (s.status !== "running" && s.status !== "starting") return s.status ?? ""
  const badge = statusBadge(s, attentionDelaySec)
  return badge ? `${s.status} ${badge}` : s.status ?? ""
}

export function statusColour(
  s: PresenceRenderSession,
  attentionDelaySec?: number,
): string {
  if (isStaleRunning(s)) return "\x1b[33m" // amber — "running" contradicted by a dead pid
  if (s.status !== "running") {
    switch (s.status) {
      case "starting":
        return "\x1b[33m" // yellow
      case "exited":
        return "\x1b[2m" // dim
      case "killed":
      case "error":
        return "\x1b[31m" // red
      default:
        return ""
    }
  }
  // Live agent-cli session (status stays "running" across turns) — colour by
  // the presence axis, so a parked session reads grey, not healthy-green.
  switch (presenceFor(s, { attentionDelaySec })) {
    case "running":
    case "tending":
      return "\x1b[32m" // green — in motion, leave alone
    case "attention":
      return "\x1b[33m" // amber — needs a look
    case "quiet":
      return "\x1b[2m" // dim — parked, nothing new
    default:
      return ""
  }
}

/** True when a session carries a real PTY — the `kind: "terminal"`,
 *  `pty: true` case that must surface in the list as an attachable
 *  interactive terminal rather than a bare row. `pty` is the stronger
 *  signal (it's what actually selects the WS pty transport), so either
 *  flag marks it. */
export function isTerminalSession(
  s: Pick<SessionDescriptor, "kind" | "pty">,
): boolean {
  return s.kind === "terminal" || s.pty === true
}

/** Row label for the interactive lists: a human-given `name` outranks
 *  everything; a terminal session with no name is labelled by the
 *  command it actually ran (`claude --resume …`) instead of its opaque
 *  id — which is what makes supervisors launched via `claude --resume`
 *  recognisable at a glance. Anything else falls back to the id. */
export function sessionRowLabel(
  s: Pick<SessionDescriptor, "kind" | "pty" | "name" | "command" | "id">,
): string {
  if (s.name) return s.name
  if (isTerminalSession(s) && s.command) return s.command
  return s.id
}

/** Simplest possible rendering of the "Terminal"/"PTY" identification
 *  for the flat tables — a short, sharply visible marker for terminal
 *  sessions, empty for the agent-cli rows that show a KIND column
 *  already. Returns plain ASCII (no colour) so it composes with the
 *  caller's own wrapping. */
export function terminalKindMark(
  s: Pick<SessionDescriptor, "kind" | "pty">,
): string {
  if (isTerminalSession(s)) return s.pty ? "PTY" : "TERM"
  return ""
}

/** Which attach transport a session needs. Enter routes to the same
 *  `runAttach` for every kind; this is the pure decision that makes a
 *  `kind: "terminal", pty: true` session land on the interactive PTY
 *  attach (WS /sessions/:id/pty) instead of the line-based SSE stream.
 *  Exported so the "Enter on terminal attaches the PTY" behaviour is
 *  unit-testable without driving a terminal. */
export function attachMode(
  s: Pick<SessionDescriptor, "pty">,
): "pty" | "sse" {
  return s.pty === true ? "pty" : "sse"
}

/** Normalised action decoded from a single watch-list keypress. Both
 *  watch loops (the 3-pane `--watch` and the flat `--simple`) share it
 *  so the touch→action mapping (Enter = attach, `s` = story, …) is one
 *  tested source of truth instead of two hand-rolled if-chains.
 *
 *  Enter is decoded to `{ kind: "attach" }` unconditionally — the
 *  terminal-vs-agent-cli split happens downstream in `attachMode`/
 *  `runAttach`, which is what makes Enter on a `kind: "terminal"`
 *  session open the PTY directly.
 */
export type WatchKeyAction =
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "attach" }
  | { kind: "story" }
  | { kind: "mirror" }
  | { kind: "restart" }
  | { kind: "kill" }
  | { kind: "forget" }
  | { kind: "refresh" }
  | { kind: "quit" }
  | null

/** Decode a single-char (or single arrow-sequence) keypress into a
 *  `WatchKeyAction`. Returns null for anything unrecognised — callers
 *  silently discard it. Ctrl-C (`\x03`) and `q` both quit. */
export function decodeWatchKey(key: string): WatchKeyAction {
  switch (key) {
    case "\x1b[A":
    case "k":
      return { kind: "up" }
    case "\x1b[B":
    case "j":
      return { kind: "down" }
    case "\r":
    case "\n":
      return { kind: "attach" }
    case "s":
      return { kind: "story" }
    case "m":
      return { kind: "mirror" }
    case "R":
      return { kind: "restart" }
    case "K":
      return { kind: "kill" }
    case "d":
      return { kind: "forget" }
    case "r":
      return { kind: "refresh" }
    case "q":
    case "\x03":
      return { kind: "quit" }
    default:
      return null
  }
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s
  return s + " ".repeat(n - s.length)
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + "…"
}

/**
 * `agentproto sessions --watch` — interactive TUI picker over the
 * daemon's session list. Auto-refreshes every 2 s; key bindings:
 *
 *   ↑/↓ or j/k   move selection
 *   Enter         attach to selected (PTY-aware via runAttach — opens
 *                 the interactive PTY directly for a terminal session)
 *   s             show the selected session's Story / conversation
 *   K             kill selected (POST /sessions/:id/kill)
 *   d             forget selected (DELETE /sessions/:id; exited only)
 *   r             refresh now
 *   q or Ctrl-C   quit
 *
 * Non-TTY stdin degrades to a one-shot dump (no live keys, no
 * picker), matching the old behaviour for `agentproto sessions`
 * piped into a pager.
 */
/**
 * `--watch --simple` — the original flat-table picker. Kept for
 * piping into a pager / external tool. The new default is the
 * 3-pane dashboard `runWatch`.
 */
async function runWatchSimple(
  endpoint: DaemonEndpoint,
  colour: boolean,
  attentionDelaySec?: number,
): Promise<number> {
  const tty = process.stdin.isTTY === true
  if (!tty) {
    const list = await fetchSessions(endpoint.url)
    printTable(list, attentionDelaySec)
    return 0
  }

  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding("utf8")

  let stop = false
  let action: "attach" | "story" | null = null
  let attachTargetId: string | null = null
  let cursor = 0
  let rows: SessionDescriptor[] = []
  let statusMsg = ""

  const repaint = (): void => {
    process.stdout.write("\x1bc")
    process.stdout.write(
      `\x1b[2magentproto sessions · ${endpoint.url} · ↑/↓ move · Enter attach · s story · K kill · d forget · r refresh · q quit\x1b[0m\n\n`,
    )
    if (statusMsg) {
      process.stdout.write(`\x1b[33m${statusMsg}\x1b[0m\n\n`)
    }
    printPickerTable(rows, cursor, attentionDelaySec)
  }

  const refresh = async (): Promise<void> => {
    try {
      rows = await fetchSessions(endpoint.url)
    } catch (err) {
      statusMsg = `fetch error: ${err instanceof Error ? err.message : String(err)}`
      rows = []
    }
    if (cursor >= rows.length) cursor = Math.max(0, rows.length - 1)
  }

  const onKey = (key: string): void => {
    switch (decodeWatchKey(key)?.kind) {
      case "up":
        if (cursor > 0) cursor--
        repaint()
        return
      case "down":
        if (cursor < rows.length - 1) cursor++
        repaint()
        return
      case "attach": {
        const target = rows[cursor]
        if (target) {
          action = "attach"
          attachTargetId = target.id
          stop = true
        }
        return
      }
      case "story": {
        const target = rows[cursor]
        if (target) {
          action = "story"
          attachTargetId = target.id
          stop = true
        }
        return
      }
      case "kill": {
        const target = rows[cursor]
        if (!target) return
        void httpPostJson<{ ok: boolean }>(
          `${endpoint.url}/sessions/${encodeURIComponent(target.id)}/kill`,
          {},
          endpoint.token,
        )
          .then(r => {
            statusMsg = r.ok
              ? `sent SIGTERM to ${target.id}`
              : `${target.id} not running`
            return refresh()
          })
          .catch(err => {
            statusMsg = `kill error: ${err instanceof Error ? err.message : String(err)}`
          })
          .finally(() => repaint())
        return
      }
      case "forget": {
        const target = rows[cursor]
        if (!target) return
        if (
          target.status !== "exited" &&
          target.status !== "killed" &&
          target.status !== "error"
        ) {
          statusMsg = `d: ${target.id} still ${target.status} — use K first`
          repaint()
          return
        }
        void httpDelete(
          `${endpoint.url}/sessions/${encodeURIComponent(target.id)}`,
          endpoint.token,
        )
          .then(() => {
            statusMsg = `forgot ${target.id}`
            return refresh()
          })
          .catch(err => {
            statusMsg = `forget error: ${err instanceof Error ? err.message : String(err)}`
          })
          .finally(() => repaint())
        return
      }
      case "refresh":
        statusMsg = ""
        void refresh().finally(() => repaint())
        return
      case "quit":
        stop = true
        return
      default:
        void colour // silence unused-var; reserved for future colour toggle
        return
    }
  }

  process.stdin.on("data", onKey)
  const sigintHandler = (): void => {
    stop = true
  }
  process.once("SIGINT", sigintHandler)

  try {
    await refresh()
    repaint()
    while (!stop) {
      await new Promise<void>(res => setTimeout(res, 2_000))
      if (stop) break
      await refresh()
      repaint()
    }
  } finally {
    process.stdin.off("data", onKey)
    process.off("SIGINT", sigintHandler)
    process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stdout.write("\n")
  }

  if (action === "attach" && attachTargetId) {
    return runAttach({
      endpoint,
      idOrName: attachTargetId,
      colour,
    })
  }
  if (action === "story" && attachTargetId) {
    return runStory([attachTargetId])
  }
  return 0
}

/**
 * Same shape as printTable but highlights the cursor row. Lives next
 * to printTable rather than gating it on a flag — the watch picker
 * needs distinct visual treatment that would otherwise add yet more
 * conditionals to the read-only printer.
 */
function printPickerTable(rows: SessionDescriptor[], cursor: number, attentionDelaySec?: number): void {
  if (rows.length === 0) {
    process.stdout.write("No sessions.\n")
    return
  }
  const widths = {
    id: Math.max(...rows.map(r => r.id.length), 4),
    kind: Math.max(...rows.map(r => r.kind.length), 4),
    workspace: Math.max(...rows.map(r => r.workspaceSlug.length), 9),
    status: Math.max(...rows.map(r => statusLabel(r, attentionDelaySec).length), 8),
    age: 8,
  }
  const header =
    "  " +
    pad("ID", widths.id) +
    "  " +
    pad("KIND", widths.kind) +
    "  " +
    pad("WORKSPACE", widths.workspace) +
    "  " +
    pad("STATUS", widths.status) +
    "  " +
    pad("AGE", widths.age) +
    "  COMMAND"
  process.stdout.write(`\x1b[2m${header}\x1b[0m\n`)
  const now = Date.now()
  rows.forEach((r, i) => {
    const age = humaniseDelta(now - new Date(r.startedAt).getTime())
    const tone = statusColour(r, attentionDelaySec)
    const marker = i === cursor ? "\x1b[7m▸" : " "
    const reset = i === cursor ? "\x1b[0m" : ""
    process.stdout.write(
      `${marker} ` +
        pad(r.id, widths.id) +
        "  " +
        pad(terminalKindMark(r) || r.kind, widths.kind) +
        "  " +
        pad(r.workspaceSlug, widths.workspace) +
        "  " +
        `${tone}${pad(statusLabel(r, attentionDelaySec), widths.status)}\x1b[0m` +
        "  " +
        pad(age, widths.age) +
        "  " +
        truncate(r.command, 60) +
        reset +
        "\n",
    )
  })
}

/**
 * `agentproto sessions --watch` — 3-pane dashboard:
 *
 *   ┌─ header (gateway · workspace · pty · origins · mode) ────────────┐
 *   │ SESSIONS                       │ DETAIL                          │
 *   │ ▸ name  pty status age         │ id / name / kind / status / …   │
 *   │   …                            │                                 │
 *   │                                │   Enter to attach · s story      │
 *   ├─ events strip (last 3 from /events SSE) ───────────────────────── │
 *   └─ keys footer ────────────────────────────────────────────────────┘
 *
 * Alt-screen mode so scrollback isn't trashed. Polls /sessions every
 * 2 s; subscribes to /events for the live ticker. Non-TTY stdin →
 * one-shot dump (no live keys), matching --simple.
 */
async function runWatch(
  endpoint: DaemonEndpoint,
  colour: boolean,
  attentionDelaySec?: number,
): Promise<number> {
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true
  if (!tty) {
    const list = await fetchSessions(endpoint.url)
    printTable(list, attentionDelaySec)
    return 0
  }
  // Non-colour pass-through: callers can still pipe via --no-color
  // (mostly relevant when tee-ing to a file from a real terminal).
  void colour

  // ─── state ─────────────────────────────────────────────────────
  let stop = false
  let action: "attach" | "mirror" | "story" | null = null
  let attachTargetId: string | null = null
  let cursor = 0
  let sessions: SessionDescriptor[] = []
  let recentEvents: { at: string; line: string }[] = []
  let health: {
    workspace?: string
    uptimeMs?: number
  } | null = null
  let statusMsg = ""
  let statusMsgUntil = 0
  // Per-session preview cache (last N lines from /sessions/:id/preview).
  // Populated on selection change + on each refresh tick so the panel
  // updates as new output lands. Capped to selected + last 5 to bound
  // memory on dashboards left open across many sessions.
  const previewCache = new Map<string, string[]>()
  let lastPreviewFetch = 0

  // ─── terminal setup ────────────────────────────────────────────
  const enterAlt = "\x1b[?1049h"
  const exitAlt = "\x1b[?1049l"
  const hideCur = "\x1b[?25l"
  const showCur = "\x1b[?25h"
  process.stdout.write(enterAlt + hideCur)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding("utf8")

  const restore = (): void => {
    process.stdout.write(showCur + exitAlt)
    try {
      process.stdin.setRawMode(false)
    } catch {
      /* ignore */
    }
    process.stdin.pause()
  }

  // ─── data fetchers ─────────────────────────────────────────────
  const refresh = async (): Promise<void> => {
    try {
      sessions = await fetchSessions(endpoint.url)
      if (cursor >= sessions.length) cursor = Math.max(0, sessions.length - 1)
    } catch (err) {
      flash(
        `fetch error: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  const refreshHealth = async (): Promise<void> => {
    try {
      const body = (await httpGetJson<{
        workspace?: string
        uptimeMs?: number
      }>(`${endpoint.url}/health`))
      health = body
    } catch {
      health = null
    }
  }

  /**
   * Fetch the last N lines of the selected session's ring buffer so
   * the detail pane shows what it was doing. Background — call site
   * doesn't await; render() reads from the cache. Throttled because
   * the dashboard tick already polls every second; we only re-fetch
   * the preview on selection change or every ~3 ticks.
   */
  const refreshPreview = async (id: string): Promise<void> => {
    try {
      const body = await httpGetJson<{
        lines?: string[]
        bytes?: string | null
      }>(`${endpoint.url}/sessions/${encodeURIComponent(id)}/preview?lines=10`)
      const lines: string[] = []
      if (Array.isArray(body.lines) && body.lines.length > 0) {
        lines.push(...body.lines)
      } else if (typeof body.bytes === "string" && body.bytes.length > 0) {
        // PTY session — split the base64-decoded tail into displayable
        // lines. Strip ANSI escapes; the dashboard's table layout
        // would otherwise show garbled cursor moves / colours.
        try {
          const buf = Buffer.from(body.bytes, "base64").toString("utf8")
          const stripped = buf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
          const split = stripped.split("\n").filter(l => l.length > 0)
          lines.push(...split.slice(-10))
        } catch {
          // ignore decode errors
        }
      }
      previewCache.set(id, lines)
      // Bound cache: keep only entries for currently-visible sessions
      // plus a handful of recent ones.
      if (previewCache.size > 12) {
        const stale = [...previewCache.keys()].slice(0, previewCache.size - 12)
        for (const k of stale) previewCache.delete(k)
      }
    } catch {
      // best-effort; leave whatever was cached
    }
  }

  // ─── events SSE ────────────────────────────────────────────────
  const eventsUrl = new URL(`${endpoint.url}/events`)
  const lib = eventsUrl.protocol === "https:" ? https : http
  const eventsReq = lib.get(
    eventsUrl,
    { headers: { accept: "text/event-stream" } },
    res => {
      let buf = ""
      res.setEncoding("utf8")
      res.on("data", chunk => {
        buf += chunk
        let idx = buf.indexOf("\n\n")
        while (idx !== -1) {
          const event = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of event.split("\n")) {
            if (!line.startsWith("data:")) continue
            try {
              const payload = JSON.parse(line.slice(5).trim()) as {
                type?: string
                at?: string
                [k: string]: unknown
              }
              const summary = summariseEvent(payload)
              if (summary) {
                recentEvents.push({
                  at: shortTime(payload.at ?? new Date().toISOString()),
                  line: summary,
                })
                if (recentEvents.length > 5) recentEvents.shift()
                render()
              }
            } catch {
              /* ignore malformed frames */
            }
          }
          idx = buf.indexOf("\n\n")
        }
      })
      res.on("end", () => void 0)
    },
  )
  eventsReq.on("error", () => void 0)

  // ─── key handling ──────────────────────────────────────────────
  let keyBuf = ""
  const onKey = (raw: Buffer | string): void => {
    keyBuf += typeof raw === "string" ? raw : raw.toString("utf8")
    while (keyBuf.length > 0) {
      // Try to consume a recognised sequence.
      if (keyBuf.startsWith("\x1b[A")) {
        keyBuf = keyBuf.slice(3)
        if (cursor > 0) cursor--
        const t = sessions[cursor]
        if (t && !previewCache.has(t.id)) void refreshPreview(t.id).then(render)
        render()
        continue
      }
      if (keyBuf.startsWith("\x1b[B")) {
        keyBuf = keyBuf.slice(3)
        if (cursor < sessions.length - 1) cursor++
        const t = sessions[cursor]
        if (t && !previewCache.has(t.id)) void refreshPreview(t.id).then(render)
        render()
        continue
      }
      const hit = decodeWatchKey(keyBuf.charAt(0))
      keyBuf = keyBuf.slice(1)
      switch (hit?.kind) {
        case "down": {
          if (cursor < sessions.length - 1) cursor++
          const t = sessions[cursor]
          if (t && !previewCache.has(t.id)) void refreshPreview(t.id).then(render)
          render()
          break
        }
        case "up": {
          if (cursor > 0) cursor--
          const t = sessions[cursor]
          if (t && !previewCache.has(t.id)) void refreshPreview(t.id).then(render)
          render()
          break
        }
        case "quit":
          stop = true
          return
        case "refresh":
          flash("refreshing…")
          void Promise.all([refresh(), refreshHealth()]).finally(render)
          break
        case "attach": {
          const t = sessions[cursor]
          if (t) {
            action = "attach"
            attachTargetId = t.id
            stop = true
            return
          }
          break
        }
        case "story": {
          const t = sessions[cursor]
          if (t) {
            action = "story"
            attachTargetId = t.id
            stop = true
            return
          }
          break
        }
        case "mirror": {
          // Read-only mirror — safer than full attach because Ctrl-C
          // cleanly exits without needing the Ctrl-] q chord some
          // terminal emulators swallow.
          const t = sessions[cursor]
          if (t) {
            action = "mirror"
            attachTargetId = t.id
            stop = true
            return
          }
          break
        }
        case "restart": {
          // Restart: respawn from history without leaving the dashboard.
          // Inline httpPostJson (like K kill) so failures flash inline
          // and a successful restart shows up in the next refresh —
          // never tears down the watch loop or the parent daemon.
          const t = sessions[cursor]
          if (!t) continue
          void restartSessionInline(endpoint, t)
            .then(msg => flash(msg))
            .catch(err =>
              flash(
                `restart error: ${err instanceof Error ? err.message : String(err)}`,
              ),
            )
            .finally(() => void refresh().then(render))
          break
        }
        case "kill": {
          const t = sessions[cursor]
          if (!t) continue
          void httpPostJson<{ ok: boolean }>(
            `${endpoint.url}/sessions/${encodeURIComponent(t.id)}/kill`,
            {},
            endpoint.token,
          )
            .then(out =>
              flash(out.ok ? `SIGTERM sent to ${t.id}` : `${t.id} not running`),
            )
            .catch(err =>
              flash(
                `kill error: ${err instanceof Error ? err.message : String(err)}`,
              ),
            )
            .finally(() => void refresh().then(render))
          break
        }
        case "forget": {
          const t = sessions[cursor]
          if (!t) continue
          if (
            t.status !== "exited" &&
            t.status !== "killed" &&
            t.status !== "error"
          ) {
            flash(`d: ${t.id} still ${t.status} — use K first`)
            render()
            continue
          }
          void httpDelete(
            `${endpoint.url}/sessions/${encodeURIComponent(t.id)}`,
            endpoint.token,
          )
            .then(() => {
              flash(`forgot ${t.id}`)
              return refresh()
            })
            .catch(err =>
              flash(
                `forget error: ${err instanceof Error ? err.message : String(err)}`,
              ),
            )
            .finally(() => render())
          break
        }
        default:
          break
      }
      // Unknown chars silently discarded — TUI stays calm.
    }
  }

  const flash = (msg: string): void => {
    statusMsg = msg
    statusMsgUntil = Date.now() + 3_000
  }

  // ─── render ────────────────────────────────────────────────────
  const c = colour
    ? {
        reset: "\x1b[0m",
        dim: "\x1b[2m",
        bold: "\x1b[1m",
        reverse: "\x1b[7m",
        green: "\x1b[32m",
        amber: "\x1b[33m",
        cyan: "\x1b[36m",
        red: "\x1b[31m",
      }
    : {
        reset: "",
        dim: "",
        bold: "",
        reverse: "",
        green: "",
        amber: "",
        cyan: "",
        red: "",
      }
  const statusTone = (
    s: PresenceRenderSession,
  ): string => {
    if (isStaleRunning(s)) return c.amber
    if (s.status !== "running") {
      return s.status === "starting"
        ? c.amber
        : s.status === "killed" || s.status === "error"
          ? c.red
          : c.dim
    }
    // Live agent-cli session — colour by the same presence axis as the table,
    // so a parked session reads dim, not healthy green.
    switch (presenceFor(s, { attentionDelaySec })) {
      case "running":
      case "tending":
        return c.green
      case "attention":
        return c.amber
      case "quiet":
        return c.dim
      default:
        return c.dim
    }
  }

  const render = (): void => {
    const cols = process.stdout.columns || 100
    const rows = process.stdout.rows || 30
    // Layout: 1 header, 1 separator, body (rows-5), 1 separator, 1 events, 1 footer.
    const bodyRows = Math.max(5, rows - 5)
    const sidebarWidth = Math.min(48, Math.max(34, Math.floor(cols * 0.4)))
    const detailWidth = cols - sidebarWidth - 1
    const sep = c.dim + "│" + c.reset
    const out: string[] = []

    // Row 1: header. Truncate to fit `cols` so it doesn't wrap and
    // push the rest of the screen down by a row (which manifested as
    // the title appearing to be missing in narrow terminals).
    const home = process.env.HOME ?? ""
    const ws =
      health?.workspace && home && health.workspace.startsWith(home)
        ? "~" + health.workspace.slice(home.length)
        : health?.workspace ?? "?"
    const headerLeft = `${c.bold}agentproto monitor${c.reset} ${c.dim}·${c.reset} ${c.cyan}${endpoint.url}${c.reset}`
    const headerRight = `${c.dim}workspace${c.reset} ${ws} ${c.dim}·${c.reset} ${c.dim}uptime${c.reset} ${humaniseDelta(health?.uptimeMs ?? 0)}`
    out.push(fitRow(headerLeft, headerRight, cols))
    out.push(c.dim + "─".repeat(cols) + c.reset)

    // Sidebar + detail (bodyRows lines). padEndVisible counts ANSI
    // escapes as zero-width so the column separator lands at the
    // sidebarWidth-th visible column, not the sidebarWidth-th
    // string-index (which over-pads when colors are on).
    const sidebarLines = renderSidebar(
      sessions,
      cursor,
      sidebarWidth,
      bodyRows,
      c,
      statusTone,
      attentionDelaySec,
    )
    const selected = sessions[cursor]
    const preview = selected ? previewCache.get(selected.id) : undefined
    const detailLines = renderDetail(selected, detailWidth, bodyRows, c, preview)
    for (let i = 0; i < bodyRows; i++) {
      out.push(
        padEndVisible(sidebarLines[i] ?? "", sidebarWidth) +
          sep +
          (detailLines[i] ?? ""),
      )
    }
    out.push(c.dim + "─".repeat(cols) + c.reset)

    // Events strip
    const evLine = recentEvents.length === 0
      ? `${c.dim}events  ·  (no events yet)${c.reset}`
      : `${c.dim}events${c.reset}  ` +
        recentEvents
          .map(e => `${c.dim}${e.at}${c.reset} ${e.line}`)
          .join(`  ${c.dim}·${c.reset}  `)
    out.push(truncateAnsi(evLine, cols))

    // Footer
    const showFlash =
      statusMsg && Date.now() < statusMsgUntil
    const selectedDesc = sessions[cursor]
    const isDead =
      selectedDesc &&
      (selectedDesc.status === "exited" ||
        selectedDesc.status === "killed" ||
        selectedDesc.status === "error")
    const footer = showFlash
      ? `${c.amber}${statusMsg}${c.reset}`
      : isDead
        ? `${c.dim}↑/↓ select · s story · ${c.reset}${c.bold}R restart${c.reset}${c.dim} · m mirror · d forget · r refresh · q quit${c.reset}`
        : `${c.dim}↑/↓ select · Enter attach · s story · R restart · m mirror · K kill · d forget · r refresh · q quit${c.reset}`
    out.push(truncateAnsi(footer, cols))

    // Paint: clear + home + write.
    process.stdout.write("\x1b[H\x1b[2J" + out.join("\n"))
  }

  // ─── signals + cleanup ─────────────────────────────────────────
  const onResize = (): void => render()
  process.stdin.on("data", onKey)
  process.stdout.on("resize", onResize)
  const sigintHandler = (): void => {
    stop = true
  }
  process.once("SIGINT", sigintHandler)

  try {
    await Promise.all([refresh(), refreshHealth()])
    // Initial preview for the first session.
    if (sessions[cursor]) void refreshPreview(sessions[cursor]!.id)
    render()
    let ticks = 0
    while (!stop) {
      await new Promise<void>(res => setTimeout(res, 1_000))
      if (stop) break
      ticks++
      // Sessions every 2 s, health every 10 s — health rarely
      // changes after boot, no point hammering it.
      if (ticks % 2 === 0) await refresh()
      if (ticks % 10 === 0) await refreshHealth()
      // Preview every 3 s for the currently-selected session — keep
      // the panel feeling alive without hammering the daemon.
      if (ticks - lastPreviewFetch >= 3) {
        const t = sessions[cursor]
        if (t) void refreshPreview(t.id)
        lastPreviewFetch = ticks
      }
      render()
    }
  } finally {
    eventsReq.destroy()
    process.stdin.off("data", onKey)
    process.stdout.off("resize", onResize)
    process.off("SIGINT", sigintHandler)
    restore()
  }

  if (action === "attach" && attachTargetId) {
    // Run the attach, then re-enter the watch loop so the dashboard
    // doesn't disappear after a detach. The user gets the natural
    // workflow: peek at a session, drive it, detach, see the list
    // again, pick another one — until they hit q.
    const code = await runAttach({
      endpoint,
      idOrName: attachTargetId,
      colour,
    })
    void code
    return runWatch(endpoint, colour)
  }
  if (action === "mirror" && attachTargetId) {
    const code = await runMirror([attachTargetId])
    void code
    return runWatch(endpoint, colour)
  }
  if (action === "story" && attachTargetId) {
    // Render the story on the normal terminal, then re-enter the
    // watch loop — same "peek, then return to the list" flow as
    // attach/mirror. Leave the alt screen + raw mode first so the
    // transcript isn't painted over the dashboard buffer.
    restore()
    const code = await runStory([attachTargetId])
    void code
    return runWatch(endpoint, colour)
  }
  return 0
}

/**
 * Restart a session without exiting the watch loop. Mirrors what
 * `runRestart` does — looks up the descriptor, picks the right
 * route, sends the body — but returns a short status string for
 * the dashboard's flash banner instead of writing to stderr / exit
 * code. Errors propagate so the caller can format the message.
 *
 * For agent-cli sessions we attempt to resume the conversation via
 * the prior adapter session id. Adapters (claude-code, hermes)
 * persist that id only AFTER the first turn — a session killed
 * before it had any conversation reports "Resource not found" on
 * resume. In that case we automatically retry the same shape WITHOUT
 * resumeSessionId so the user at least gets their command back; the
 * banner makes the fallback explicit so they know history was lost.
 */
async function restartSessionInline(
  endpoint: DaemonEndpoint,
  prev: SessionDescriptor,
): Promise<string> {
  const augmented = await augmentWithFsResume(prev)
  const built = buildRestartBody(augmented)
  return executeRestartWithFallback(endpoint, augmented, built)
}

interface RestartBody {
  url: string
  body: Record<string, unknown>
}

/**
 * Translate the shared `decideRestartStrategy` decision into a
 * `{url, body}` REST call — the CLI-specific half (cols/rows come from
 * the attached terminal). The daemon's `session_restart` MCP tool runs
 * the same decision in-process instead of shaping an HTTP body.
 *
 * `preferNativeTerminal` mirrors `session_restart`'s own opt-in (session-
 * tools.ts): an agent-cli/ACP-origin session defaults to ACP-level resume,
 * never a surprise provider-native terminal (its isolated config dir was
 * never TUI-onboarded — see `decideRestartStrategy`'s doc). Omitted here ⇒
 * false, same default.
 */
function buildRestartBody(prev: SessionDescriptor, preferNativeTerminal = false): RestartBody {
  const strategy = decideRestartStrategy(prev, { preferNativeTerminal })
  if (strategy.kind === "unsupported") {
    throw new Error(`${prev.id} is a ${strategy.reason}`)
  }
  if (strategy.kind === "agent") {
    return {
      url: "__agent__",
      body: {
        adapter: prev.adapterSlug,
        cwd: prev.cwd ?? undefined,
        workspaceSlug: prev.workspaceSlug,
        ...(strategy.resumeSessionId
          ? { resumeSessionId: strategy.resumeSessionId }
          : {}),
        ...(prev.label ? { label: prev.label } : {}),
      },
    }
  }
  const argv =
    strategy.kind === "pty-native"
      ? strategy.argv
      : Array.isArray(prev.argv)
        ? prev.argv
        : tokenizeCommand(prev.command)
  return {
    url: "__pty__",
    body: {
      argv,
      cwd: prev.cwd ?? undefined,
      workspaceSlug: prev.workspaceSlug,
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      ...(prev.name ? { name: prev.name } : {}),
      ...(prev.label ? { label: prev.label } : {}),
    },
  }
}

async function executeRestartWithFallback(
  endpoint: DaemonEndpoint,
  prev: SessionDescriptor,
  built: RestartBody,
): Promise<string> {
  const url =
    built.url === "__pty__"
      ? `${endpoint.url}/sessions/terminal`
      : `${endpoint.url}/sessions/agent`
  try {
    const next = await httpPostJson<SessionDescriptor>(
      url,
      built.body,
      endpoint.token,
    )
    const path = describeResumePath(prev)
    return `restarted ${prev.id} → ${next.id}${
      next.name ? ` (${next.name})` : ""
    }${path ? ` (${path})` : ""}`
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Adapter doesn't recognize the resume id — typically means the
    // session never got past the spawn (no turn happened). Retry
    // without resume so the user at least gets the command back.
    if (
      built.body.resumeSessionId &&
      RESUME_ID_REJECTED_RE.test(msg)
    ) {
      const { resumeSessionId, ...rest } = built.body
      void resumeSessionId
      const next = await httpPostJson<SessionDescriptor>(
        url,
        rest,
        endpoint.token,
      )
      return `restarted ${prev.id} → ${next.id}${
        next.name ? ` (${next.name})` : ""
      } (fresh — resume not available)`
    }
    throw err
  }
}

function renderSidebar(
  rows: SessionDescriptor[],
  cursor: number,
  width: number,
  height: number,
  c: Record<string, string>,
  statusTone: (s: PresenceRenderSession) => string,
  attentionDelaySec?: number,
): string[] {
  const out: string[] = []
  out.push(`${c.bold}SESSIONS${c.reset} ${c.dim}(${rows.length})${c.reset}`)
  out.push("")
  if (rows.length === 0) {
    out.push(`${c.dim}  (none — spawn one)${c.reset}`)
  } else {
    const now = Date.now()
    for (let i = 0; i < rows.length && out.length < height; i++) {
      const r = rows[i]!
      const selected = i === cursor
      const marker = selected ? `${c.cyan}▸${c.reset}` : " "
      const ptyBadge = r.pty
        ? `${c.green}PTY${c.reset}`
        : `${c.dim}   ${c.reset}`
      const label = sessionRowLabel(r)
      const tone = statusTone(r)
      const age = humaniseDelta(now - new Date(r.startedAt).getTime())
      const labelTrunc = truncate(label, 18)
      const line =
        `${marker} ${ptyBadge} ${labelTrunc.padEnd(18)} ${tone}${statusLabel(r, attentionDelaySec).padEnd(7)}${c.reset} ${c.dim}${age.padStart(4)}${c.reset}`
      out.push(selected ? line : line)
    }
  }
  while (out.length < height) out.push("")
  void width
  return out.slice(0, height)
}

export function renderDetail(
  s: SessionDescriptor | undefined,
  width: number,
  height: number,
  c: Record<string, string>,
  preview: string[] | undefined,
): string[] {
  const out: string[] = []
  if (!s) {
    out.push(`${c.bold}DETAIL${c.reset}`)
    out.push("")
    out.push(`${c.dim}  no session selected${c.reset}`)
  } else {
    const now = Date.now()
    out.push(`${c.bold}DETAIL${c.reset}`)
    out.push("")
    const kw = (k: string): string => `${c.dim}${k.padEnd(10)}${c.reset}`
    out.push(`  ${kw("id")} ${s.id}`)
    if (s.name) out.push(`  ${kw("name")} ${c.bold}${s.name}${c.reset}`)
    out.push(`  ${kw("kind")} ${s.kind}${s.pty ? ` ${c.green}(pty)${c.reset}` : ""}`)
    const stale = isStaleRunning(s)
    out.push(
      `  ${kw("status")} ${stale ? c.amber : ""}${s.status}${
        stale ? ` ⚠ dead pid${c.reset}` : ""
      }`,
    )
    const turnsDone = s.turnsCompleted ?? 0
    out.push(
      `  ${kw("activity")} ${
        s.awaitingPermission
          ? `${c.amber}! permission held${c.reset}`
          : s.busy
          ? `${c.green}● busy${c.reset}`
          : s.awaitingInput
            ? `${c.amber}? awaiting input${c.reset}`
            : turnsDone > 0
              ? `${c.dim}○ idle (${turnsDone} turn${turnsDone === 1 ? "" : "s"} done)${c.reset}`
              : `${c.dim}idle${c.reset}`
      }`,
    )
    // Usage line — same cost/token/context data MCP's session_usage and
    // agent_sessions_list already expose over JSON, surfaced here so the
    // interactive dashboard doesn't force a drop to --json for it.
    // Omitted entirely (not zeroed) when the adapter hasn't reported any
    // usage yet — see SessionDescriptor.costUsd's doc comment.
    const usageParts: string[] = []
    if (s.costUsd !== undefined) usageParts.push(`$${s.costUsd.toFixed(4)}`)
    if (s.tokensIn !== undefined || s.tokensOut !== undefined) {
      usageParts.push(`${s.tokensIn ?? 0} in / ${s.tokensOut ?? 0} out tok`)
    }
    if (s.contextUsed !== undefined && s.contextSize !== undefined && s.contextSize > 0) {
      usageParts.push(
        `ctx ${Math.round((s.contextUsed / s.contextSize) * 100)}%`,
      )
    }
    if (usageParts.length > 0) {
      out.push(`  ${kw("usage")} ${c.dim}${usageParts.join(" · ")}${c.reset}`)
    }
    out.push(`  ${kw("workspace")} ${s.workspaceSlug}`)
    if (s.cwd) out.push(`  ${kw("cwd")} ${c.dim}${truncate(s.cwd, width - 14)}${c.reset}`)
    // Which worktree the agent is in — the edge recorded at spawn (see
    // SessionDescriptor.worktreePath), not re-derived from `cwd` here: the
    // worktree may already be gone. The id pins the generation and is absent
    // for a worktree made by a bare `git worktree add`; `cwd` above carries
    // the exact directory when it's a subdir of the root shown here.
    if (s.worktreePath) {
      out.push(
        `  ${kw("worktree")} ${truncate(basename(s.worktreePath), width - 14)}` +
          (s.worktreeId ? ` ${c.dim}${s.worktreeId}${c.reset}` : ""),
      )
    }
    out.push(`  ${kw("command")} ${c.dim}${truncate(s.command, width - 14)}${c.reset}`)
    out.push(`  ${kw("pid")} ${s.pid ?? "—"}`)
    out.push(`  ${kw("started")} ${humaniseDelta(now - new Date(s.startedAt).getTime())} ago`)
    if (s.lastOutputAt)
      out.push(
        `  ${kw("last out")} ${humaniseDelta(now - new Date(s.lastOutputAt).getTime())} ago`,
      )
    if (s.exitCode !== undefined)
      out.push(`  ${kw("exit code")} ${s.exitCode}`)

    // Resume info — captured ids so the user can verify the
    // continuity machinery actually saw what it needed. claudeResumeId
    // is the most-useful one (provider-native resume); ACP id is the
    // fallback. Both displayed when present.
    if (s.adapterSlug) {
      out.push(`  ${kw("adapter")} ${s.adapterSlug}`)
    }
    // Verifiability: the resolved billing-auth mode + a non-secret
    // credential fingerprint (never the raw secret) — see
    // `credentialFingerprint` in @agentproto/runtime's spawn-defaults.ts.
    // Absent for adapters that don't resolve an explicit credential.
    if (s.auth) {
      out.push(`  ${kw("auth")} ${c.dim}${s.auth.fingerprint}${c.reset}`)
    }
    if (s.adapterSessionId) {
      out.push(
        `  ${kw("acp id")} ${c.dim}${truncate(s.adapterSessionId, width - 14)}${c.reset}`,
      )
    }
    if (s.resumeMetadata) {
      for (const [k, v] of Object.entries(s.resumeMetadata)) {
        out.push(
          `  ${kw(shortKey(k))} ${c.green}${truncate(String(v), width - 14)}${c.reset}`,
        )
      }
    }

    out.push("")
    if (s.status === "running" || s.status === "starting") {
      const isTerm = isTerminalSession(s)
      out.push(
        `  ${c.dim}Enter to attach${isTerm ? ` (PTY)` : ""} · s story${c.reset}`,
      )
    } else if (
      s.status === "exited" ||
      s.status === "killed" ||
      s.status === "error"
    ) {
      out.push(`  ${c.dim}R to restart${c.reset}`)
    }

    // Preview: last N lines from the session's ring buffer, fetched
    // by the dashboard in the background. Helps the user see what
    // the session was doing without committing to an attach.
    if (preview && preview.length > 0) {
      out.push("")
      out.push(`  ${c.dim}── recent output ──${c.reset}`)
      for (const line of preview) {
        out.push(`  ${c.dim}${truncate(line, width - 4)}${c.reset}`)
      }
    }
  }
  while (out.length < height) out.push("")
  return out.slice(0, height)
}

/** Compact display label for resumeMetadata keys. */
function shortKey(k: string): string {
  // claudeResumeId → "claude id", hermesResumeId → "hermes id", …
  const m = k.match(/^([a-z]+)ResumeId$/i)
  return m ? `${m[1]!.toLowerCase()} id` : k
}

/**
 * Reduce a RuntimeEvent to a one-liner for the events strip. Returns
 * null for events we don't want to surface (heartbeat-error spam,
 * etc).
 */
function summariseEvent(ev: Record<string, unknown>): string | null {
  const type = typeof ev.type === "string" ? ev.type : "?"
  switch (type) {
    case "boot":
      return `boot · ${(ev.workspace as string | undefined)?.split("/").pop() ?? "?"}`
    case "remote-log":
      return `tunnel: ${truncate(String(ev.line ?? ""), 60)}`
    case "session-spawn":
      return `spawn ${ev.id ?? "?"}`
    case "session-exit":
      return `exit ${ev.id ?? "?"} (${ev.exitCode ?? "?"})`
    case "heartbeat-error":
      return `heartbeat error ${truncate(String(ev.error ?? ""), 40)}`
    default:
      return `${type}`
  }
}

function shortTime(iso: string): string {
  try {
    const d = new Date(iso)
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`
  } catch {
    return "??:??:??"
  }
}

/**
 * Build a left/right justified row that NEVER overflows `cols`. When
 * left + right would exceed the width, the right side is dropped
 * first (it's metadata — keep the title). When even the left side
 * is too wide, truncate with `…`. Without this, the row wraps and
 * pushes the rest of the screen down by a line.
 */
function fitRow(left: string, right: string, cols: number): string {
  const leftLen = stripAnsi(left).length
  const rightLen = stripAnsi(right).length
  if (leftLen + 1 + rightLen <= cols) {
    return left + " ".repeat(cols - leftLen - rightLen) + right
  }
  if (leftLen <= cols) {
    return left + " ".repeat(Math.max(0, cols - leftLen))
  }
  return truncateAnsi(left, cols)
}

/**
 * Right-pad a possibly-ANSI-containing string to a target VISIBLE
 * width. Plain `String.prototype.padEnd` counts ANSI escape bytes
 * as visible characters, which pushes the next column right of its
 * intended position by however many bytes of color codes are in the
 * string. This helper counts visible chars only.
 */
function padEndVisible(s: string, width: number): string {
  const visible = stripAnsi(s).length
  if (visible >= width) return s
  return s + " ".repeat(width - visible)
}

function truncateAnsi(s: string, max: number): string {
  // ANSI escapes are zero-width so truncation should account for them.
  // Simple approach: strip, count visible, slice raw to roughly the
  // same prefix. Good enough for header / footer fixed strings.
  const visible = stripAnsi(s).length
  if (visible <= max) return s
  // Pessimistic: just cut to `max` chars; rare case anyway.
  return s.slice(0, max - 1) + "…"
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

interface AttachOpts {
  endpoint: DaemonEndpoint
  /** id or name. We fetch the descriptor first and switch transport
   *  (SSE vs PTY WS) based on `desc.pty`. */
  idOrName: string
  colour: boolean
}

/**
 * `agentproto sessions mirror <id-or-name>` — read-only tail of a
 * PTY session. Unlike `--attach`, this NEVER takes stdin: Ctrl-C
 * exits the mirror process cleanly without affecting the underlying
 * session. Great for peeking at what an agent or a long-running TUI
 * is doing without committing to a full duplex attach (and the
 * Ctrl-] q detach chord some terminals swallow).
 *
 * For non-PTY sessions, falls back to the existing line-based SSE
 * stream (also already read-only).
 */
/**
 * `agentproto sessions restart <id-or-name>` — respawn a session
 * from history. Looks up the descriptor (alive or historical),
 * clones its kind/argv/cwd/workspace/name/label, and starts a fresh
 * instance via the matching route (/sessions/terminal for PTY,
 * /sessions/agent for ACP agents).
 *
 * The new session gets a new id but reuses the original `name`
 * (which the daemon freed when the old session became
 * killed/exited). Output buffers are NOT carried over — we only
 * persist descriptor metadata, not byte streams.
 */
async function runRestart(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      attach: { type: "boolean" },
      json: { type: "boolean" },
      "no-color": { type: "boolean" },
      "prefer-native-terminal": { type: "boolean" },
    },
  })
  const id = positionals[0]
  if (!id) {
    process.stderr.write(
      "agentproto sessions restart: missing session id or name.\n" +
        "  Try: agentproto sessions restart claude-tui\n",
    )
    return 2
  }
  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sessions restart")
    return 2
  }
  const endpoint = report.found

  // Fetch the (possibly historical) descriptor.
  let prev: SessionDescriptor
  try {
    prev = await httpGetJson<SessionDescriptor>(
      `${endpoint.url}/sessions/${encodeURIComponent(id)}`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(
        `agentproto sessions restart: no session "${id}" found in registry or history.\n`,
      )
      return 2
    }
    process.stderr.write(`agentproto sessions restart: ${msg}\n`)
    return 1
  }

  // Augment with provider-fs-derived resume id when our own capture
  // missed it (e.g., the session was killed before printing the
  // resume hint), then build the body.
  prev = await augmentWithFsResume(prev)
  let built: RestartBody
  try {
    built = buildRestartBody(prev, values["prefer-native-terminal"] === true)
  } catch (err) {
    process.stderr.write(
      `agentproto sessions restart: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 2
  }
  const body = built.body
  const url =
    built.url === "__pty__"
      ? `${endpoint.url}/sessions/terminal`
      : `${endpoint.url}/sessions/agent`

  let next: SessionDescriptor
  let resumeFallback = false
  try {
    next = await httpPostJson<SessionDescriptor>(url, body, endpoint.token)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 401/.test(msg)) {
      process.stderr.write(
        (await explain401(endpoint, "agentproto sessions restart")) + "\n",
      )
      return 1
    }
    // Adapter doesn't know the resume id — retry without it.
    if (body.resumeSessionId && RESUME_ID_REJECTED_RE.test(msg)) {
      try {
        const { resumeSessionId: _, ...rest } = body
        void _
        next = await httpPostJson<SessionDescriptor>(
          url,
          rest,
          endpoint.token,
        )
        resumeFallback = true
      } catch (err2) {
        process.stderr.write(
          `agentproto sessions restart: ${err2 instanceof Error ? err2.message : String(err2)}\n`,
        )
        return 1
      }
    } else {
      process.stderr.write(`agentproto sessions restart: ${msg}\n`)
      return 1
    }
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(next, null, 2) + "\n")
  } else {
    const lineage = resumeFallback
      ? "fresh — resume not available"
      : describeResumePath(prev, {
          preferNativeTerminal: values["prefer-native-terminal"] === true,
        }) || "fresh shape"
    process.stdout.write(
      `agentproto sessions restart: spawned ${next.id}` +
        `${next.name ? ` (${next.name})` : ""} — ${next.command}\n` +
        `  (${lineage} from ${prev.id})\n`,
    )
  }

  if (values.attach) {
    return runAttach({
      endpoint,
      idOrName: next.id,
      colour: !values["no-color"],
    })
  }
  return 0
}

async function runMirror(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { "no-color": { type: "boolean" } },
  })
  const id = positionals[0]
  if (!id) {
    process.stderr.write(
      "agentproto sessions mirror: missing session id or name.\n" +
        "  Try: agentproto sessions mirror claude-tui\n",
    )
    return 2
  }
  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sessions mirror")
    return 2
  }
  const endpoint = report.found
  let desc: SessionDescriptor
  try {
    desc = await httpGetJson<SessionDescriptor>(
      `${endpoint.url}/sessions/${encodeURIComponent(id)}`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(
        `agentproto sessions mirror: no session "${id}".\n`,
      )
      return 2
    }
    process.stderr.write(`agentproto sessions mirror: ${msg}\n`)
    return 1
  }
  // Pre-attach status check — the underlying PTY process is gone for
  // exited/killed/error sessions; the WS upgrade would only return a
  // confusing close 1011 mid-stream. Tell the user what happened and
  // point at restart.
  if (
    desc.pty === true &&
    (desc.status === "exited" ||
      desc.status === "killed" ||
      desc.status === "error")
  ) {
    printDeadSessionHint("agentproto sessions mirror", desc)
    return 2
  }
  if (desc.pty === true) {
    return runPtyMirror(endpoint, desc)
  }
  // SSE stream is already read-only — same shape as --attach for
  // non-PTY sessions. Reuse it directly so `mirror` is symmetric.
  return runSseAttach(endpoint, desc, !values["no-color"])
}

/**
 * Read-only WS attach to a PTY session. Bytes flow ONLY from daemon
 * → stdout. stdin stays in the user's normal shell state — Ctrl-C
 * triggers SIGINT to this Node process, which exits cleanly without
 * touching the underlying PTY (the daemon-side handle.detach() runs
 * on WS close, leaving the session alive for other attachers).
 */
async function runPtyMirror(
  endpoint: DaemonEndpoint,
  desc: SessionDescriptor,
): Promise<number> {
  return new Promise(done => {
    const initialCols = process.stdout.columns ?? 80
    const initialRows = process.stdout.rows ?? 24
    const wsUrl = `${endpoint.url.replace(/^http/, "ws")}/sessions/${desc.id}/pty?cols=${initialCols}&rows=${initialRows}`
    const ws = new WebSocket(wsUrl, {
      headers: endpoint.token
        ? { authorization: `Bearer ${endpoint.token}` }
        : {},
    })

    process.stderr.write(
      `\x1b[2m─ mirroring ${desc.id}${desc.name ? ` (${desc.name})` : ""} · read-only · Ctrl-C to exit ·\x1b[0m\n`,
    )

    let closed = false
    const close = (code: number): void => {
      if (closed) return
      closed = true
      try {
        ws.close(1000, "client mirror end")
      } catch {
        // ignore
      }
      done(code)
    }

    ws.on("message", raw => {
      let frame: unknown
      try {
        frame = JSON.parse(raw.toString("utf8"))
      } catch {
        return
      }
      if (!frame || typeof frame !== "object") return
      const f = frame as Record<string, unknown>
      if (f.kind === "data" && typeof f.b64 === "string") {
        try {
          process.stdout.write(Buffer.from(f.b64, "base64"))
        } catch {
          /* ignore */
        }
      } else if (f.kind === "exit") {
        const code = typeof f.exitCode === "number" ? f.exitCode : 0
        process.stderr.write(
          `\n\x1b[2m─ session ${desc.id} exited (code ${code}) ·\x1b[0m\n`,
        )
        close(code)
      }
    })
    ws.on("error", err => {
      process.stderr.write(`agentproto sessions mirror: ${err.message}\n`)
      close(1)
    })
    ws.on("close", () => close(0))
    process.on("SIGINT", () => {
      process.stderr.write(
        `\n\x1b[2m─ mirror ended · session still running on daemon ·\x1b[0m\n`,
      )
      close(0)
    })
  })
}

async function runAttach(opts: AttachOpts): Promise<number> {
  // Fetch the descriptor first. The daemon's GET handler resolves
  // id-or-name (see findByIdOrName in sessions.ts), so a typo
  // surfaces as a clean 404 here rather than mid-stream silence.
  let desc: SessionDescriptor
  try {
    desc = await httpGetJson<SessionDescriptor>(
      `${opts.endpoint.url}/sessions/${encodeURIComponent(opts.idOrName)}`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(
        `agentproto sessions --attach: no session "${opts.idOrName}".\n`,
      )
      return 2
    }
    process.stderr.write(`agentproto sessions --attach: ${msg}\n`)
    return 1
  }
  if (
    desc.status === "exited" ||
    desc.status === "killed" ||
    desc.status === "error"
  ) {
    printDeadSessionHint("agentproto sessions --attach", desc)
    return 2
  }
  if (attachMode(desc) === "pty") {
    return runPtyAttach(opts.endpoint, desc, opts.colour)
  }
  return runSseAttach(opts.endpoint, desc, opts.colour)
}

/**
 * Pretty error for attach attempts against a dead session. Surfaces
 * the status + age + the exact restart command. Saves the user from
 * the cryptic "close 1011 — session not attachable" they'd otherwise
 * see when the WS upgrade fails mid-flight.
 */
function printDeadSessionHint(
  verb: string,
  desc: SessionDescriptor,
): void {
  const handle = desc.name ?? desc.id
  const exitInfo =
    typeof desc.exitCode === "number" ? ` exit ${desc.exitCode}` : ""
  const age = desc.endedAt
    ? humaniseDelta(Date.now() - new Date(desc.endedAt).getTime()) + " ago"
    : "previously"
  process.stderr.write(
    `${verb}: session ${desc.id}${desc.name ? ` (${desc.name})` : ""} ` +
      `is \x1b[31m${desc.status}\x1b[0m (${age}${exitInfo}).\n` +
      `  Spawn a fresh instance with the same shape:\n` +
      `    agentproto sessions restart ${handle}\n` +
      `  Or look at its descriptor only:\n` +
      `    agentproto sessions   # see all\n`,
  )
}

async function runSseAttach(
  endpoint: DaemonEndpoint,
  desc: SessionDescriptor,
  colour: boolean,
): Promise<number> {
  return new Promise(done => {
    const url = new URL(`${endpoint.url}/sessions/${desc.id}/stream`)
    const lib = url.protocol === "https:" ? https : http
    const headers: Record<string, string> = { accept: "text/event-stream" }
    if (endpoint.token) headers.authorization = `Bearer ${endpoint.token}`
    process.stderr.write(
      `\x1b[2m─ attached to ${desc.id}${desc.name ? ` (${desc.name})` : ""} · Ctrl-C to detach ·\x1b[0m\n`,
    )
    const req = lib.get(url, { headers }, res => {
      if (res.statusCode === 404) {
        process.stderr.write(
          `agentproto sessions --attach: no session "${desc.id}".\n`,
        )
        done(2)
        return
      }
      if (res.statusCode !== 200) {
        process.stderr.write(
          `agentproto sessions --attach: HTTP ${res.statusCode}\n`,
        )
        done(1)
        return
      }
      let buf = ""
      res.setEncoding("utf8")
      res.on("data", chunk => {
        buf += chunk
        let idx = buf.indexOf("\n\n")
        while (idx !== -1) {
          const event = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of event.split("\n")) {
            if (line.startsWith("data:")) {
              const payload = line.slice(5).trim()
              try {
                const json = JSON.parse(payload) as {
                  line?: string
                  stream?: "stdout" | "stderr"
                }
                if (typeof json.line !== "string") continue
                if (colour && json.stream === "stderr") {
                  process.stdout.write(`\x1b[31m${json.line}\x1b[0m\n`)
                } else {
                  process.stdout.write(json.line + "\n")
                }
              } catch {
                // Ignore ill-formed frames silently — daemon may have
                // sent a comment / heartbeat the parser doesn't model.
              }
            }
          }
          idx = buf.indexOf("\n\n")
        }
      })
      res.on("end", () => done(0))
    })
    req.on("error", err => {
      process.stderr.write(`agentproto sessions --attach: ${err.message}\n`)
      done(1)
    })
    process.on("SIGINT", () => {
      req.destroy()
      done(0)
    })
  })
}

/**
 * PTY attach via the daemon's `/sessions/:id/pty` WebSocket. Sets the
 * caller's stdin to raw mode so every keystroke flows to the child
 * verbatim (including Ctrl-C → SIGINT in the PTY). Detach chord:
 *   Ctrl-]  q   close the WS, restore terminal modes, exit code 0
 * Without the chord the session stays alive on the daemon when the
 * process exits / closes. Resize is bridged via SIGWINCH.
 */
async function runPtyAttach(
  endpoint: DaemonEndpoint,
  desc: SessionDescriptor,
  _colour: boolean,
): Promise<number> {
  return new Promise(done => {
    const stdoutTty = process.stdout.isTTY === true
    const stdinTty = process.stdin.isTTY === true
    const initialCols =
      stdoutTty && process.stdout.columns ? process.stdout.columns : 80
    const initialRows =
      stdoutTty && process.stdout.rows ? process.stdout.rows : 24
    const wsUrl = `${endpoint.url.replace(/^http/, "ws")}/sessions/${desc.id}/pty?cols=${initialCols}&rows=${initialRows}`

    // Reconnect policy. close 1006 ("abnormal closure" — the daemon
    // process vanished mid-WS) triggers up to 5 retries with
    // 1s/2s/4s/4s/4s backoff. close 1000 (clean), 4xxx (app-level),
    // and 410/etc on initial handshake all exit immediately. The user
    // gets "── reconnecting (n/5)…" while we try; on success the
    // daemon replays its ring buffer so they see what they missed.
    const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 4_000, 4_000]
    let attempt = 0
    // The active WebSocket — re-pointed on each reconnect so the
    // stdin handler (registered once below) always sends to the
    // current connection.
    let ws: WebSocket = new WebSocket(wsUrl, {
      headers: endpoint.token
        ? { authorization: `Bearer ${endpoint.token}` }
        : {},
    })

    let armed = false
    // Triple-Ctrl-C detach: AZERTY-friendly alternative to Ctrl-] q
    // that doesn't conflict with Claude's own "press Ctrl-C again to
    // exit" UX. Claude exits on the 2nd Ctrl-C → child gone → WS
    // closes naturally. For non-Claude TUIs (bash, vim, htop, …)
    // three Ctrl-Cs in 1s is a deliberate signal we use to detach
    // without taking the child down; the extras forwarded to the
    // child are no-ops in those shells.
    const TRIPLE_CTRLC_WINDOW_MS = 1_000
    const ctrlCTimestamps: number[] = []
    let exitCode = 0
    let restored = false
    const restore = (): void => {
      if (restored) return
      restored = true
      if (stdinTty) {
        try {
          process.stdin.setRawMode(false)
        } catch {
          // ignore
        }
        process.stdin.pause()
      }
      process.stdin.off("data", onStdin)
      process.stdout.off("resize", onResize)
      process.off("SIGWINCH", onResize)
    }

    const onStdin = (raw: Buffer | string): void => {
      if (ws.readyState !== WebSocket.OPEN) return
      // stdin's encoding mode may have been left in "utf8" by a prior
      // helper (printPickerTable, runWatch, …). Coerce to Buffer at
      // the boundary so byte-comparisons in the detach-chord scan are
      // reliable AND multi-byte chars survive base64 round-trip
      // (sending each byte as its own frame would split a 2-byte é).
      const chunk = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw

      // Triple-Ctrl-C detach. Track the last few Ctrl-C timestamps;
      // when three of them fall inside TRIPLE_CTRLC_WINDOW_MS we
      // detach. Each individual Ctrl-C is ALSO forwarded to the
      // child so the user's normal interrupt UX is preserved —
      // Claude's "press Ctrl-C again to exit" still works (it
      // happens on the 2nd press; the 3rd never fires because the
      // child is already gone, no detach is triggered there).
      if (chunk.length === 1 && chunk[0] === 0x03) {
        const now = Date.now()
        ctrlCTimestamps.push(now)
        // Keep only timestamps inside the window.
        while (
          ctrlCTimestamps.length > 0 &&
          now - ctrlCTimestamps[0]! > TRIPLE_CTRLC_WINDOW_MS
        ) {
          ctrlCTimestamps.shift()
        }
        if (ctrlCTimestamps.length >= 3) {
          ctrlCTimestamps.length = 0
          try {
            ws.close(1000, "client detach (triple-ctrlc)")
          } catch {
            // ignore
          }
          return
        }
        // Fall through to forward this Ctrl-C to the child.
      }

      // Detach chord scan: Ctrl-] (0x1d) then q/Q. Either part of the
      // chord may straddle two stdin chunks, so we keep `armed` across
      // invocations.
      let scan = chunk
      if (armed) {
        // Previous chunk ended with 0x1d. If THIS chunk starts with
        // q/Q, detach; otherwise emit the held 0x1d and the new bytes.
        const first = scan[0]
        if (first === 0x71 || first === 0x51) {
          armed = false
          try {
            ws.close(1000, "client detach")
          } catch {
            // ignore
          }
          return
        }
        // Not the chord — flush the held 0x1d as a leading byte by
        // prepending it before further processing.
        scan = Buffer.concat([Buffer.from([0x1d]), scan])
        armed = false
      }

      // Look for an in-chunk 0x1d. If found at the LAST position, hold
      // it for the next stdin event (it might pair with q/Q). If found
      // mid-chunk, check the very next byte — q/Q → detach, else let
      // both through.
      const idx = scan.indexOf(0x1d)
      if (idx === -1) {
        ws.send(JSON.stringify({ kind: "input", b64: scan.toString("base64") }))
        return
      }
      if (idx === scan.length - 1) {
        // Trailing 0x1d — defer.
        armed = true
        const head = scan.subarray(0, idx)
        if (head.length > 0) {
          ws.send(JSON.stringify({ kind: "input", b64: head.toString("base64") }))
        }
        return
      }
      const next = scan[idx + 1]
      if (next === 0x71 || next === 0x51) {
        // Detach mid-chunk. Send the head (bytes before 0x1d), drop
        // both chord bytes, then close. Anything after the chord is
        // discarded — typing past the detach chord is a user error.
        const head = scan.subarray(0, idx)
        if (head.length > 0) {
          ws.send(JSON.stringify({ kind: "input", b64: head.toString("base64") }))
        }
        try {
          ws.close(1000, "client detach")
        } catch {
          // ignore
        }
        return
      }
      // 0x1d followed by something other than q/Q — emit the whole
      // chunk as-is (the 0x1d may legitimately be Ctrl-] -> some app
      // command, e.g. less's prefix). The remote pty figures it out.
      ws.send(JSON.stringify({ kind: "input", b64: scan.toString("base64") }))
    }

    const onResize = (): void => {
      if (ws.readyState !== WebSocket.OPEN) return
      const cols =
        stdoutTty && process.stdout.columns ? process.stdout.columns : 80
      const rows = stdoutTty && process.stdout.rows ? process.stdout.rows : 24
      ws.send(JSON.stringify({ kind: "resize", cols, rows }))
    }

    let inputWired = false
    let sessionExited = false

    const wireWs = (sock: WebSocket): void => {
      sock.on("open", () => {
        if (attempt === 0) {
          process.stderr.write(
            `\x1b[2m─\x1b[0m attached to \x1b[1m${desc.id}${desc.name ? ` (${desc.name})` : ""}\x1b[0m · ` +
              `\x1b[7m triple Ctrl-C \x1b[0m or \x1b[7m Ctrl-] then q \x1b[0m to detach · ` +
              `Ctrl-C reaches the child (works with Claude's exit)\n`,
          )
        } else {
          process.stderr.write(
            `\x1b[32m─ reconnected to ${desc.id} (attempt ${attempt + 1})\x1b[0m\n`,
          )
        }
        attempt = 0
        if (!inputWired) {
          if (stdinTty) {
            try {
              process.stdin.setRawMode(true)
            } catch {
              // ignore
            }
            process.stdin.resume()
          }
          process.stdin.on("data", onStdin)
          process.stdout.on("resize", onResize)
          process.on("SIGWINCH", onResize)
          inputWired = true
        }
        onResize()
      })

      sock.on("message", raw => {
        let frame: unknown
        try {
          frame = JSON.parse(raw.toString("utf8"))
        } catch {
          return
        }
        if (!frame || typeof frame !== "object") return
        const f = frame as Record<string, unknown>
        switch (f.kind) {
          case "data": {
            if (typeof f.b64 === "string") {
              try {
                process.stdout.write(Buffer.from(f.b64, "base64"))
              } catch {
                // ignore
              }
            }
            break
          }
          case "exit": {
            const code = typeof f.exitCode === "number" ? f.exitCode : 0
            process.stderr.write(
              `\n\x1b[2m─ session ${desc.id} exited (code ${code}) ·\x1b[0m\n`,
            )
            exitCode = code
            sessionExited = true
            break
          }
          // pong / unknown — ignore
        }
      })

      sock.on("close", (code: number, reason: Buffer) => {
        // 1000 = clean: either we initiated (detach) or daemon shut
        // us down cleanly. Either way we're done.
        // 1006 = abnormal: daemon process vanished without a close
        // frame. Worth retrying — they may be coming back up.
        // 4xxx / 410 / 401 / etc. = app-level rejection (session
        // exited, auth, etc.) — surfaced before WS upgrade. Done.
        if (sessionExited || code === 1000) {
          restore()
          done(exitCode)
          return
        }
        if (code === 1006 && attempt < RECONNECT_DELAYS_MS.length) {
          const delay = RECONNECT_DELAYS_MS[attempt] ?? 4_000
          attempt++
          process.stderr.write(
            `\x1b[33m─ disconnected (close ${code}) · reconnecting in ${Math.round(delay / 1000)}s (${attempt}/${RECONNECT_DELAYS_MS.length})…\x1b[0m\n`,
          )
          setTimeout(() => {
            ws = new WebSocket(wsUrl, {
              headers: endpoint.token
                ? { authorization: `Bearer ${endpoint.token}` }
                : {},
            })
            wireWs(ws)
          }, delay)
          return
        }
        // Out of retries or unknown close — surface clearly.
        const reasonText = reason && reason.length > 0 ? ` — ${reason.toString("utf8")}` : ""
        process.stderr.write(
          `\n\x1b[31m─ disconnected (close ${code}${reasonText})\x1b[0m\n` +
            `  daemon may be down. Restart it (\`agentproto serve\`) then re-attach:\n` +
            `    agentproto sessions --attach ${desc.name ?? desc.id}\n`,
        )
        restore()
        done(1)
      })

      sock.on("error", () => {
        // Don't write a noisy error line — 'close' will fire next
        // with the actual reason. WS errors during reconnect attempts
        // are expected and we don't want to spam the terminal.
      })
    }

    wireWs(ws)

    process.on("SIGINT", () => {
      // In PTY mode, Ctrl-C SHOULD go to the child. The terminal
      // emulator forwards \x03 directly through stdin. SIGINT here
      // only fires when stdin isn't a TTY — in which case we detach.
      try {
        ws.close(1000, "sigint")
      } catch {
        // ignore
      }
    })
  })
}

/**
 * Probe `<base>/health` to determine whether the daemon at this URL
 * is reachable. Used to disambiguate "no daemon listening" vs
 * "daemon listening but rejected my token" when a mutating call
 * 401s. Times out after 500ms so a hung process doesn't stall the
 * CLI error path.
 */
async function probeDaemonHealth(baseUrl: string): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    try {
      const u = new URL(`${baseUrl}/health`)
      const lib = u.protocol === "https:" ? https : http
      const req = lib.get(u, { timeout: 500 }, res => {
        resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300)
        res.resume()
      })
      req.on("error", () => resolve(false))
      req.on("timeout", () => {
        req.destroy()
        resolve(false)
      })
    } catch {
      resolve(false)
    }
  })
}

/**
 * Build a clear error message for a sessions_unauthorized response.
 * The 401 from the daemon is almost always one of three things:
 *   1. The token in this runtime.json is stale (daemon restarted).
 *   2. The CLI's Origin doesn't match the daemon's allowlist
 *      (irrelevant from CLI — there's no Origin header — but kept
 *      in the daemon side for browser callers).
 *   3. AGENTPROTO_DAEMON_TOKEN env var is set to a wrong value.
 *
 * We do NOT have the daemon's true token, so we can't auto-recover.
 * Instead we tell the user exactly which file the token came from
 * + how to get the right one.
 */
async function explain401(
  endpoint: DaemonEndpoint,
  verb: string,
): Promise<string> {
  const alive = await probeDaemonHealth(endpoint.url)
  const lines: string[] = [
    `${verb}: 401 sessions_unauthorized from ${endpoint.url}`,
  ]
  if (!alive) {
    lines.push(
      `  the daemon at ${endpoint.url} is NOT reachable (no /health response).`,
      `  the runtime.json may point at a stopped port — try \`agentproto serve\`.`,
    )
    return lines.join("\n")
  }
  // Daemon is alive — definitely a token mismatch.
  if (process.env.AGENTPROTO_DAEMON_TOKEN) {
    lines.push(
      `  daemon /health is reachable. AGENTPROTO_DAEMON_TOKEN is set in your env —`,
      `  it may be from a previous daemon boot. Clear it: \`unset AGENTPROTO_DAEMON_TOKEN\`,`,
      `  or set it to the live token: \`export AGENTPROTO_DAEMON_TOKEN=$(jq -r .token <runtime.json>)\`.`,
    )
  } else if (endpoint.sourcePath) {
    lines.push(
      `  daemon /health is reachable — token mismatch is the cause.`,
      `  this CLI used the token from:`,
      `    ${endpoint.sourcePath}`,
      `  if you have multiple daemons or restarted the daemon since this file was written,`,
      `  that file's token is stale. Restart the live daemon (\`agentproto serve\`) which`,
      `  rewrites its own runtime.json, then re-run.`,
    )
  } else {
    lines.push(
      `  daemon /health is reachable — token mismatch is the cause.`,
      `  unable to identify which file the token came from (env override?).`,
    )
  }
  return lines.join("\n")
}
