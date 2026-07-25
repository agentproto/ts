/**
 * ascii.dev Box `SandboxProvider` — boots a Box cloud computer, ensures an
 * always-on systemd unit for the agentproto daemon is installed and running
 * on it, and exposes the daemon's `/mcp` endpoint via a stable Box hostname
 * so `createSandboxAgentSessionHost` (`@agentproto/sandbox`) can hand it
 * straight to `connectDaemonAgentSessionHost`.
 *
 * Box's `host <id> <port>` CLI exposes a port at
 * `https://<box-subdomain>-<port>.on.ascii.dev`, and re-running it for the
 * same box+port returns the same URL — so the hostname is computed directly
 * from `Box.subdomain` (assigned once, persists across stop/resume/fork)
 * rather than re-derived per call.
 *
 * Unlike e2b — whose per-command API can background a process that outlives
 * the command (`background: true`) but whose default 60s command timeout
 * SIGKILLs it anyway unless disabled — Box's command API
 * (`POST /boxes/{id}/commands`) is synchronous-only: it waits for the
 * process to exit and returns its output, with no background flag at all.
 * A process started via a bare `&` would die with the command's process
 * group. So the daemon is installed as a `systemd` unit (`Restart=always`)
 * instead: `systemctl enable --now` hands it to PID 1, which is exactly
 * what survives `box stop` (filesystem snapshot) + `box resume` — CLEANER
 * than e2b, which has to re-issue its serve command after every resume.
 *
 * systemd services don't inherit the invoking shell's environment, so the
 * secrets resolved into `opts.env` (e.g. `OPENROUTER_API_KEY`) are written to
 * an `EnvironmentFile` the unit references — otherwise the long-lived daemon
 * would boot with none of the credentials the agent step needs.
 */

import { BoxApi, Configuration, type Box } from "@asciidev/box-sdk"
import type { BootedSandbox, SandboxBootOpts, SandboxProvider, SandboxSpec } from "@agentproto/sandbox"

/** `serve.ts`'s default port (`DEFAULT_MCP_URL` in `@agentproto/harness`). */
const DEFAULT_PORT = 18790
/** Box's documented default login user / home directory. */
const DEFAULT_WORKSPACE = "/home/user"
/**
 * Default Box lifetime. Box's own default TTL is 3600s (1 hour) —
 * survivable for short turns but the same class of mid-turn-reaper risk
 * e2b's 5-minute default caused (`DEFAULT_SANDBOX_TIMEOUT_MS` in
 * `@agentproto/sandbox-e2b`): boot + provisioning + a multi-minute agent
 * turn can cross the deadline. `null` disables Box's auto-stop entirely
 * (`box new --no-auto-stop` / `ttlSeconds: null`) — `config.ttlSeconds`
 * still overrides in either direction.
 */
const DEFAULT_TTL_SECONDS = null
const HEALTH_PROBE_TIMEOUT_MS = 3_000
const DAEMON_READY_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 500
/** Fixed per-request HTTP timeout for health-probe fetches, deliberately
 *  decoupled from `pollIntervalMs` (the delay BETWEEN probe attempts) — a
 *  short poll cadence must not also force each individual fetch to time out
 *  almost immediately on slow/congested networks. */
const HEALTH_FETCH_TIMEOUT_MS = 5_000
const UPDATE_CLI_TIMEOUT_SECONDS = 120
/** How long to wait for a fresh/resumed box to reach a usable state and get
 *  its subdomain assigned. Box is a fuller "cloud computer" than e2b's
 *  Firecracker microVM, so boot can take noticeably longer than e2b's. */
const BOX_READY_TIMEOUT_MS = 120_000

const READY_STATES = new Set(["ready", "idle", "running"])
const TERMINAL_BAD_STATES = new Set(["archived", "archiving", "error"])

/** Default retry policy for `withBoxRetry` — 5 attempts, 1s/2s/4s/8s backoff. */
const BOX_RETRY_ATTEMPTS = 5
const BOX_RETRY_BASE_DELAY_MS = 1_000

const ENV_FILE_DIR = "/etc/agentproto"
const ENV_FILE_PATH = `${ENV_FILE_DIR}/agentproto.env`
const SYSTEMD_UNIT_PATH = "/etc/systemd/system/agentproto.service"

interface BoxSandboxConfig {
  /** Port the agentproto daemon listens on inside the box. Default 18790. */
  port?: number
  /** `--workspace` passed to `agentproto serve`. Default `/home/user`. */
  workspace?: string
  /** Box lifetime cap in seconds, forwarded as `ttlSeconds` on create.
   *  `null` disables Box's auto-stop. Defaults to `null` (see
   *  DEFAULT_TTL_SECONDS above) — Box's own default is a 1-hour auto-stop. */
  ttlSeconds?: number | null
  /** How long to wait for the health probe before assuming the daemon isn't already up. */
  healthProbeTimeoutMs?: number
  /** How long to wait for the daemon to become healthy after starting it. */
  daemonReadyTimeoutMs?: number
  /** Delay between health-probe / box-state-poll attempts. */
  pollIntervalMs?: number
  /** How long to wait for the box itself to reach a ready state + get its subdomain assigned. */
  boxReadyTimeoutMs?: number
  /** Run `npm i -g @agentproto/cli@<cliVersion>` before installing the
   *  systemd unit. Default true. Only runs when this provider is the one
   *  starting the daemon (skipped when the health probe finds it already up). */
  updateCliOnBoot?: boolean
  /** CLI version to install on boot, pinned instead of a floating `@latest`.
   *  Produces `@agentproto/cli@<version>`; when unset, falls back to `@latest`. */
  cliVersion?: string
  /** Extra npm package specs installed globally ALONGSIDE the CLI update
   *  (single `npm i -g` invocation) — e.g. the adapter the caller intends to
   *  spawn. Ignored when `updateCliOnBoot` is false or the daemon was
   *  already up. */
  installPackages?: string[]
  /** Timeout (seconds) for the `npm i -g` update command. Default 120. */
  updateCliTimeoutSeconds?: number
  /** Extra shell commands host-executed inside the box AFTER the boot `npm i -g`
   *  and systemd unit install, and BEFORE the daemon is started. Runs on
   *  EVERY boot/connect, even when the health probe finds the daemon
   *  already up — entries must be idempotent. */
  setupCommands?: string[]
}

function readBoxConfig(spec: SandboxSpec): BoxSandboxConfig {
  const config = (spec.config ?? {}) as Record<string, unknown>
  return {
    port: typeof config.port === "number" ? config.port : undefined,
    workspace: typeof config.workspace === "string" ? config.workspace : undefined,
    ttlSeconds:
      typeof config.ttlSeconds === "number" || config.ttlSeconds === null
        ? config.ttlSeconds
        : undefined,
    healthProbeTimeoutMs:
      typeof config.healthProbeTimeoutMs === "number" ? config.healthProbeTimeoutMs : undefined,
    daemonReadyTimeoutMs:
      typeof config.daemonReadyTimeoutMs === "number" ? config.daemonReadyTimeoutMs : undefined,
    pollIntervalMs: typeof config.pollIntervalMs === "number" ? config.pollIntervalMs : undefined,
    boxReadyTimeoutMs:
      typeof config.boxReadyTimeoutMs === "number" ? config.boxReadyTimeoutMs : undefined,
    updateCliOnBoot: typeof config.updateCliOnBoot === "boolean" ? config.updateCliOnBoot : undefined,
    cliVersion: typeof config.cliVersion === "string" ? config.cliVersion : undefined,
    installPackages: Array.isArray(config.installPackages)
      ? config.installPackages.filter((p): p is string => typeof p === "string" && p.length > 0)
      : undefined,
    updateCliTimeoutSeconds:
      typeof config.updateCliTimeoutSeconds === "number" ? config.updateCliTimeoutSeconds : undefined,
    setupCommands: Array.isArray(config.setupCommands)
      ? config.setupCommands.filter((c): c is string => typeof c === "string" && c.length > 0)
      : undefined,
  }
}

/** `process.env.BOX_API_KEY` read directly, exactly like e2b reads `E2B_API_KEY`. */
function makeBoxApi(): BoxApi {
  return new BoxApi(
    new Configuration({
      basePath: process.env.BOX_API_BASE_URL ?? "https://ascii.dev/api/box/v1",
      accessToken: process.env.BOX_API_KEY,
    }),
  )
}

/** Matches ascii.dev control-plane failures known to be transient: network-level
 *  errors (DNS/connect/timeout), the box-sdk's `FetchError` wrapper (thrown
 *  when the underlying `fetch` itself rejects), and HTTP 429/5xx
 *  `ResponseError`s. Everything else — 404 not-found, other 4xx, archived/
 *  terminal-state errors — is terminal and must fail fast. */
function isTransientBoxError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const name = (err as { name?: unknown }).name
    if (name === "FetchError") return true
    if (name === "ResponseError") {
      const status = (err as { response?: { status?: unknown } }).response?.status
      return typeof status === "number" && (status === 429 || status >= 500)
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  return /could not reach the box api|operation timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|fetch failed/i.test(
    message,
  )
}

interface BoxRetryOpts {
  /** Max attempts (first try + retries). Default `BOX_RETRY_ATTEMPTS` (5). */
  attempts?: number
  /** Base delay in ms before the first retry, doubling each subsequent
   *  attempt (1s/2s/4s/8s at the default). Default `BOX_RETRY_BASE_DELAY_MS`. */
  baseDelayMs?: number
}

/**
 * Retries an ascii.dev control-plane call on transient failures, with
 * jittered exponential backoff. ascii.dev's control plane is observably
 * flaky (`could not reach the Box API at https://ascii.dev: ... operation
 * timed out`) — a first-attempt timeout on `stop`/`remove` otherwise leaves
 * a box running (billable) with nothing to retry it. `stop`/`remove`/`resume`
 * are idempotent on ascii.dev (stopping an already-stopping box, etc.), so
 * retrying them is safe; terminal errors (404, other 4xx) are NOT retried —
 * see `isTransientBoxError`.
 */
export async function withBoxRetry<T>(fn: () => Promise<T>, opts: BoxRetryOpts = {}): Promise<T> {
  const attempts = opts.attempts ?? BOX_RETRY_ATTEMPTS
  const baseDelayMs = opts.baseDelayMs ?? BOX_RETRY_BASE_DELAY_MS
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= attempts || !isTransientBoxError(err)) throw err
      const maxDelay = baseDelayMs * 2 ** (attempt - 1)
      const jitteredDelay = maxDelay === 0 ? 0 : maxDelay / 2 + Math.random() * (maxDelay / 2)
      await new Promise(resolve => setTimeout(resolve, jitteredDelay))
    }
  }
}

/** Poll `api.get` until the box reaches a ready state AND has its subdomain
 *  assigned (needed to compute its public host), or throw on a terminal bad
 *  state / timeout. */
async function waitUntilBoxReady(api: BoxApi, boxId: string, config: BoxSandboxConfig): Promise<Box> {
  const timeoutMs = config.boxReadyTimeoutMs ?? BOX_READY_TIMEOUT_MS
  const pollIntervalMs = config.pollIntervalMs ?? POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { box } = await withBoxRetry(() => api.get({ boxId }))
    if (READY_STATES.has(box.state) && box.subdomain) return box
    if (TERMINAL_BAD_STATES.has(box.state)) {
      throw new Error(
        `@agentproto/sandbox-box: box ${boxId} entered terminal state "${box.state}" while waiting to become ready.`,
      )
    }
    if (Date.now() >= deadline) {
      throw new Error(`@agentproto/sandbox-box: box ${boxId} did not become ready within ${timeoutMs}ms.`)
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
}

/** One shell command that writes the daemon's env file (0600, secrets from
 *  `opts.env`) and its systemd unit (`Restart=always`, `ExecStart` bound to
 *  this box's port/workspace/host) — prep only, does not start anything. */
function writeSystemdUnitCommand(
  host: string,
  port: number,
  workspace: string,
  env: Record<string, string>,
): string {
  const envLines = Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
  const unit = [
    "[Unit]",
    "Description=agentproto daemon",
    "After=network.target",
    "",
    "[Service]",
    `EnvironmentFile=-${ENV_FILE_PATH}`,
    `ExecStart=agentproto serve --port ${port} --bind 0.0.0.0 --workspace "${workspace}" --allow-origin https://${host}`,
    "Restart=always",
    "User=user",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\n")

  // Heredoc terminators must be alone on their own line — joining these with
  // " && " (as every other multi-step command in this provider does) would
  // land the next command on the SAME line as the previous heredoc's closing
  // delimiter. bash then never recognizes that delimiter and swallows
  // everything after it (including the next heredoc) into the first
  // heredoc's body until EOF — silently no-op'ing the systemd unit write
  // while still reporting exitCode 0. Verified live: the daemon never
  // started because `/etc/systemd/system/agentproto.service` was never
  // written. Newlines keep each heredoc's terminator on its own line;
  // `set -e` preserves fail-fast semantics across the sequence.
  return [
    "set -e",
    `sudo mkdir -p ${ENV_FILE_DIR}`,
    `sudo tee ${ENV_FILE_PATH} > /dev/null <<'AGENTPROTO_ENV'\n${envLines}\nAGENTPROTO_ENV`,
    `sudo chmod 600 ${ENV_FILE_PATH}`,
    `sudo tee ${SYSTEMD_UNIT_PATH} > /dev/null <<'AGENTPROTO_UNIT'\n${unit}\nAGENTPROTO_UNIT`,
  ].join("\n")
}

/**
 * Probe health, and — if the daemon isn't already up — update the CLI,
 * expose the port, install the systemd unit, and start it, then re-probe.
 * Shared by `boot` (a fresh box's daemon has never been installed) and
 * `connect` (a resumed box's systemd-managed daemon SHOULD already be up,
 * but is re-verified rather than assumed). Throws (after deleting the box)
 * if the daemon never comes up.
 */
async function ensureDaemonHealthy(
  api: BoxApi,
  boxId: string,
  host: string,
  port: number,
  workspace: string,
  config: BoxSandboxConfig,
  env: Record<string, string>,
): Promise<void> {
  const healthUrl = `https://${host}/health`
  const healthProbeTimeoutMs = config.healthProbeTimeoutMs ?? HEALTH_PROBE_TIMEOUT_MS
  const daemonReadyTimeoutMs = config.daemonReadyTimeoutMs ?? DAEMON_READY_TIMEOUT_MS
  const pollIntervalMs = config.pollIntervalMs ?? POLL_INTERVAL_MS

  const alreadyUp = await probeHealth(healthUrl, healthProbeTimeoutMs, pollIntervalMs)

  if (!alreadyUp) {
    if (config.updateCliOnBoot ?? true) {
      const extras = (config.installPackages ?? [])
        .map(spec => ` '${spec.replace(/'/g, "")}'`)
        .join("")
      const cli = `"@agentproto/cli@${config.cliVersion ?? "latest"}"`
      await api.command({
        boxId,
        commandRequest: {
          command: `sudo npm i -g ${cli}${extras}`,
          timeoutSeconds: config.updateCliTimeoutSeconds ?? UPDATE_CLI_TIMEOUT_SECONDS,
        },
      })
    }

    // Exposes the port at https://<subdomain>-<port>.on.ascii.dev. Re-running
    // for the same box+port returns the same URL — safe on every (re-)boot.
    // `box host` requires its own <ID> argument even when run from inside
    // that same box — verified live (`box host <port> --public` alone fails
    // with "the following required arguments were not provided: <PORT>",
    // since `<port>` alone is parsed as `<ID>`).
    await api.command({
      boxId,
      commandRequest: { command: `box host ${boxId} ${port} --public`, timeoutSeconds: 30 },
    })

    await api.command({
      boxId,
      commandRequest: { command: writeSystemdUnitCommand(host, port, workspace, env), timeoutSeconds: 30 },
    })
  }

  // Caller-declared provision hooks. Runs regardless of `alreadyUp` — a
  // caller-declared hook install must still land even when the daemon (and
  // therefore the systemd unit) was already running from a prior boot.
  for (const command of config.setupCommands ?? []) {
    await api.command({ boxId, commandRequest: { command, timeoutSeconds: 60 } })
  }

  if (alreadyUp) return

  await api.command({
    boxId,
    commandRequest: {
      command: "sudo systemctl daemon-reload && sudo systemctl enable --now agentproto",
      timeoutSeconds: 30,
    },
  })

  const ready = await probeHealth(healthUrl, daemonReadyTimeoutMs, pollIntervalMs)
  if (!ready) {
    await withBoxRetry(() => api.remove({ boxId }))
    throw new Error(
      `@agentproto/sandbox-box: agentproto daemon did not become healthy at ${healthUrl} ` +
        `within ${daemonReadyTimeoutMs}ms (box ${boxId}).`,
    )
  }
}

/** Wrap a ready box into the `BootedSandbox` shape common to `boot` and
 *  `connect`. `pause()` maps to Box's `stop` (snapshot/archive, resumable);
 *  `stop()` maps to Box's `remove` (actual deletion) — Box's own naming is
 *  the reverse of `BootedSandbox`'s. */
function toBootedSandbox(api: BoxApi, boxId: string, host: string): BootedSandbox {
  return {
    mcpUrl: `https://${host}/mcp`,
    sandboxId: boxId,
    async stop(): Promise<void> {
      await withBoxRetry(() => api.remove({ boxId }))
    },
    async pause(): Promise<void> {
      await withBoxRetry(() => api.stop({ boxId }))
    },
  }
}

/** `boxSandboxProvider.boot`/`.connect` — see module docs. */
export const boxSandboxProvider: SandboxProvider = {
  async boot(spec: SandboxSpec, opts: SandboxBootOpts): Promise<BootedSandbox> {
    const config = readBoxConfig(spec)
    const port = config.port ?? DEFAULT_PORT
    const workspace = config.workspace ?? DEFAULT_WORKSPACE
    const api = makeBoxApi()

    const created = await api.create({
      createBoxRequest: {
        ttlSeconds: config.ttlSeconds === undefined ? DEFAULT_TTL_SECONDS : config.ttlSeconds,
        env: opts.env,
      },
    })
    const boxId = created.box.id

    const box = await waitUntilBoxReady(api, boxId, config)
    if (!box.subdomain) {
      throw new Error(`@agentproto/sandbox-box: box ${boxId} has no assigned subdomain.`)
    }
    const host = `${box.subdomain}-${port}.on.ascii.dev`
    await ensureDaemonHealthy(api, boxId, host, port, workspace, config, opts.env)
    return toBootedSandbox(api, boxId, host)
  },

  async connect(boxId: string, spec: SandboxSpec, opts: SandboxBootOpts): Promise<BootedSandbox> {
    const config = readBoxConfig(spec)
    const port = config.port ?? DEFAULT_PORT
    const workspace = config.workspace ?? DEFAULT_WORKSPACE
    const api = makeBoxApi()

    // Box's no-auto-stop (the default, DEFAULT_TTL_SECONDS above) is sticky
    // across resumes, unlike e2b's timeout which resets and must be re-armed
    // here — `ResumeRequest` has no ttl field to re-arm even if it didn't.
    await withBoxRetry(() => api.resume({ boxId, resumeRequest: {} }))

    const box = await waitUntilBoxReady(api, boxId, config)
    if (!box.subdomain) {
      throw new Error(`@agentproto/sandbox-box: box ${boxId} has no assigned subdomain.`)
    }
    const host = `${box.subdomain}-${port}.on.ascii.dev`
    await ensureDaemonHealthy(api, boxId, host, port, workspace, config, opts.env)
    return toBootedSandbox(api, boxId, host)
  },
}

/** Poll `url` until it responds OK, or return false once `timeoutMs` elapses. */
async function probeHealth(url: string, timeoutMs: number, pollIntervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS) })
      if (res.ok) return true
    } catch {
      // not up yet — fall through to the deadline check
    }
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
}
