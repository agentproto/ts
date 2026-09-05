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

import { Sandbox } from "e2b"
import type { BootedSandbox, SandboxBootOpts, SandboxProvider, SandboxSpec } from "@agentproto/sandbox"
import { DEFAULT_TEMPLATE, TEMPLATES } from "./template-versions.generated.js"

/** Re-exported from the generated module (single source:
 *  `templates/workstation/versions.json` via scripts/sync-templates.mjs). */
export { DEFAULT_TEMPLATE, TEMPLATES }

/** `serve.ts`'s default port (`DEFAULT_MCP_URL` in `@agentproto/harness`). */
const DEFAULT_PORT = 18790
/**
 * Default sandbox LIFETIME. e2b's own default is 5 minutes (`SandboxOpts.
 * timeoutMs @default 300_000`) — lethal for real agent work: boot (~30s) +
 * `npm i -g` (~90s) + a multi-minute agent turn crosses 5:00 mid-turn, e2b
 * reaps the VM, and the next request cold-boots it WITHOUT the daemon —
 * surfacing as the baffling `"The sandbox is running but port is not open"`
 * 502 (observed live killing a PR-review turn). 45 minutes covers any
 * plausible session; `config.timeoutMs` still overrides in either direction.
 */
const DEFAULT_SANDBOX_TIMEOUT_MS = 45 * 60_000
const DEFAULT_WORKSPACE = "/home/user"
const HEALTH_PROBE_TIMEOUT_MS = 3_000
const DAEMON_READY_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 500
const UPDATE_CLI_TIMEOUT_MS = 120_000

interface E2bSandboxConfig {
  /** Template name or id. Defaults to the `agentproto-workstation` template. */
  template?: string
  /** Port the agentproto daemon listens on inside the sandbox. Default 18790. */
  port?: number
  /** `--workspace` passed to `agentproto serve`. Default `/home/user`. */
  workspace?: string
  /** Sandbox lifetime cap, forwarded to `Sandbox.create`. */
  timeoutMs?: number
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
}

function readE2bConfig(spec: SandboxSpec): E2bSandboxConfig {
  const config = (spec.config ?? {}) as Record<string, unknown>
  return {
    template: typeof config.template === "string" ? config.template : undefined,
    port: typeof config.port === "number" ? config.port : undefined,
    workspace: typeof config.workspace === "string" ? config.workspace : undefined,
    timeoutMs: typeof config.timeoutMs === "number" ? config.timeoutMs : undefined,
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
  }
}

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
  templates: { [key: string]: { id: string | null; baked: { cli: string | null } } } = TEMPLATES,
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
  token?: string,
  extraPorts?: number[],
): BootedSandbox {
  const ports: Record<number, string> = {}
  for (const port of extraPorts ?? []) {
    ports[port] = `https://${sandbox.getHost(port)}`
  }
  return {
    mcpUrl: `https://${host}/mcp`,
    sandboxId: sandbox.sandboxId,
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
  }
}

/** `e2bSandboxProvider.boot`/`.connect` — see module docs. */
export const e2bSandboxProvider: SandboxProvider = {
  async boot(spec: SandboxSpec, opts: SandboxBootOpts): Promise<BootedSandbox> {
    const config = readE2bConfig(spec)
    const template = config.template ?? DEFAULT_TEMPLATE
    const port = config.port ?? DEFAULT_PORT
    const workspace = config.workspace ?? DEFAULT_WORKSPACE

    const sandbox = await Sandbox.create(template, {
      apiKey: process.env.E2B_API_KEY,
      envs: opts.env,
      timeoutMs: config.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
    })

    // Once the VM exists, EVERY failure after this point must reclaim it —
    // a slow/failed `npm i -g`, a throwing setup hook, or a daemon that never
    // becomes healthy. Otherwise the caller's request (which may have already
    // timed out and walked away) leaves a running, session-less box behind
    // (observed live 2026-09-05, six leaked boxes). This single catch is the
    // only owner of that cleanup — `ensureDaemonHealthy` never kills.
    try {
      const host = sandbox.getHost(port)
      await ensureDaemonHealthy(sandbox, host, port, workspace, config, opts.env, resolveUpdateCli(config, template))
      return toBootedSandbox(sandbox, host, undefined, spec.extraPorts)
    } catch (err) {
      await sandbox.kill().catch(() => undefined)
      throw err
    }
  },

  async connect(sandboxId: string, spec: SandboxSpec, opts: SandboxBootOpts): Promise<BootedSandbox> {
    const config = readE2bConfig(spec)
    const port = config.port ?? DEFAULT_PORT
    const workspace = config.workspace ?? DEFAULT_WORKSPACE

    const sandbox = await Sandbox.connect(sandboxId, { apiKey: process.env.E2B_API_KEY })
    // A resumed box keeps its ORIGINAL lifetime deadline — re-arm it so the
    // reconnected session gets the same runway a fresh boot gets (same
    // 5-minute-default trap as `boot`, see DEFAULT_SANDBOX_TIMEOUT_MS).
    await sandbox.setTimeout(config.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS)

    // Same never-leak contract as `boot`: a reconnect whose daemon won't come
    // back healthy must reclaim the box rather than leave it running orphaned.
    try {
      const host = sandbox.getHost(port)
      // A resumed box keeps its original template — resolve against the
      // configured template the same way `boot` does.
      await ensureDaemonHealthy(sandbox, host, port, workspace, config, opts.env, resolveUpdateCli(config, config.template ?? DEFAULT_TEMPLATE))
      return finishConnect(sandbox, host, opts, spec)
    } catch (err) {
      await sandbox.kill().catch(() => undefined)
      throw err
    }
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
  return toBootedSandbox(sandbox, host, token, spec.extraPorts)
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
