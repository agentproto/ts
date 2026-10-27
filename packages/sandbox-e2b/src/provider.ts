/**
 * e2b `SandboxProvider` — boots the pre-built `agentproto-workstation`
 * template, ensures the agentproto daemon is listening on it, and exposes
 * the daemon's `/mcp` endpoint via `sandbox.getHost()` so
 * `createSandboxAgentSessionHost` (`@agentproto/sandbox`) can hand it
 * straight to `connectDaemonAgentSessionHost`.
 *
 * `getHost(port)` returns a publicly reachable hostname for that port
 * directly — e2b's per-sandbox auth token (`SandboxOpts.secure`) gates the
 * SDK's own control-plane (envd) traffic, not arbitrary listening ports the
 * sandbox process opens, so no extra auth header is threaded through here.
 * The daemon's OWN origin allowlist is a separate gate, though: it defaults
 * to `localhost:*`, which rejects a connection from this host process
 * against the sandbox's public `https://<getHost>` origin. `--allow-origin`
 * is passed the sandbox's own getHost origin to open that gate.
 *
 * The workstation template MAY already autostart the daemon; since that
 * can't be verified without a live template, this provider checks health
 * first and only issues the start command when the daemon isn't already
 * responding — correct either way. When it does start the daemon on a
 * non-proven template, it first updates the CLI (custom templates can lag
 * behind). The boot install is skipped by default ONLY when the template's
 * recorded `baked` block (templates/workstation/versions.json, via the
 * generated module) proves the image already carries the requested pin —
 * an unproven bake (`baked: null` fields, e.g. the current out-of-band
 * stable image) keeps the legacy install. An explicit `updateCliOnBoot`
 * overrides either way.
 */

import { CommandExitError, Sandbox, SandboxNotFoundError } from "e2b"
import type { SandboxInfo } from "e2b"
import type {
  BootedSandbox,
  SandboxBootOpts,
  SandboxBox,
  SandboxExecOpts,
  SandboxExecResult,
  SandboxProbeResult,
  SandboxSpec,
  SandboxProvider,
  SandboxUsageWindow,
} from "@agentproto/sandbox"
import { resolveLifecyclePolicy, SandboxBoxGoneError, scrubCommandFromMessage } from "@agentproto/sandbox"
import {
  DEFAULT_SIZE,
  DEFAULT_TEMPLATE,
  SIZES,
  TEMPLATES,
  type WorkstationSize,
} from "./template-versions.generated.js"

/** Re-exported from the generated module (single source:
 *  `templates/workstation/versions.json` via scripts/sync-templates.mjs). */
export { DEFAULT_SIZE, DEFAULT_TEMPLATE, SIZES, TEMPLATES, type WorkstationSize }

/** `serve.ts`'s default port (`DEFAULT_MCP_URL` in `@agentproto/session-presets`). */
const DEFAULT_PORT = 18790
/**
 * Default sandbox LIFETIME. e2b's own default is 5 minutes (`SandboxOpts.
 * timeoutMs @default 300_000`) — lethal for real agent work: boot (~30s) +
 * `npm i -g` (~90s) + a multi-minute agent turn crosses 5:00 mid-turn, e2b
 * reaps the VM, and the next request cold-boots it WITHOUT the daemon —
 * surfacing as the baffling `"The sandbox is running but port is not open"`
 * 502 (observed live killing a PR-review turn). `config.timeoutMs` still
 * overrides in either direction.
 *
 * This is the box's lifetime from its last re-arm, not a cap on the session:
 * the runtime's sandbox session proxy re-arms it (`extendTimeout`, same
 * duration) on prompt dispatch, on streamed events, and every 10 minutes
 * while a turn is in flight even if it streams nothing (one long tool call).
 * An idle box is left to expire. Ahead of the deadline the proxy either
 * renews once more (turn in flight) or runs a final checkpoint while the box
 * is still reachable — see `BOX_ACTIVE_RENEW_INTERVAL_MS` /
 * `BOX_DEADLINE_GUARD_LEAD_MS` in `@agentproto/runtime`.
 */
const DEFAULT_SANDBOX_TIMEOUT_MS = 45 * 60_000
/** Account-level ceiling: `sandbox.setTimeout` rejects anything above 1 hour
 *  ("Timeout cannot be greater than 1 hours").
 *
 *  ROOT CAUSE of the "active session dies at start+~60min" field reports
 *  (sess_795b8c58 / e39cd4da / 7d29436b, 2026-10-16): on the Hobby/Base plan
 *  e2b enforces a cap on CONTINUOUS sandbox runtime — "Sandboxes can run
 *  continuously for up to 24 hours (Pro) or 1 hour (Hobby)" — i.e. ~1h from
 *  box CREATION, whatever `setTimeout` does. Renewal-while-active is already
 *  in place (the runtime proxy heartbeats `extendTimeout` every 10 min of a
 *  turn and on streamed events, and e2b `setTimeout` does reset the countdown
 *  from now), yet an active box was still reaped at start+59min because the
 *  plan's total-run window ran out. Keeping a box alive past that is
 *  impossible on such a plan (only Pro, or e2b pause/resume, escapes it): a
 *  box whose work is delivered is left to expire, and the runtime now
 *  classifies that death as `endedReason: "sandbox-expired"` (a clean end
 *  with the delivered branch as artifact), not `crashed`. */
export const MAX_SANDBOX_TIMEOUT_MS = 60 * 60_000
const DEFAULT_WORKSPACE = "/home/user"
const HEALTH_PROBE_TIMEOUT_MS = 3_000
const DAEMON_READY_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 500
const UPDATE_CLI_TIMEOUT_MS = 120_000
/** Swap a fresh box gets unless `config.swapMb` says otherwise. The template
 *  ships with none, and a box without swap does not fail cleanly when a
 *  parallel build outgrows its RAM: it either has its agentproto daemon
 *  OOM-killed (the host sees 502, the session's work is stranded) or wedges
 *  for good — reproduced live: a monorepo `pnpm build` at ~3.5 GB usable left
 *  the VM "running" with envd and `/health` unanswering for 10+ minutes. Swap
 *  turns that into a slow build. */
export const DEFAULT_SWAP_MB = 4096
const SWAP_SETUP_TIMEOUT_MS = 60_000
/** Login-shell snippet that carries the box's build env (see
 *  {@link buildProfileCommand}). e2b runs every in-box command as
 *  `/bin/bash -l -c <command>`, and `/etc/profile` sources
 *  `/etc/profile.d/*.sh`, so one file reaches every login-shell process. */
const PROFILE_ENV_PATH = "/etc/profile.d/agentproto-build.sh"
const PROFILE_SOURCE_LINE = `. ${PROFILE_ENV_PATH}`
const BUILD_ENV_SETUP_TIMEOUT_MS = 30_000
/** One-shot `nproc` / `free -m` probe for a custom template's box size. */
const BOX_SIZE_PROBE_TIMEOUT_MS = 15_000

interface E2bSandboxConfig {
  /** Template name or id. Wins over `size` when both are given. Defaults to
   *  the `agentproto-workstation` template (built at `DEFAULT_SIZE`). */
  template?: string
  /** Size preset (`nano` … `xx-large`, see `SIZES`): boots that preset's
   *  `agentproto-workstation-<size>` template. Ignored when `template` is set. */
  size?: WorkstationSize
  /** Port the agentproto daemon listens on inside the sandbox. Default 18790. */
  port?: number
  /** `--workspace` passed to `agentproto serve`. Default `/home/user`. */
  workspace?: string
  /** Sandbox lifetime cap, forwarded to `Sandbox.create`. */
  timeoutMs?: number
  /** What e2b does when `timeoutMs` runs out: `"pause"` snapshots the box
   *  (disk + memory, reconnectable, not billed while paused), `"kill"`
   *  destroys it. Default: `"pause"` when the spec declares
   *  `lifecycle.pause_after_idle` (the box is meant to outlive idleness, so
   *  the provider-side expiry must not wipe it), otherwise unset — e2b's own
   *  default, currently `kill`. See {@link resolveOnTimeout}. */
  onTimeout?: "pause" | "kill"
  /** How long to wait for the health probe before assuming the daemon isn't autostarted. */
  healthProbeTimeoutMs?: number
  /** How long to wait for the daemon to become healthy after starting it. */
  daemonReadyTimeoutMs?: number
  /** Delay between health-probe attempts. */
  pollIntervalMs?: number
  /** Run `npm i -g @agentproto/cli@...` before starting the daemon, so a
   *  stale template bake doesn't pin callers to an old agentproto version.
   *  Default: false when the configured template is the baked stable
   *  workstation one AND the requested cliVersion matches its baked pin
   *  (the bake already carries exactly that CLI) — true otherwise (custom
   *  templates can lag behind). Only runs when this provider is the one
   *  starting the daemon (skipped when the health probe finds it already
   *  autostarted). */
  updateCliOnBoot?: boolean
  /** CLI version to install on boot, pinned instead of a floating `@latest`.
   *  A broken `@agentproto/cli@latest` publish otherwise silently kills the
   *  box on boot; pinning a known-good version (sourced from config, defaulting
   *  to the repo's declared `cliVersion`) makes the boot install reproducible.
   *  Produces `@agentproto/cli@<version>`; when unset, falls back to `@latest`. */
  cliVersion?: string
  /** Extra npm package specs installed globally ALONGSIDE the CLI update
   *  (single `npm i -g` invocation). Load-bearing for adapters: the CLI
   *  update replaces the global install, LOSING any template-baked
   *  `@agentproto/adapter-*` packages (verified against a live template) —
   *  so the adapter the caller intends to spawn must be (re)installed in the
   *  same breath, e.g. `["@agentproto/adapter-claude-sdk@latest"]` (plus
 *  `"@anthropic-ai/claude-code@latest"` for the claude-code adapter's
 *  underlying CLI). Ignored when `updateCliOnBoot` is false or the daemon
 *  was already autostarted healthy. Declaring a non-empty list also
 *  re-enables the boot install when `updateCliOnBoot` is unset — entries
 *  are never silently dropped on the baked-template skip path. */
  installPackages?: string[]
  /** Timeout for the `npm i -g` update command. Default 120s. */
  updateCliTimeoutMs?: number
  /** Extra shell commands host-executed inside the box AFTER the boot `npm i -g`
   *  and BEFORE `agentproto serve` hands control to the agent. Generic
   *  provision-time hook — no policy baked in here; callers decide what to run
   *  (e.g. installing a git hook). Each entry is passed verbatim to
   *  `sandbox.commands.run`. Runs on EVERY boot/connect, even when the health
   *  probe finds the daemon already autostarted — entries must be idempotent. */
  setupCommands?: string[]
  /** Swap file (MiB) enabled on a FRESH boot, before the daemon starts.
   *  Default {@link DEFAULT_SWAP_MB}; `0` disables. Best-effort: a box that
   *  cannot enable swap still boots. Not re-run on `connect()` (a resumed box
   *  keeps its swap). */
  swapMb?: number
  /** Build-environment defaults sized to the box (see {@link buildEnvForBox}):
   *  `NODE_OPTIONS` heap plus workspace/turbo concurrency, derived from the
   *  resolved size preset — probed from the box (`nproc`, `free -m`) once at
   *  boot for an explicit custom `template` — and shipped to every in-box
   *  process (the daemon's start env, plus
   *  `/etc/profile.d/agentproto-build.sh` for login-shell commands such as
   *  the box agent's bash tool). `false` disables it entirely (no env merged,
   *  no profile file written); `{ concurrency, heapMb }` override the computed
   *  numbers (each field independently). Like `swapMb`, a non-finite or
   *  non-positive number is dropped, leaving the computed value for that
   *  field. A caller-provided env var of the same name always wins. */
  buildEnv?: false | { concurrency?: number; heapMb?: number }
}

function readE2bConfig(spec: SandboxSpec): E2bSandboxConfig {
  const config = (spec.config ?? {}) as Record<string, unknown>
  return {
    template: typeof config.template === "string" ? config.template : undefined,
    size: readSize(config.size),
    port: typeof config.port === "number" ? config.port : undefined,
    workspace: typeof config.workspace === "string" ? config.workspace : undefined,
    timeoutMs: typeof config.timeoutMs === "number" ? config.timeoutMs : undefined,
    onTimeout: config.onTimeout === "pause" || config.onTimeout === "kill" ? config.onTimeout : undefined,
    healthProbeTimeoutMs:
      typeof config.healthProbeTimeoutMs === "number" ? config.healthProbeTimeoutMs : undefined,
    daemonReadyTimeoutMs:
      typeof config.daemonReadyTimeoutMs === "number" ? config.daemonReadyTimeoutMs : undefined,
    pollIntervalMs: typeof config.pollIntervalMs === "number" ? config.pollIntervalMs : undefined,
    updateCliOnBoot: typeof config.updateCliOnBoot === "boolean" ? config.updateCliOnBoot : undefined,
    cliVersion: typeof config.cliVersion === "string" ? config.cliVersion : undefined,
    installPackages: Array.isArray(config.installPackages)
      ? config.installPackages.filter((p): p is string => typeof p === "string" && p.length > 0)
      : undefined,
    updateCliTimeoutMs:
      typeof config.updateCliTimeoutMs === "number" ? config.updateCliTimeoutMs : undefined,
    setupCommands: Array.isArray(config.setupCommands)
      ? config.setupCommands.filter((c): c is string => typeof c === "string" && c.length > 0)
      : undefined,
    swapMb:
      typeof config.swapMb === "number" && Number.isFinite(config.swapMb) && config.swapMb >= 0
        ? Math.floor(config.swapMb)
        : undefined,
    buildEnv: readBuildEnv(config.buildEnv),
  }
}

/** Validate `config.buildEnv`: `false` disables, an object keeps its valid
 *  `concurrency` / `heapMb` numbers (each dropped when it isn't a finite
 *  number >= 1, exactly how `swapMb` drops an invalid value), anything else
 *  falls back to the computed default. */
function readBuildEnv(value: unknown): E2bSandboxConfig["buildEnv"] {
  if (value === false) return false
  if (typeof value !== "object" || value === null) return undefined
  const source = value as Record<string, unknown>
  const read = (field: unknown): number | undefined =>
    typeof field === "number" && Number.isFinite(field) && field >= 1 ? Math.floor(field) : undefined
  const concurrency = read(source.concurrency)
  const heapMb = read(source.heapMb)
  if (concurrency === undefined && heapMb === undefined) return undefined
  return {
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(heapMb !== undefined ? { heapMb } : {}),
  }
}

const SIZE_NAMES = Object.keys(SIZES) as WorkstationSize[]

/** One `SIZES` entry, widened from the generated literal types. */
interface SizePreset {
  cpuCount: number
  memoryMb: number
  available: boolean
  unavailableReason?: string
  id: string | null
  alias: string
}

function isWorkstationSize(value: string): value is WorkstationSize {
  return Object.hasOwn(SIZES, value)
}

/** Validate `config.size`: absent is fine, anything else must name a preset. */
function readSize(value: unknown): WorkstationSize | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !isWorkstationSize(value)) {
    throw new Error(
      `e2b sandbox: unknown config.size ${JSON.stringify(value)}; valid sizes: ${SIZE_NAMES.join(", ")}`,
    )
  }
  return value
}

/**
 * The template a spec boots: an explicit `template` wins; else the `size`
 * preset's published template (by id, so the recorded bake applies); else
 * the bare default template. A preset e2b refused to create fails with the
 * error e2b returned rather than silently booting a smaller box.
 */
export function resolveTemplate(config: Pick<E2bSandboxConfig, "template" | "size">): string {
  if (config.template !== undefined) return config.template
  if (config.size === undefined) return DEFAULT_TEMPLATE
  const preset: SizePreset = SIZES[config.size]
  if (!preset.available) {
    throw new Error(
      `e2b sandbox: size "${config.size}" (${preset.cpuCount} vCPU / ${preset.memoryMb} MB) is unavailable — e2b refused to create its template: ${preset.unavailableReason ?? "not published"}`,
    )
  }
  return preset.id ?? preset.alias
}

/** Every published template whose bake is recorded: the channels plus each size. */
const KNOWN_TEMPLATES = { ...TEMPLATES, ...SIZES }

/**
 * Default the on-boot CLI update OFF only for a template whose recorded
 * `baked` block PROVES the image already carries the requested CLI pin —
 * the install would just re-download the same version (90-120s per cold
 * boot, npm registry dependency, and it replaces the template's baked
 * adapters). The gate is on the RECORDED bake, not the template id: an
 * out-of-band bake nobody has verified has `baked.cli: null` and keeps the
 * legacy default of true. A requested cliVersion that differs from the
 * recorded bake also installs. An explicit `updateCliOnBoot` always wins.
 */
export function resolveUpdateCli(
  config: Pick<E2bSandboxConfig, "updateCliOnBoot" | "cliVersion" | "installPackages">,
  template: string,
  templates: { [key: string]: { id: string | null; baked: { cli: string | null } } } = KNOWN_TEMPLATES,
): boolean {
  if (config.updateCliOnBoot !== undefined) return config.updateCliOnBoot
  // Runtime escape hatch: a caller declaring installPackages wants an
  // install to happen — never silently drop them on the skip path.
  if ((config.installPackages?.length ?? 0) > 0) return true
  const baked = Object.values(templates).find(entry => entry.id !== null && entry.id === template)?.baked
  if (!baked || baked.cli === null) return true
  // Recorded bake matches the requested pin (an unset cliVersion means the
  // bake itself is the pin) → nothing to install.
  return config.cliVersion !== undefined && config.cliVersion !== baked.cli
}

/**
 * Probe health, and — if the daemon isn't already up — update the (possibly
 * stale) baked CLI and start it, then re-probe. Shared by `boot` (a fresh
 * template's autostart may not have fired yet) and `connect` (a resumed box
 * may wake with a dead daemon process — see PR3 risk "stale daemon on
 * reconnect"). Throws (after killing the sandbox) if the daemon never comes
 * up.
 */
/** The command {@link enableSwap} runs: idempotent (no-op when any swap is
 *  already active) and never failing. */
export function buildSwapCommand(swapMb: number): string {
  return (
    `if [ -z "$(swapon --show --noheadings 2>/dev/null)" ]; then ` +
    `{ sudo fallocate -l ${swapMb}M /swapfile && sudo chmod 600 /swapfile && ` +
    `sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile; } >/dev/null 2>&1 || ` +
    `echo "swap not enabled"; fi`
  )
}

async function enableSwap(sandbox: Sandbox, swapMb: number): Promise<void> {
  if (swapMb <= 0) return
  try {
    await sandbox.commands.run(buildSwapCommand(swapMb), { timeoutMs: SWAP_SETUP_TIMEOUT_MS })
  } catch {
    // best-effort: a box without swap is still a working box
  }
}

/**
 * Build-environment defaults sized to a box. A plain `pnpm build` in a fresh
 * e2b box dies with "JavaScript heap out of memory" long before the RAM is
 * gone: pnpm runs several package builds at once (its own workspace
 * concurrency, one per vCPU by default) and each tsup DTS worker uses Node's
 * DEFAULT heap, while the adapter itself holds hundreds of MB — so the budget
 * has to be split across fewer, smaller workers than Node's 4 GB default
 * assumes:
 *
 * - `concurrency = max(1, min(cpuCount, floor(memoryMb / 3072)))` — at most
 *   one build per ~3 GB of box (8 GB → 2, 4 GB → 1, 2 GB → 1), never more
 *   than the box has CPUs;
 * - `heapMb = clamp(floor(memoryMb * 0.6 / concurrency), 768, 4096)` — each
 *   worker may hold 60% of RAM divided over the workers, floored at Node's
 *   practical minimum and capped well past what the box has (8 GB → 2457,
 *   4 GB → 2457, 2 GB → 1228).
 *
 * Pure: the caller resolves `cpuCount` / `memoryMb` from the boot's size
 * preset (default template = `DEFAULT_SIZE`) or from a one-shot in-box probe
 * for a custom template.
 */
export function buildEnvForBox(box: { cpuCount: number; memoryMb: number }): Record<string, string> {
  const cpuCount = Math.max(1, Math.floor(box.cpuCount))
  const memoryMb = Math.max(1, Math.floor(box.memoryMb))
  const concurrency = Math.max(1, Math.min(cpuCount, Math.floor(memoryMb / 3072)))
  const heapMb = Math.min(4096, Math.max(768, Math.floor((memoryMb * 0.6) / concurrency)))
  return {
    NODE_OPTIONS: `--max-old-space-size=${heapMb}`,
    npm_config_workspace_concurrency: String(concurrency),
    TURBO_CONCURRENCY: String(concurrency),
  }
}

/**
 * Layer the box's build env under the caller's passthrough env — a
 * caller-provided value for the same var ALWAYS wins, because it is an
 * explicit instruction about this specific run:
 *
 * - `NODE_OPTIONS` carrying a `--max-old-space-size` is kept untouched (the
 *   caller sized the heap themselves);
 * - a caller `NODE_OPTIONS` without one gets ours appended (their flags stay,
 *   the box still gets its heap budget);
 * - the two concurrency vars are per-var: caller value wins, ours only fills
 *   the gap.
 */
export function mergeBuildEnv(
  base: Record<string, string> | undefined,
  buildEnv: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...base }
  for (const [key, value] of Object.entries(buildEnv)) {
    if (key === "NODE_OPTIONS") {
      const caller = merged.NODE_OPTIONS
      if (caller === undefined || caller.trim() === "") merged.NODE_OPTIONS = value
      else if (!caller.includes("--max-old-space-size")) merged.NODE_OPTIONS = `${caller} ${value}`
      continue
    }
    if (merged[key] === undefined) merged[key] = value
  }
  return merged
}

/** Lines of the `/etc/profile.d/agentproto-build.sh` snippet: the same
 *  caller-wins rules as {@link mergeBuildEnv}, in shell, because the file is
 *  sourced by processes whose env we never saw (the agent's bash tool, any
 *  command a caller execs with its own env). Values are baked in at write
 *  time, so the script has no dependency on this host process. */
function profileScriptLines(env: Record<string, string>): string[] {
  const heapFlag = env.NODE_OPTIONS ?? ""
  const concurrency = env.npm_config_workspace_concurrency ?? "1"
  const turbo = env.TURBO_CONCURRENCY ?? concurrency
  return [
    "# Written by @agentproto/sandbox-e2b at boot: sizes Node builds to this box.",
    "# A caller-provided value always wins; this only fills the gaps.",
    `if [ -z "\${NODE_OPTIONS:-}" ]; then`,
    `  export NODE_OPTIONS="${heapFlag}"`,
    `else`,
    `  case "$NODE_OPTIONS" in`,
    `    *--max-old-space-size*) ;;`,
    `    *) export NODE_OPTIONS="$NODE_OPTIONS ${heapFlag}" ;;`,
    `  esac`,
    `fi`,
    `: "\${npm_config_workspace_concurrency:=${concurrency}}"`,
    `export npm_config_workspace_concurrency`,
    `: "\${TURBO_CONCURRENCY:=${turbo}}"`,
    `export TURBO_CONCURRENCY`,
  ]
}

/** The command {@link writeBuildEnvProfile} runs: writes the profile snippet
 *  (idempotent — `tee` overwrites) and, so a template whose login shell does
 *  NOT reach `/etc/profile.d` (or an interactive shell) still gets it, appends
 *  an idempotent `source` line to `~/.bashrc`. Never fails: like swap, a box
 *  that cannot write `/etc/profile.d` still boots — the daemon start env
 *  below carries the vars for this boot either way. */
export function buildProfileCommand(env: Record<string, string>): string {
  const script = profileScriptLines(env)
    .map(line => `'${line.replace(/'/g, `'\\''`)}'`)
    .join(" ")
  return (
    `{ printf '%s\\n' ${script} | sudo tee ${PROFILE_ENV_PATH} >/dev/null && ` +
    `{ grep -qF '${PROFILE_SOURCE_LINE}' "$HOME/.bashrc" 2>/dev/null || ` +
    `printf '%s\\n' '${PROFILE_SOURCE_LINE}' >> "$HOME/.bashrc"; }; ` +
    `} || echo "agentproto: build env not written"`
  )
}

async function writeBuildEnvProfile(sandbox: Sandbox, env: Record<string, string>): Promise<void> {
  try {
    await sandbox.commands.run(buildProfileCommand(env), { timeoutMs: BUILD_ENV_SETUP_TIMEOUT_MS })
  } catch {
    // best-effort: a box without a writable /etc/profile.d still boots
  }
}

/** `cpuCount` / `memoryMb` of the box about to run. A resolved size preset
 *  knows them statically; an explicit custom `template` doesn't, so they are
 *  read once from the box itself. A failed/garbled probe falls back to the
 *  default preset rather than skipping the build env — sizing to a known
 *  default is never worse than Node's own 4 GB default heap. */
async function probeBoxSize(sandbox: Sandbox): Promise<{ cpuCount: number; memoryMb: number }> {
  try {
    const result = await sandbox.commands.run("nproc; free -m | awk '/^Mem:/{print $2}'", {
      timeoutMs: BOX_SIZE_PROBE_TIMEOUT_MS,
    })
    const numbers = (result.stdout ?? "")
      .split("\n")
      .map(line => line.trim())
      .filter(line => /^\d+$/.test(line))
    const cpuCount = Number(numbers[0])
    const memoryMb = Number(numbers[1])
    if (cpuCount >= 1 && memoryMb >= 1) return { cpuCount, memoryMb }
  } catch {
    // best-effort — fall back to the default preset below
  }
  const fallback: SizePreset = SIZES[DEFAULT_SIZE]
  return { cpuCount: fallback.cpuCount, memoryMb: fallback.memoryMb }
}

/** Resolve this boot's build env: `null` when `config.buildEnv` is `false`,
 *  otherwise {@link buildEnvForBox} for the resolved size preset (default
 *  template = `DEFAULT_SIZE` preset) or a probed box size, with any
 *  `config.buildEnv` overrides applied on top. */
async function resolveBuildEnv(
  sandbox: Sandbox,
  config: E2bSandboxConfig,
): Promise<Record<string, string> | null> {
  if (config.buildEnv === false) return null
  // An explicit `template` wins over `size` (see resolveTemplate), and its
  // box size isn't recorded anywhere here — probe it instead.
  const preset: SizePreset | undefined =
    config.template !== undefined ? undefined : SIZES[config.size ?? DEFAULT_SIZE]
  const box =
    preset !== undefined
      ? { cpuCount: preset.cpuCount, memoryMb: preset.memoryMb }
      : await probeBoxSize(sandbox)
  const env = buildEnvForBox(box)
  const overrides = typeof config.buildEnv === "object" ? config.buildEnv : undefined
  if (overrides?.concurrency !== undefined) {
    const concurrency = String(overrides.concurrency)
    env.npm_config_workspace_concurrency = concurrency
    env.TURBO_CONCURRENCY = concurrency
  }
  if (overrides?.heapMb !== undefined) env.NODE_OPTIONS = `--max-old-space-size=${overrides.heapMb}`
  return env
}

async function ensureDaemonHealthy(
  sandbox: Sandbox,
  host: string,
  port: number,
  workspace: string,
  config: E2bSandboxConfig,
  env: Record<string, string>,
  updateCli: boolean,
): Promise<void> {
  const healthUrl = `https://${host}/health`
  const healthProbeTimeoutMs = config.healthProbeTimeoutMs ?? HEALTH_PROBE_TIMEOUT_MS
  const daemonReadyTimeoutMs = config.daemonReadyTimeoutMs ?? DAEMON_READY_TIMEOUT_MS
  const pollIntervalMs = config.pollIntervalMs ?? POLL_INTERVAL_MS

  const alreadyUp = await probeHealth(healthUrl, healthProbeTimeoutMs, pollIntervalMs)

  if (!alreadyUp && updateCli) {
    // One `npm i -g` for the CLI update AND any caller-declared extras
    // (`installPackages` — typically the adapter about to be spawned). The
    // CLI update alone replaces the global install and LOSES template-baked
    // adapters, so the two must land in the same invocation. Extras are
    // single-quoted (with any quote chars stripped) since they arrive from
    // caller-authored spec config.
    const extras = (config.installPackages ?? [])
      .map(spec => ` '${spec.replace(/'/g, "")}'`)
      .join("")
    const cli = `@agentproto/cli@${config.cliVersion ?? "latest"}`
    await sandbox.commands.run(`sudo npm i -g ${cli}${extras}`, {
      envs: env,
      timeoutMs: config.updateCliTimeoutMs ?? UPDATE_CLI_TIMEOUT_MS,
    })
  }
  // Caller-declared provision hooks — host-executed after the npm install and
  // before the agent gets control. Kept generic (no policy here); the ts layer
  // uses this to install a commit-msg hook that strips AI-attribution trailers.
  // Runs regardless of `alreadyUp`: the workstation template MAY autostart the
  // daemon (module doc above), and a caller-declared hook install must still
  // land on that path — callers rely on `setupCommands` entries being
  // idempotent so re-running them against an already-provisioned box is safe.
  for (const command of config.setupCommands ?? []) {
    await sandbox.commands.run(command, { envs: env })
  }

  // The workstation template MAY autostart the daemon (module doc above).
  // When the probe finds it already up, this provider never issues the start
  // command, so the merged build env in `env` does NOT reach that daemon — it
  // inherited the template's own environment at ITS start, and adapters it
  // already spawned inherited that too. What still covers this path is the
  // `/etc/profile.d/agentproto-build.sh` file written at boot: every command
  // run in the box afterwards (this provider's, a caller's `exec`, and the
  // box agent's bash tool — e2b starts them all as `/bin/bash -l -c`, a login
  // shell that sources `/etc/profile.d/*.sh`) picks the vars up, with the
  // caller's own value winning. Only the already-running daemon process and
  // its direct children keep the template's env until they are restarted.
  if (alreadyUp) return

  // Start the daemon in the background and KEEP THE HANDLE. Its stdout/stderr
  // accumulate on the handle, and `probeHealthOrExit` races the health poll
  // against the process's own exit: if the daemon dies during boot (e.g. it
  // crashes loading a baked adapter on a broken image) we fail fast with its
  // captured output instead of blocking the caller for the whole readiness
  // window. See PR fix (2026-09-05): a boot that can't become healthy must
  // fail fast with the box's daemon output, never hang the HTTP/MCP call.
  const serve = await sandbox.commands.run(
    `agentproto serve --port ${port} --bind 0.0.0.0 --workspace ${workspace} --allow-origin https://${host}`,
    // timeoutMs: 0 disables e2b's per-command timeout — which DEFAULTS TO 60
    // SECONDS and applies to `background: true` commands too, silently
    // SIGKILLing the daemon one minute after boot. That was the root cause of
    // every long agent turn dying with "sandbox is running but port is not
    // open" (502) / `MCP error -32001` while short (<60s) probe turns passed
    // — verified live: the daemon's port went dead at exactly serve+60s with
    // the VM healthy and memory flat. The daemon must live as long as the
    // SANDBOX (lifetime cap above), not as long as a shell command.
    { background: true, envs: env, timeoutMs: 0 },
  )
  const outcome = await probeHealthOrExit(healthUrl, serve, daemonReadyTimeoutMs, pollIntervalMs)
  if (!outcome.healthy) {
    // Deliberately do NOT kill the box here — `boot`/`connect` own that
    // cleanup so EVERY failure path (a throwing npm install, a failing setup
    // hook, or this one) reclaims the VM through a single place and can never
    // leak a running, session-less box (observed live 2026-09-05: the daemon
    // gave up but the box kept running with no session record).
    const detail = boxDaemonOutput(serve)
    throw new Error(
      `@agentproto/sandbox-e2b: agentproto daemon did not become healthy at ${healthUrl} ` +
        `within ${daemonReadyTimeoutMs}ms (sandbox ${sandbox.sandboxId})` +
        `${outcome.exited ? " — the box daemon process exited during boot" : ""}.` +
        `${detail ? `\n--- box daemon output ---\n${detail}` : ""}`,
    )
  }
}

/** Wrap a healthy sandbox handle into the `BootedSandbox` shape common to
 *  `boot` and `connect`. `pause()` always keeps the full memory snapshot
 *  (`keepMemory: true`, the SDK default) — a filesystem-only pause would
 *  cold-boot the box on resume, dropping the running agentproto daemon and
 *  any open connections (PR3 risk "e2b pause loses in-memory state").
 *
 *  `extraPorts` (from `spec.extraPorts`) are resolved eagerly at boot time
 *  into the returned `ports` map (port → `https://<getHost(port)>`).
 *  `expose(port)` works for any port — not just pre-declared ones — so
 *  callers can also expose ports lazily after boot. */
function toBootedSandbox(
  sandbox: Awaited<ReturnType<typeof Sandbox.create>>,
  host: string,
  token: string | undefined,
  extraPorts: number[] | undefined,
  lifetimeMs: number,
): BootedSandbox {
  const ports: Record<number, string> = {}
  for (const port of extraPorts ?? []) {
    ports[port] = `https://${sandbox.getHost(port)}`
  }
  return {
    mcpUrl: `https://${host}/mcp`,
    sandboxId: sandbox.sandboxId,
    lifetimeMs,
    ...(token ? { token } : {}),
    ...(Object.keys(ports).length > 0 ? { ports } : {}),
    expose(port: number): Promise<{ url: string }> {
      return Promise.resolve({ url: `https://${sandbox.getHost(port)}` })
    },
    async stop(): Promise<void> {
      await sandbox.kill()
    },
    async pause(): Promise<void> {
      await sandbox.pause({ keepMemory: true })
    },
    /** Re-arm the box's remaining lifetime to `ms` from now — the same SDK
     *  call `connect()` already uses to re-arm a resumed box's deadline
     *  (see module docs above), exposed so a host can extend it again on
     *  detach or during activity without a full reconnect. Clamped to the
     *  account cap so a renewal never throws on it. */
    async extendTimeout(ms: number): Promise<void> {
      await sandbox.setTimeout(Math.min(ms, MAX_SANDBOX_TIMEOUT_MS))
    },
    /**
     * Run ONE command inside the box (e2b `sandbox.commands.run`, foreground)
     * and return its exit code + captured streams. A NON-ZERO exit is a
     * RESULT here, not a rejection: the SDK throws `CommandExitError` carrying
     * the same `exitCode`/`stdout`/`stderr`, so this unwraps it into the
     * result shape the runtime's `sandbox_exec` tool reports verbatim.
     * Everything else (the SDK's own TimeoutError when `opts.timeoutMs`
     * elapses, transport errors, envd being down) propagates — the caller
     * turns a throw into a failed exec.
     */
    async exec(opts: SandboxExecOpts): Promise<SandboxExecResult> {
      const startedAt = Date.now()
      try {
        const result = await sandbox.commands.run(opts.command, {
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(opts.env !== undefined ? { envs: opts.env } : {}),
          // e2b's per-command timeout DEFAULTS TO 60 SECONDS: an omitted
          // timeoutMs would SIGKILL any real test run after one minute. 0
          // disables it, so the command lives as long as the box (lifetime
          // cap above) unless the caller sets its own bound.
          timeoutMs: opts.timeoutMs ?? 0,
        })
        return {
          exitCode: result.exitCode,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          durationMs: Date.now() - startedAt,
        }
      } catch (err) {
        if (err instanceof CommandExitError) {
          return {
            exitCode: err.exitCode,
            stdout: err.stdout ?? "",
            stderr: err.stderr ?? "",
            durationMs: Date.now() - startedAt,
          }
        }
        // The SDK echoes the whole shelled command in its error message
        // (`error starting process '/bin/bash -l -c <command>'`): cut it down so
        // a 9 KB script is not dumped and a secret inlined in it does not leak.
        if (err instanceof Error) {
          const scrubbed = scrubCommandFromMessage(err.message, opts.command)
          if (scrubbed !== err.message) {
            const wrapped = new Error(scrubbed)
            wrapped.name = err.name
            throw wrapped
          }
        }
        throw err
      }
    },
    async readFile(path: string): Promise<Uint8Array> {
      return sandbox.files.read(path, { format: "bytes", requestTimeoutMs: READ_FILE_TIMEOUT_MS })
    },
    async writeFile(path: string, data: Uint8Array): Promise<void> {
      // `data` is copied into a fresh ArrayBuffer: the SDK accepts ArrayBuffer,
      // not a (possibly offset) Uint8Array view.
      const copy = new Uint8Array(data.byteLength)
      copy.set(data)
      await sandbox.files.write(path, copy.buffer, { requestTimeoutMs: READ_FILE_TIMEOUT_MS })
    },
  }
}

/**
 * The e2b `lifecycle.onTimeout` for a fresh boot. An explicit
 * `config.onTimeout` wins; otherwise a spec that declares
 * `lifecycle.pause_after_idle` gets `"pause"`, because e2b's own default
 * (`kill`, measured 2026-10-15) would destroy a box whose whole point is to
 * survive going idle — a forgotten box would lose its state instead of
 * parking it, and pausing costs nothing (a paused box is not billed and
 * holds no concurrency slot). `undefined` leaves the field out of the create
 * request, so every other spec keeps e2b's default untouched.
 */
function resolveOnTimeout(spec: SandboxSpec, config: E2bSandboxConfig): "pause" | "kill" | undefined {
  if (config.onTimeout) return config.onTimeout
  return resolveLifecyclePolicy(spec, false).pauseAfterIdleMs !== undefined ? "pause" : undefined
}

/** `files.read` defaults to a 60s request timeout, too short for the largest
 *  bundle the delivery path will pull (50 MiB) over a slow link. */
const READ_FILE_TIMEOUT_MS = 5 * 60_000

/**
 * EUR cost model for e2b boxes. The defaults are the W0 e2b numbers from
 * `projects/computer/CONTRACT-SCALE.md:147-151`; every field can be
 * overridden through the `AGENTPROTO_E2B_PRICING` env var (JSON with
 * `usdPerVcpuHour`, `usdPerGibHour`, `eurPerUsd`).
 *
 * Cost is ESTIMATED: e2b reports the box's CPU/RAM and its started/expiry
 * times, not its actual billed usage, so the window is derived from the
 * allocated size over the active interval. An override that is absent,
 * malformed or missing a field is UNKNOWN pricing, never a guess: the
 * producer then reports `costEur: null` instead of `0`.
 */
export interface E2bPricing {
  usdPerVcpuHour: number
  usdPerGibHour: number
  eurPerUsd: number
}

/** W0 e2b prices, `CONTRACT-SCALE.md:147-151`. */
export const DEFAULT_E2B_PRICING: Readonly<E2bPricing> = {
  usdPerVcpuHour: 0.0504,
  usdPerGibHour: 0.0162,
  eurPerUsd: 0.92,
}

/**
 * Resolve the EUR e2b pricing table: the W0 defaults when
 * `AGENTPROTO_E2B_PRICING` is unset, the parsed override when every field is
 * a finite non-negative number, and `null` (unknown, so callers report
 * `costEur: null`) when the override cannot be trusted.
 */
export function resolveE2bPricing(env: NodeJS.ProcessEnv = process.env): E2bPricing | null {
  const raw = env.AGENTPROTO_E2B_PRICING
  if (raw === undefined || raw.trim() === "") return { ...DEFAULT_E2B_PRICING }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const source = parsed as Record<string, unknown>
  const field = (key: keyof E2bPricing): number | null => {
    const value = source[key]
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
  }
  const usdPerVcpuHour = field("usdPerVcpuHour")
  const usdPerGibHour = field("usdPerGibHour")
  const eurPerUsd = field("eurPerUsd")
  if (usdPerVcpuHour === null || usdPerGibHour === null || eurPerUsd === null) return null
  return { usdPerVcpuHour, usdPerGibHour, eurPerUsd }
}

/** Estimated cost of `vcpuSec`/`gibSec` at `pricing`, or `null` when unknown. */
function e2bCostEur(
  vcpuSec: number,
  gibSec: number,
  pricing: E2bPricing | null,
): number | null {
  if (pricing === null) return null
  return (
    (vcpuSec / 3600) * pricing.usdPerVcpuHour * pricing.eurPerUsd +
    (gibSec / 3600) * pricing.usdPerGibHour * pricing.eurPerUsd
  )
}

/** ISO-8601 for an SDK `Date`, or `undefined` when the SDK never set it. */
function isoOrUndefined(value: Date | undefined): string | undefined {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : undefined
}

/**
 * Map one e2b control-plane `SandboxInfo` onto the unified `SandboxBox`.
 * A paused box is listed too: it still bills (it keeps its RAM snapshot) and
 * is exactly what the orphan gc must see. Ownership is unknown: this
 * provider writes no metadata at boot, so `tenantId`/`endUser` stay absent.
 */
function toSandboxBox(info: SandboxInfo): SandboxBox {
  const createdAt = isoOrUndefined(info.startedAt)
  return {
    id: info.sandboxId,
    provider: "e2b",
    ...(info.state !== undefined ? { state: String(info.state) } : {}),
    ...(Number.isFinite(info.cpuCount) ? { cpus: info.cpuCount } : {}),
    ...(Number.isFinite(info.memoryMB) ? { memoryMiB: info.memoryMB } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

/** One page-at-a-time read of `Sandbox.list()`, which by default includes
 *  both `running` and `paused` boxes. */
async function listSandboxInfos(): Promise<SandboxInfo[]> {
  const infos: SandboxInfo[] = []
  const paginator = Sandbox.list({ apiKey: process.env.E2B_API_KEY })
  while (paginator.hasNext) {
    infos.push(...(await paginator.nextItems()))
  }
  return infos
}

/** Clamp `[startMs, endMs]` to `[fromMs, toMs]`, returning null when empty. */
function clampInterval(
  startMs: number | undefined,
  endMs: number,
  fromMs: number,
  toMs: number,
): { fromMs: number; toMs: number } | null {
  if (startMs === undefined) return null
  const start = Math.max(startMs, fromMs)
  const end = Math.min(endMs, toMs)
  return end > start ? { fromMs: start, toMs: end } : null
}

/** `e2bSandboxProvider.boot`/`.connect` — see module docs. */
export const e2bSandboxProvider: SandboxProvider = {
  async boot(spec: SandboxSpec, opts: SandboxBootOpts): Promise<BootedSandbox> {
    const config = readE2bConfig(spec)
    const template = resolveTemplate(config)
    const port = config.port ?? DEFAULT_PORT
    const workspace = config.workspace ?? DEFAULT_WORKSPACE

    const onTimeout = resolveOnTimeout(spec, config)
    const sandbox = await Sandbox.create(template, {
      apiKey: process.env.E2B_API_KEY,
      envs: opts.env,
      timeoutMs: config.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
      ...(onTimeout ? { lifecycle: { onTimeout } } : {}),
    })

    // Once the VM exists, EVERY failure after this point must reclaim it —
    // a slow/failed `npm i -g`, a throwing setup hook, or a daemon that never
    // becomes healthy. Otherwise the caller's request (which may have already
    // timed out and walked away) leaves a running, session-less box behind
    // (observed live 2026-09-05, six leaked boxes). This single catch is the
    // only owner of that cleanup — `ensureDaemonHealthy` never kills.
    try {
      const host = sandbox.getHost(port)
      await enableSwap(sandbox, config.swapMb ?? DEFAULT_SWAP_MB)
      // Size Node builds to this box and ship it BOTH ways: a profile.d file
      // (covers every login-shell command run from here on, bash tool
      // included) and the env handed to `ensureDaemonHealthy` below, which
      // lands on the npm install, the setup hooks and — load-bearing for the
      // agent — the daemon start, so the daemon and every adapter it spawns
      // inherit it.
      const buildEnv = await resolveBuildEnv(sandbox, config)
      if (buildEnv !== null) await writeBuildEnvProfile(sandbox, buildEnv)
      const env = buildEnv !== null ? mergeBuildEnv(opts.env, buildEnv) : opts.env
      await ensureDaemonHealthy(sandbox, host, port, workspace, config, env, resolveUpdateCli(config, template))
      return toBootedSandbox(
        sandbox,
        host,
        undefined,
        spec.extraPorts,
        config.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
      )
    } catch (err) {
      await sandbox.kill().catch(() => undefined)
      throw err
    }
  },

  async connect(sandboxId: string, spec: SandboxSpec, opts: SandboxBootOpts): Promise<BootedSandbox> {
    const config = readE2bConfig(spec)
    // A resumed box keeps its original template — resolve against the
    // configured template the same way `boot` does, before touching the box.
    const template = resolveTemplate(config)
    const port = config.port ?? DEFAULT_PORT
    const workspace = config.workspace ?? DEFAULT_WORKSPACE

    let sandbox
    try {
      sandbox = await Sandbox.connect(sandboxId, { apiKey: process.env.E2B_API_KEY })
    } catch (err) {
      // A vanished box must surface as the portability sentinel, not a raw
      // SDK error — the reconnect path (session-spawn) and the ledger rely
      // on `isSandboxBoxGoneError` to flip the ledger row to "gone" instead
      // of leaving a phantom paused/connected entry advertising an app URL.
      if (err instanceof SandboxNotFoundError) throw new SandboxBoxGoneError(sandboxId, err)
      throw err
    }
    // A resumed box keeps its ORIGINAL lifetime deadline — re-arm it so the
    // reconnected session gets the same runway a fresh boot gets (same
    // 5-minute-default trap as `boot`, see DEFAULT_SANDBOX_TIMEOUT_MS).
    await sandbox.setTimeout(config.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS)

    // Same never-leak contract as `boot`: a reconnect whose daemon won't come
    // back healthy must reclaim the box rather than leave it running orphaned.
    try {
      const host = sandbox.getHost(port)
      // Not re-run on connect: the profile.d file (and the swap file) written
      // at boot survive on the resumed box — same contract as `enableSwap`.
      // The build env is still resolved and merged, so a daemon this
      // reconnect has to (re)start, and any setup hook it runs, get the same
      // env a fresh boot would give them.
      const buildEnv = await resolveBuildEnv(sandbox, config)
      const env = buildEnv !== null ? mergeBuildEnv(opts.env, buildEnv) : opts.env
      await ensureDaemonHealthy(sandbox, host, port, workspace, config, env, resolveUpdateCli(config, template))
      return finishConnect(sandbox, host, opts, spec)
    } catch (err) {
      await sandbox.kill().catch(() => undefined)
      throw err
    }
  },

  /**
   * Poll the provider control plane (`GET /sandboxes/:id` via the SDK's
   * `Sandbox.getInfo`) — cheap (one authed HTTP call, no box contact),
   * exactly the liveness signal a vanished box needs while the session
   * descriptor and ledger still say paused/connected. `{alive:false}` on
   * e2b's 404 ("Sandbox Not Found"); rethrows anything else so callers
   * read "check failed", never "box died". NOTE (operator guidance): e2b
   * also offers sandbox lifecycle webhooks, which would push death instead
   * of forcing a poll — the SDK in-tree exposes no webhook/event API, so
   * polling stays the implemented probe; switch to (or augment with) the
   * webhook if/when the SDK surfaces one.
   */
  async probe(sandboxId: string): Promise<SandboxProbeResult> {
    try {
      const info = await Sandbox.getInfo(sandboxId, { apiKey: process.env.E2B_API_KEY })
      return { alive: true, ...(info.state !== undefined ? { state: String(info.state) } : {}) }
    } catch (err) {
      if (err instanceof SandboxNotFoundError) return { alive: false }
      throw err
    }
  },

  /**
   * Destroy the sandbox through its control plane — no `connect()`, so an
   * already-dead or paused box is reaped without touching its state. An
   * already-gone id is success (the box this was asked to remove doesn't
   * exist; the SIDE EFFECTS of removing it — the slot freed — are achieved).
   */
  async remove(sandboxId: string): Promise<void> {
    try {
      await Sandbox.kill(sandboxId, { apiKey: process.env.E2B_API_KEY })
    } catch (err) {
      if (err instanceof SandboxNotFoundError) return
      throw err
    }
  },

  /**
   * Every box the e2b account still holds, running AND paused (paused boxes
   * keep billing for their memory snapshot). One `Sandbox.list()` read, all
   * pages followed. The SDK is only touched when this method (or `usage`,
   * which shares the read) is called.
   */
  async list(): Promise<SandboxBox[]> {
    return (await listSandboxInfos()).map(toSandboxBox)
  },

  /**
   * ESTIMATED usage windows derived from the same control-plane inventory:
   * e2b exposes `startedAt`/`endAt`/`cpuCount`/`memoryMB`, not a billing
   * ledger, so one window is produced per box over the active interval
   * `[startedAt, min(endAt, now)]` clamped to `[from, to]`. A box with no
   * overlap is omitted.
   *
   * `tenantId` is the literal `"unknown"`: this provider writes no ownership
   * metadata at boot, and inventing a tenant would misattribute the cost.
   * For the same reason an `endUser` filter matches nothing (e2b does not
   * record an end user). Cost is estimated from the W0 table unless
   * `AGENTPROTO_E2B_PRICING` overrides it; unknown pricing yields
   * `costEur: null`, never `0`.
   */
  async usage(opts: { from: string; to: string; endUser?: string }): Promise<SandboxUsageWindow[]> {
    if (opts.endUser !== undefined) return []
    const fromMs = Date.parse(opts.from)
    const toMs = Date.parse(opts.to)
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return []
    const nowMs = Date.now()
    const pricing = resolveE2bPricing()
    const windows: SandboxUsageWindow[] = []
    for (const info of await listSandboxInfos()) {
      const startedMs = info.startedAt instanceof Date ? info.startedAt.getTime() : undefined
      const expiryMs =
        info.endAt instanceof Date ? info.endAt.getTime() : Number.POSITIVE_INFINITY
      const interval = clampInterval(startedMs, Math.min(expiryMs, nowMs), fromMs, toMs)
      if (interval === null) continue
      const activeSec = Math.floor((interval.toMs - interval.fromMs) / 1000)
      if (activeSec <= 0) continue
      const cpus = Number.isFinite(info.cpuCount) ? info.cpuCount : 0
      const memoryMiB = Number.isFinite(info.memoryMB) ? info.memoryMB : 0
      const vcpuSec = Math.round(activeSec * cpus)
      const gibSec = (activeSec * memoryMiB) / 1024
      windows.push({
        computer: info.sandboxId,
        tenantId: "unknown",
        provider: "e2b",
        from: new Date(interval.fromMs).toISOString(),
        to: new Date(interval.toMs).toISOString(),
        activeSec,
        vcpuSec,
        gibSec,
        costEur: e2bCostEur(vcpuSec, gibSec, pricing),
      })
    }
    return windows
  },
}

/** Tail of `connect` — surface e2b's private-traffic token (when asked) and
 *  wrap the healthy handle. Split out so the `connect` body's try/catch stays
 *  a thin never-leak guard around the boot work. */
function finishConnect(
  sandbox: Sandbox,
  host: string,
  opts: SandboxBootOpts,
  spec: SandboxSpec,
): BootedSandbox {
  // `opts.expose === "private"` (only ever set by `attachSandbox`, see
  // @agentproto/runtime) surfaces e2b's own "restricted public traffic"
  // token, when the sandbox has one — it gates access to EVERY exposed
  // port, this one included, at e2b's edge (distinct from `SandboxOpts.
  // secure`, which only covers envd's own control-plane traffic — see
  // module docs). Best-effort: e2b's SDK only exposes the token as a
  // readonly property with no documented guarantee it's populated on a
  // reconnect for a sandbox that wasn't created with traffic restriction
  // enabled. Unverified against a live sandbox.
  const token = opts.expose === "private" ? sandbox.trafficAccessToken : undefined
  return toBootedSandbox(
    sandbox,
    host,
    token,
    spec.extraPorts,
    readE2bConfig(spec).timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
  )
}

/** Poll `url` until it responds OK, or return false once `timeoutMs` elapses. */
async function probeHealth(url: string, timeoutMs: number, pollIntervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(pollIntervalMs) })
      if (res.ok) return true
    } catch {
      // not up yet — fall through to the deadline check
    }
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
}

/** A background `commands.run` handle, narrowed to just what boot-readiness
 *  needs. Kept structural (not `import type { CommandHandle }`) so the health
 *  race stays trivially fakeable in unit tests and tolerant of a provider/SDK
 *  that returns a plainer object. */
interface BackgroundCommand {
  /** Resolves when the process finishes; REJECTS (`CommandExitError`) on a
   *  non-zero exit. Either way the process is gone. Absent ⇒ we can't observe
   *  an early exit and fall back to polling the deadline. */
  wait?: () => Promise<unknown>
  /** `undefined` while the process is still running. */
  exitCode?: number
  stdout?: string
  stderr?: string
}

/**
 * Poll `url` until the daemon is healthy, the deadline elapses, OR the daemon
 * process (`handle`) exits — whichever comes first. Returns `{ healthy,
 * exited }`. `exited: true` means the serve process died during boot, so the
 * caller can fail FAST (with the daemon's captured output) instead of waiting
 * out the full readiness window — the difference between a crashing image
 * surfacing its stderr in ~1s and hanging the HTTP/MCP call for 30s+.
 */
async function probeHealthOrExit(
  url: string,
  handle: BackgroundCommand,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<{ healthy: boolean; exited: boolean }> {
  const deadline = Date.now() + timeoutMs
  let exited = false
  // `wait()` rejects with CommandExitError on a non-zero exit and resolves on
  // a zero exit — either way the daemon is no longer running, so treat both
  // identically. Only observe the exit when the handle actually supports it;
  // a plain `{}` (some tests/providers) must NOT be read as an instant exit.
  if (typeof handle.wait === "function") {
    void handle.wait().then(
      () => {
        exited = true
      },
      () => {
        exited = true
      },
    )
  }
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(pollIntervalMs) })
      if (res.ok) return { healthy: true, exited: false }
    } catch {
      // not up yet — fall through to the exit/deadline checks
    }
    if (exited || handle.exitCode !== undefined) return { healthy: false, exited: true }
    if (Date.now() >= deadline) return { healthy: false, exited: false }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
}

/** Best-effort tail of a background daemon handle's captured output, for
 *  embedding in a boot-failure error so a broken image is diagnosable from the
 *  caller's error alone. Empty when nothing was captured — a still-running but
 *  unhealthy daemon buffers its stdout until exit, so this is populated mainly
 *  when the process actually died. Bounded so a chatty crash can't bloat the
 *  error. */
function boxDaemonOutput(handle: BackgroundCommand): string {
  const joined = [handle.stderr ?? "", handle.stdout ?? ""]
    .map(s => s.trim())
    .filter(Boolean)
    .join("\n")
  const MAX = 2_000
  return joined.length > MAX ? `…${joined.slice(-MAX)}` : joined
}
