/**
 * `~/.agentproto/config.json` — single hand-editable JSON for the
 * agentproto control plane's defaults. Sits alongside the existing
 * surface files (workspaces.json, credentials.json, sessions.json):
 *
 *   workspaces.json     which directories are workspaces + which is active
 *   credentials.json    tunnel host bearer tokens (mode 0600)
 *   sessions.json       last-known snapshot of the registry (informational)
 *   config.json         daemon defaults: port, bind, allowed origins,
 *                       tunnel host, feature toggles
 *
 * Resolution order for every daemon knob is:
 *   1. CLI flag (e.g. --port)
 *   2. Env var (where one exists, e.g. AGENTPROTO_TOKEN)
 *   3. config.json
 *   4. Hardcoded default
 *
 * This means a user can call `agentproto config set daemon.port 18791`
 * once and never re-pass `--port 18791` to `serve install` etc. CLI
 * flags still win for one-off overrides.
 *
 * Schema is intentionally narrow + extensible — unknown keys are
 * preserved on save (deep-merge), so a newer CLI writing a new
 * field won't drop one an older CLI doesn't know about. No secrets
 * here; credentials stay in credentials.json (mode 0600).
 */

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { SpawnDefaultsConfig } from "./spawn-defaults.js"

export const CONFIG_VERSION = 1 as const

export interface DaemonConfig {
  /** Absolute path to the workspace the daemon binds to at boot. */
  workspace?: string
  /** HTTP port. Default 18790. */
  port?: number
  /** Bind addr. Default 127.0.0.1. */
  bind?: string
  /** Trusted browser origins for mutating /sessions/* routes (in
   *  addition to the hardcoded localhost defaults). */
  allowedOrigins?: string[]
  /** When true, the daemon does NOT auto-trust localhost-on-any-port.
   *  Only origins explicitly listed in `allowedOrigins` are allowed.
   *  Pair with a curated list (e.g. `["http://localhost:3000"]`) for
   *  hardened setups. Default false. */
  strictOrigins?: boolean
  /** Server label sent in tunnel hello frames. */
  label?: string
  /** Bearer token gating the gateway at boot (`AuthOptions` with
   *  `mode: "bearer"`). Unlike `remote_enable`'s ephemeral quick-tunnel
   *  token, this one lives in config.json and survives daemon restarts.
   *  Set via `agentproto config set daemon.authToken <token>` (e.g.
   *  `$(openssl rand -hex 32)`). Unset ⇒ the gateway boots with
   *  `mode: "none"` — fully open on loopback, same as today. */
  authToken?: string
  /** Opt-in eager resume-on-boot (session-survivability plan §5
   *  "Opt-in vs automatic", PR-4). When true, a daemon restart doesn't just
   *  leave agent-cli sessions dead-but-lazy-resumable — the boot pass eagerly
   *  re-spawns the eligible ones (those that died with
   *  `endedReason: "daemon-restart"` and still pass `canResume`) IN PLACE,
   *  restoring liveness without waiting for a prompt. Lazy resume-on-prompt is
   *  always on regardless of this flag (it costs nothing until someone acts);
   *  this flag only controls the *automatic* boot-time pass. Default false: a
   *  box-wide restart should not silently relaunch every adapter (cost, spawn
   *  storm, credential re-resolution), and default-off also keeps two daemons
   *  sharing the workspace buckets from racing to resume the same rows. Set via
   *  `agentproto config set daemon.resumeSessionsOnBoot true`. Surfaced in
   *  `daemon_health` / `GET /health`. */
  resumeSessionsOnBoot?: boolean
  /** Idle agent-session reaper (PR-6). When set to a positive number of
   *  milliseconds, the daemon periodically retires agent-cli sessions that have
   *  been idle (not busy, not awaiting input, `status:"running"`) longer than
   *  this: it SIGTERMs the adapter child to free the process and flips the row
   *  to `killed`/`endedReason:"idle-reaped"` — dead-but-lazy-resumable (a later
   *  prompt revives it) and, critically, excluded from eager resume-on-boot
   *  (#638 gates on `endedReason === "daemon-restart"`), so enabling this makes
   *  eager resume safe: only genuinely-recent work survives a restart. Default
   *  OFF (unset / 0 / negative ⇒ the reaper never runs). Resolution order
   *  mirrors the module docblock: `AGENTPROTO_IDLE_REAP_AFTER_MS` env > this
   *  field > off. Set via `agentproto config set daemon.idleReapAfterMs
   *  <ms>`. Surfaced in `daemon_health` / `GET /health`. */
  idleReapAfterMs?: number
  /** Crash-detect sweep interval in ms (crash-detect PR-1). Unlike
   *  `idleReapAfterMs`, this is DEFAULT ON (non-destructive observability):
   *  the daemon periodically probes every live agent-cli session's OS
   *  process (`process.kill(pid, 0)`) and, when it's provably gone with no
   *  exit event ever emitted for it, flips the row to
   *  `error`/`endedReason:"crashed"` with a `lastError` string — surfacing a
   *  death that would otherwise sit silently as `status:"running"` until the
   *  next prompt's RPC throws (or forever, for a parked session with no next
   *  prompt). Detects only; never restarts or notifies (later PRs). Set to a
   *  non-positive value to disable the sweep entirely. Resolution order
   *  mirrors `idleReapAfterMs`: `AGENTPROTO_CRASH_DETECT_INTERVAL_MS` env >
   *  this field > the hardcoded default (30s). Set via `agentproto config
   *  set daemon.crashDetectIntervalMs <ms>`. Surfaced in `daemon_health` /
   *  `GET /health`. */
  crashDetectIntervalMs?: number
  /** Restart-scheduler sweep interval in ms (restart-scheduler PR-2). OFF by
   *  default (unset / 0 / negative ⇒ the sweep never runs), unlike
   *  `crashDetectIntervalMs` — a positive value here only arms the periodic
   *  sweep that EXECUTES an already-scheduled restart; it never opts a
   *  session in by itself (that's the per-session `agent_start.restartPolicy`
   *  field). Resolution order mirrors `idleReapAfterMs`:
   *  `AGENTPROTO_RESTART_SWEEP_INTERVAL_MS` env > this field > off. Set via
   *  `agentproto config set daemon.restartSweepIntervalMs <ms>`. Surfaced in
   *  `daemon_health` / `GET /health`. */
  restartSweepIntervalMs?: number
  /** Turn-liveness watchdog threshold in ms (turn-liveness-watchdog
   *  chantier). Same shape as `crashDetectIntervalMs`: DEFAULT ON
   *  (non-destructive observability). The daemon periodically sweeps every
   *  BUSY agent-cli session and, for one that is mid-turn, NOT legitimately
   *  `blockedOn` a subagent/command, and has had no adapter activity
   *  (`lastActivityAt`) for longer than this threshold, stamps
   *  `stalledSinceMs` on the descriptor and emits `session:stalled` —
   *  surfacing a dead adapter stream (network drop, hung child — zero
   *  frames mid-turn) that would otherwise sit indistinguishable from
   *  healthy long work: `status:"running"`, `lastError:null`, no other
   *  signal. Conservative by design: a session legitimately blocked on a
   *  long tool call is NEVER a candidate, no matter how long it's silent —
   *  see `stall-watchdog.ts`'s docblock for why. Detects only; never kills
   *  or restarts (this is a later concern, if ever). Set to a non-positive
   *  value to disable the sweep entirely. Resolution order mirrors
   *  `idleReapAfterMs`: `AGENTPROTO_TURN_STALL_AFTER_MS` env > this field >
   *  the hardcoded default (5 min). Set via `agentproto config set
   *  daemon.turnStallAfterMs <ms>`. Surfaced in `daemon_health` /
   *  `GET /health`. */
  turnStallAfterMs?: number
}

export interface TunnelConfig {
  /** Cloud WS URL. When set + autoconnect=true, `agentproto serve`
   *  bootstraps with `--connect <host>`. */
  host?: string
  /** apt_ daemon token to present at the tunnel upgrade. When set,
   *  `agentproto serve` uses this BEFORE falling back to
   *  credentials.json — handy in profiles where the token-per-host
   *  mapping in credentials.json doesn't fit (e.g. host = tunnel URL
   *  but credentials were minted against the api URL). */
  token?: string
  /** Whether `agentproto daemon start` connects the tunnel by
   *  default. v0 only — implementer can ignore until daemon needs it. */
  autoconnect?: boolean
  /**
   * Opt into end-to-end encryption of the outbound `serve --connect` tunnel
   * (design: tunnel-e2e/v1). When true, the daemon negotiates a
   * token-authenticated ephemeral handshake with the host and wraps the tunnel
   * frames in an AEAD box, so even the trusted host loses plaintext visibility.
   * The handshake authenticates both ends against the shared `tunnel.token`, so
   * `token` MUST also be set. Fully backward-compatible: if the host doesn't
   * advertise e2e (an older host), the daemon falls back to today's plaintext
   * tunnel. Unset/false ⇒ plaintext, byte-identical to today. */
  e2e?: boolean
}

export interface FeaturesConfig {
  /** Hint that PTY is desired — informational; the daemon still
   *  detects node-pty's presence at runtime. */
  pty?: boolean
  /** Enable the local LLM Endpoint proxy sidecar (route registration,
   *  MCP tools, child-process lifecycle). Default false — the endpoint is
   *  an opt-in feature; when off, the `llm-endpoint` custom route is not
   *  registered and the `llm_endpoint_*` MCP tools are not exposed. */
  llmEndpoint?: boolean
}

/**
 * Policy for `agentproto worktree new` (PLAN.md §1.4 — config carries
 * policy, never state; git itself is the authority for which worktrees
 * exist). This is the fix for the sprawl the plan measured: 31 linked
 * worktrees across 6 different parent directories, because there was no
 * `worktree new` verb and therefore no convention to converge on.
 */
/**
 * How the daemon isolates a freshly-spawned agent session into its own git
 * worktree (`agent_start.worktree`):
 *   - `"always"`      — every depth-0 spawn is provisioned into a worktree,
 *                       whether or not the caller asked. A cwd that is not in
 *                       a git repo has nothing to isolate, so it spawns plain.
 *   - `"on-request"`  — isolate ONLY when the caller passes `worktree`. This
 *                       is the default and the back-compatible behaviour:
 *                       today's callers pass nothing and spawn exactly where
 *                       they asked.
 *   - `"never"`       — isolation is off; an explicit `worktree` field is
 *                       REJECTED (loud, not silently ignored) so a caller
 *                       never believes it got an isolated tree it didn't.
 */
export type WorktreeIsolationMode = "always" | "on-request" | "never"

export interface WorktreesConfig {
  /**
   * Absolute path new worktrees are created under. Layout:
   * `<root>/<repoName>/<slug>`. Resolution order (mirrors every other
   * knob in this file, see the module docblock): `--root` flag >
   * `AGENTPROTO_WORKTREES_ROOT` env > this field > the hardcoded default
   * `~/.agentproto/worktrees`. The default is a real single root, not
   * "unconfigured" — `worktree new` converges to one place with zero
   * setup, which is the only way the sprawl actually stops (the 6 roots
   * that exist today are 6 people each inventing a default by hand).
   */
  root?: string
  /**
   * Policy for `agent_start.worktree` isolation. Resolution order mirrors
   * the module docblock (there is no CLI flag — this is a daemon-side
   * policy read at spawn, not a per-invocation flag):
   * `AGENTPROTO_WORKTREES_ISOLATION` env > this field > the hardcoded
   * default `"on-request"`. `"on-request"` is deliberately the default:
   * any other would break back-compat by isolating callers that never
   * asked (see `worktree-isolation.ts`).
   */
  isolation?: WorktreeIsolationMode
}

/**
 * Policy for `agent_start.attach` — whether a spawn AUTO-attaches to its
 * calling session as parent lineage. `"always"` (the default) nests a
 * spawned child under the session that spawned it whenever that identity is
 * derivable (the trusted `?callerSessionId=` on the daemon self-ref URL, or
 * an explicit `parentSessionId` hint), so a supervisor's executors stop
 * landing as depth-0 orphans. `"on-request"` reverts to the pre-attach
 * behaviour: auto-attribution is off, and a child nests only when the caller
 * explicitly opts in (`attach: true` / `attach: { parent }` / an explicit
 * `parentSessionId`). Either way a per-call `attach: false` forces an
 * independent root, exactly as `worktree: false` opts out of isolation. See
 * `spawn-attach.ts`.
 */
export type SpawnAttachMode = "always" | "on-request"

/**
 * Policy for `agent_start`'s IMPLICIT dedupe — what happens when a caller
 * spawns with NO `idempotencyKey` at all (see `spawn-dedupe.ts`):
 *   - `"always"`      — the daemon DERIVES an implicit key from the spawn's
 *                       `label` (required — see below) plus a hash of the
 *                       initial `prompt`, and dedupes a same-adapter/cwd
 *                       repeat against it exactly as an explicit key would.
 *                       This is the default, mirroring `attach`'s own
 *                       "opt-in-only guard is not a guard" precedent above.
 *                       Deriving needs a `label` to produce anything at all
 *                       — an unlabelled spawn is untouched, which is what
 *                       keeps this safe for the fan-out pattern this repo
 *                       exercises (several agents into one cwd with no
 *                       shared label): see `spawn-dedupe.ts`'s docblock for
 *                       the full false-dedup analysis, and PR #803's own
 *                       no-opt-in label+cwd warning backstop in
 *                       `session-spawn.ts`, which independently landed on
 *                       the same label-is-the-signal boundary.
 *   - `"on-request"`  — no implicit derivation; only an explicit
 *                       `idempotencyKey` dedupes (today's behaviour,
 *                       unchanged). A per-call `dedupe: true` still opts in
 *                       under this policy, mirroring `attach: true`.
 * Either way a per-call `dedupe: false` disables implicit derivation for
 * that one spawn regardless of policy — the escape hatch, mirroring
 * `attach: false` / `worktree: false`. An explicit `idempotencyKey` always
 * wins over a derived one (derivation is only attempted when the caller
 * supplied none).
 */
export type SpawnDedupeMode = "always" | "on-request"

export interface SpawnConfig {
  /**
   * Attach policy for `agent_start`. Resolution order mirrors the module
   * docblock (no CLI flag — a daemon-side policy read at spawn):
   * `AGENTPROTO_SPAWN_ATTACH` env > this field > the hardcoded default
   * `"always"`. Unlike `worktrees.isolation` (whose default preserves
   * back-compat by NOT isolating), attach defaults ON: an orphaned executor
   * is a bug, not a feature, and the auto-parent is descriptor-only lineage
   * that never relaxes a privilege gate.
   */
  attach?: SpawnAttachMode
  /**
   * Implicit-dedupe policy for `agent_start`. Resolution order mirrors
   * `attach` above (no CLI flag — a daemon-side policy read at spawn):
   * `AGENTPROTO_SPAWN_DEDUPE` env > this field > the hardcoded default
   * `"always"`. See {@link SpawnDedupeMode} and `spawn-dedupe.ts` for the
   * full reasoning: a retry-safety guard that only works when a caller
   * remembers to ask for it (`idempotencyKey`) is not a guard — the same
   * argument `attach` already settled for parent lineage.
   */
  dedupe?: SpawnDedupeMode
}

/**
 * Provenance policy — the opt-in `gh` PATH shim (`gh-provenance-shim.ts`).
 * Off by default. When `wrapGh` is on, every agent session the daemon spawns
 * gets a shim directory prepended to its PATH so that any `gh pr create` the
 * session (or an adapter subprocess shelling out — claude-code, codex, …) runs
 * has a deterministic `@agentproto-bot` provenance footer appended to the
 * created PR's BODY, matching the footer the cloud runner stamps. The TOOL
 * stamps, never the model; commit messages are never touched (the repo's
 * hygiene-check forbids attribution there). Resolution order mirrors
 * `spawn.attach`: `AGENTPROTO_PROVENANCE_WRAP_GH` env > this field > default
 * `false`.
 */
export interface ProvenanceConfig {
  /** Enable the opt-in `gh` provenance PATH shim for spawned sessions. */
  wrapGh?: boolean
}

/**
 * Policy for the daemon's own AGENTS.md resolution + injection (WP-R2) —
 * how a spawned session's initial prompt carries the repo's `AGENTS.md`
 * (see `agents-md.ts`). The daemon resolves the nearest `AGENTS.md` walking
 * up from the session's `cwd`, bounded by that repo's git toplevel, and
 * injects one AGENTS.md block after the role disposition whenever the spawn
 * carries a prompt.
 */
export interface AgentsMdConfig {
  /**
   * Inline-vs-pointer threshold in KiB. A resolved AGENTS.md whose byte size
   * is STRICTLY LESS than `inlineMaxKb` KiB is inlined in full into the
   * spawn's initial prompt, clearly delimited; `>=` the threshold is injected
   * as a short pointer telling the agent to read the file before its first
   * tool call instead. An absent AGENTS.md (nothing found up the walk) injects
   * nothing but is still reported on the descriptor via
   * `SessionDescriptor.agentsMdMode === "absent"`. Resolution order mirrors
   * the module docblock (no CLI flag, and no env override — not part of the
   * approved design): this field > the hardcoded default `8` (KiB).
   */
  inlineMaxKb?: number
}

export interface PairingConfig {
  /** Rendezvous broker WS URL (ws:// or wss://) used by `pair offer` and by
   *  autoconnect on boot. When unset, `pair offer` requires an explicit
   *  `--rendezvous`. Mirrors `tunnel.host`. */
  rendezvous?: string
  /** Whether the daemon opens standing rendezvous connections for every
   *  persisted pairing on boot (so a paired client can reconnect anytime).
   *  Mirrors `tunnel.autoconnect`. Default true when a rendezvous is set. */
  autoconnect?: boolean
}

/**
 * A user-defined generic ACP agent — the config-file half of
 * `AcpAgentSpec` (the slug is the record key in `acpAgents`, so it's
 * omitted here). Any CLI that already speaks the Agent Client Protocol
 * can be wired with zero code by declaring one of these under
 * `acpAgents.<slug>` in `~/.agentproto/config.json`; the CLI's
 * `acpHandleFromSpec` mints a runnable `AgentCliHandle` from it at
 * resolve time (see `packages/cli/src/registry/acp-generic.ts`). Kept
 * in this package (not the CLI's) so `config.ts` stays the single
 * source of truth for the config surface without a cli→runtime→cli
 * import cycle — the CLI's `AcpAgentSpec` extends this shape.
 */
export interface AcpAgentConfigEntry {
  /** Display name. Defaults to the slug when omitted. */
  name?: string
  /** One-line description surfaced in `agentproto acp ls`. */
  description?: string
  /** Executable to spawn, e.g. "gemini". */
  bin: string
  /** Extra argv appended after `bin`, e.g. ["--experimental-acp"]. */
  bin_args?: string[]
  /** Extra environment variables for the spawned process. */
  env?: Record<string, string>
  /** Flag the CLI uses to receive the working directory, if it needs
   *  one passed explicitly (most ACP agents take cwd over the wire). */
  cwd_flag?: string
  /** When true, advertise resumable + native-resume continuation. */
  resumable?: boolean
  /** Known model ids for the agent (informational + validation hints). */
  models?: { default?: string; allowed?: string[] }
  /** Billing endpoint this CLI's own auth bills (e.g. "mistral",
   *  "moonshot", "google") — the provider whose wallet/auth-profile the
   *  agent consumes. Lets clients link the harness to that provider's
   *  wallets even when no model list is declared. Unset when the CLI's
   *  billing target isn't a single known endpoint. */
  provider?: string
  /** Shown when `bin` is missing from PATH (how to install the CLI). */
  install_hint?: string
}

/**
 * Per-environment connection bundle. A profile overrides specific
 * fields of the top-level `daemon` / `tunnel` / `features` blocks
 * when selected via `--profile <name>` (or the top-level
 * `activeProfile` setting). Missing fields fall through to the
 * top-level config, so a profile only needs to declare what's
 * different — typically just `tunnel.host` + `tunnel.token`.
 *
 * Example:
 *   {
 *     "daemon": { "workspace": "/code", "port": 18790 },
 *     "activeProfile": "local",
 *     "profiles": {
 *       "local": { "tunnel": { "host": "ws://localhost:3200/connect",
 *                              "token": "apt_local", "autoconnect": true } },
 *       "prod":  { "tunnel": { "host": "wss://tunnel.guilde.work/connect",
 *                              "token": "apt_prod",  "autoconnect": true },
 *                  "daemon": { "port": 18791 } }
 *     }
 *   }
 *
 * Sandbox daemons generate per-sandbox profile entries at provision
 * time so the daemon inside the sandbox boots with
 * `agentproto serve --profile sandbox-<id>` and no extra plumbing.
 */
export interface ProfileConfig {
  daemon?: DaemonConfig
  tunnel?: TunnelConfig
  features?: FeaturesConfig
}

/**
 * A user-defined named terminal/TUI preset stored in
 * `~/.agentproto/config.json` under `terminalPresets`. Presets keep
 * local launch recipes (argv, env, cwd, name/label) out of shared
 * adapter manifests — e.g. pointing a Claude Code TUI at a local
 * LLM gateway without retyping proxy env vars every spawn.
 */
export interface TerminalPreset {
  /** Command + args to spawn. When provided, `sessions terminal` can
   *  be used without `-- <argv...>`. */
  argv?: string[]
  /** Extra environment variables layered on top of the daemon's
   *  inherited process.env. Values MUST be strings. */
  env?: Record<string, string>
  /** Working directory for the PTY session. Relative paths are
   *  resolved against the current working directory at CLI time. */
  cwd?: string
  /** Workspace slug used for cwd fallback when `cwd` is omitted. */
  workspace?: string
  /** Stable session name passed to the registry (`name` field). */
  name?: string
  /** Human-readable label surfaced in session listings. */
  label?: string
}

export interface AgentprotoConfig {
  version?: number
  daemon?: DaemonConfig
  tunnel?: TunnelConfig
  features?: FeaturesConfig
  /** E2E daemon-pairing defaults (rendezvous URL + autoconnect). */
  pairing?: PairingConfig
  /** Where `agentproto worktree new` creates worktrees. See
   *  {@link WorktreesConfig}. */
  worktrees?: WorktreesConfig
  /** Spawn-time policy (`agent_start`). See {@link SpawnConfig}. */
  spawn?: SpawnConfig
  /** Provenance policy — the opt-in `gh` PATH shim. See {@link ProvenanceConfig}. */
  provenance?: ProvenanceConfig
  /** Daemon-side AGENTS.md resolution/injection policy. See {@link AgentsMdConfig}. */
  agentsMd?: AgentsMdConfig
  /** Named connection profiles. See `ProfileConfig` for the merge
   *  semantics — a profile's fields shallow-override the top-level
   *  defaults for the selected run. */
  profiles?: Record<string, ProfileConfig>
  /** Profile name to use when `--profile` isn't passed. When unset,
   *  the top-level `daemon` / `tunnel` blocks are used directly. */
  activeProfile?: string
  /** Default `skills` + `options` auto-applied to every `agent_start`
   *  spawn — global and per-adapter. See `resolveSpawnDefaults` in
   *  `spawn-defaults.ts` for the merge precedence with an explicit call.
   *  Absent ⇒ current behaviour exactly (no regression). */
  defaults?: SpawnDefaultsConfig
  /** User-defined generic ACP agents, keyed by adapter slug. Each entry
   *  is minted into a runnable handle by the CLI's `acpHandleFromSpec`
   *  when `resolveAdapter(slug)` finds no npm adapter package. User
   *  entries shadow the curated `ACP_CATALOG` on slug collision. */
  acpAgents?: Record<string, AcpAgentConfigEntry>
  /** User-defined named terminal/TUI presets. Local-only; never
   *  packaged in shared adapter manifests or defaults. */
  terminalPresets?: Record<string, TerminalPreset>
  /** Unknown keys preserved across save round-trips. */
  [unknown: string]: unknown
}

export const CONFIG_FILE_PATH = (): string =>
  join(homedir(), ".agentproto", "config.json")

/**
 * Drop any `acpAgents` entries that aren't a shape we can turn into a
 * handle. The one hard requirement is a non-empty string `bin` (the
 * executable to spawn); everything else is optional and defaulted
 * downstream. Invalid entries are removed rather than throwing so the
 * daemon still boots — one warning names the offending slug so the
 * user can fix their config. Returns `undefined` when nothing valid
 * remains, keeping the key absent (== "no generic agents").
 */
function sanitizeAcpAgents(
  raw: unknown,
  target: string,
): Record<string, AcpAgentConfigEntry> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    console.warn(
      `[runtime/config] ${target}: 'acpAgents' is not an object — ignoring`,
    )
    return undefined
  }
  const out: Record<string, AcpAgentConfigEntry> = {}
  for (const [slug, value] of Object.entries(raw as Record<string, unknown>)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { bin?: unknown }).bin === "string" &&
      (value as { bin: string }).bin.length > 0
    ) {
      out[slug] = value as AcpAgentConfigEntry
    } else {
      console.warn(
        `[runtime/config] ${target}: acpAgents.${slug} is missing a string 'bin' — ignoring`,
      )
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Load config.json. Returns an empty object (NOT null) when the file
 * is missing, malformed, or unreadable — callers can `cfg.daemon?.port`
 * safely without null-guards. Errors during a malformed-read are
 * logged once so the user notices the file is broken without the
 * daemon refusing to boot.
 */
export async function loadConfig(path?: string): Promise<AgentprotoConfig> {
  const target = path ?? CONFIG_FILE_PATH()
  try {
    const raw = await fs.readFile(target, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const cfg = parsed as AgentprotoConfig
      // Sanitize `acpAgents` in the same tolerant spirit as the rest of
      // this loader: a malformed entry is dropped (with one warning) so a
      // single bad hand-edit can't make every generic ACP agent
      // unresolvable. Full AIP-45 validation happens later, at
      // `acpHandleFromSpec` time, with precise field-level messages.
      if (cfg.acpAgents !== undefined) {
        cfg.acpAgents = sanitizeAcpAgents(cfg.acpAgents, target)
      }
      return cfg
    }
    console.warn(
      `[runtime/config] ${target}: top-level value is not an object — ignoring`,
    )
    return {}
  } catch (err) {
    // ENOENT is the common case; only warn on other shapes.
    const code = (err as NodeJS.ErrnoException).code
    if (code && code !== "ENOENT") {
      console.warn(
        `[runtime/config] failed to read ${target}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
    return {}
  }
}

/**
 * Write config.json atomically (tmp + rename) so a concurrent
 * `agentproto config edit` can't half-truncate the file. Writes
 * `next` AS-IS — callers are expected to pass the full desired
 * state (loaded the existing config, mutated, passed it back).
 *
 * Earlier versions deep-merged with the on-disk file, but that made
 * deletions impossible: `setConfigKey(cfg, "x", undefined)` would
 * remove the key from memory, then the deep-merge would silently
 * re-add it from disk. The current design trusts the caller's
 * snapshot and uses atomic rename for crash safety.
 */
export async function saveConfig(
  next: AgentprotoConfig,
  path?: string,
): Promise<void> {
  const target = path ?? CONFIG_FILE_PATH()
  const payload = { ...next, version: CONFIG_VERSION }
  const dir = dirname(target)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${target}.tmp`
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8")
  await fs.rename(tmp, target)
}

/**
 * Read a dot-notation key (`daemon.port`) out of a config. Returns
 * `undefined` when any segment is missing.
 */
export function getConfigKey(
  cfg: AgentprotoConfig,
  dotted: string,
): unknown {
  let cur: unknown = cfg
  for (const part of dotted.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/**
 * Set a dot-notation key in a config. Returns a new object — does
 * NOT mutate. Creates intermediate objects as needed. Setting
 * `value: undefined` is treated as a delete.
 */
export function setConfigKey(
  cfg: AgentprotoConfig,
  dotted: string,
  value: unknown,
): AgentprotoConfig {
  const parts = dotted.split(".")
  const out: AgentprotoConfig = { ...cfg }
  let cur: Record<string, unknown> = out as Record<string, unknown>
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!
    const next = cur[k]
    if (next && typeof next === "object" && !Array.isArray(next)) {
      cur[k] = { ...(next as Record<string, unknown>) }
    } else {
      cur[k] = {}
    }
    cur = cur[k] as Record<string, unknown>
  }
  const leaf = parts[parts.length - 1]!
  if (value === undefined) {
    delete cur[leaf]
  } else {
    cur[leaf] = value
  }
  return out
}

/**
 * Deep merge — objects are recursively combined, everything else
 * (arrays, primitives) is replaced wholesale by `b`. Mirrors what
 * `Object.assign({}, a, b)` does for shallow keys.
 */
function deepMerge<A extends Record<string, unknown>, B extends Record<string, unknown>>(
  a: A,
  b: B,
): A & B {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k]
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      cur &&
      typeof cur === "object" &&
      !Array.isArray(cur)
    ) {
      out[k] = deepMerge(
        cur as Record<string, unknown>,
        v as Record<string, unknown>,
      )
    } else {
      out[k] = v
    }
  }
  return out as A & B
}
