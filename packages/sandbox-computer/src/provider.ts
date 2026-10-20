/**
 * Self-hosted microVM "computer" `SandboxProvider` — talks to the computer
 * controller's HTTP API (`POST/GET /v1/computers...`) and mirrors the
 * `@agentproto/sandbox-e2b` boot flow inside a self-hosted box: ensure the
 * agentproto daemon is running on the computer (installing/updating the CLI
 * when it isn't already), expose the daemon's `/mcp` endpoint as `mcpUrl`,
 * and map the controller's lifecycle verbs onto the provider seams:
 *
 *   pause()  → POST /v1/computers/:id/suspend  (full snapshot + stop)
 *   resume   → POST /v1/computers/:id/resume   (restore; MAY rename — the
 *              controller rebuilds the computer under a NEW id, adopted
 *              transparently via an in-process alias map)
 *   stop()   → DELETE /v1/computers/:id        (rm + snapshot cleanup)
 *   connect  → GET id (404 ⇒ SandboxBoxGoneError), resume when suspended
 *   probe    → GET id (cheap liveness for `sandbox list`)
 *
 * SHARED SESSIONS: this provider declares `sharedSessions: true` —
 * descriptive metadata marking the box as advertised shareable; no runtime
 * behaviour reads the flag yet. `config.maxSessions` caps how many sessions
 * map onto one computer (default 1): it is forwarded at create so the
 * controller sizes the computer for it, and counted by the controller through
 * attach (boot, connect) and detach (pause, stop), so the cap holds across
 * processes. Against a controller without those routes the count stays
 * process-local.
 *
 * TOKENS: the controller service token travels only in the Authorization
 * header of this process's OWN calls to the controller — never in anything
 * handed back to a caller. The per-box daemon token is generated per boot,
 * written into the serve command executed IN the box (and a 0600 file
 * there, so a reconnect can read it back) and returned as
 * `BootedSandbox.token`/`authHeaders` for the host to authenticate with: in
 * `daemonRoute` mode that is the ONLY credential a caller ever sees —
 * `wrapBox` fronts the controller's daemon-proxy route with a local
 * loopback proxy (`local-daemon-proxy.ts`) that attaches the controller
 * bearer and any edge Access secret itself, so neither can end up in a
 * persisted session descriptor or a paste-ready `.mcp.json`. Neither token
 * is ever logged by this package, embedded in the create `env` payload, or
 * included in an error message (the client redacts the service token; this
 * file never puts a token into a message).
 */

import { randomUUID } from "node:crypto"
import type {
  BootedSandbox,
  SandboxBootOpts,
  SandboxExecOpts,
  SandboxExecResult,
  SandboxProbeResult,
  SandboxSpec,
  SandboxProvider,
} from "@agentproto/sandbox"
import { SandboxBoxGoneError } from "@agentproto/sandbox"
import {
  ComputerApiError,
  ComputerControllerClient,
  sanitizeExtraHeaders,
  type ComputerClientConfig,
} from "./client.js"
import { ComputerSandboxError, type ComputerSandboxErrorCode } from "./errors.js"
import { startLocalDaemonProxy, type LocalDaemonProxy } from "./local-daemon-proxy.js"
import type { ComputerStatus, PortPublish } from "@agentproto/computer-api"

/** `serve.ts`'s default port (`DEFAULT_MCP_URL` in `@agentproto/harness`). */
export const DEFAULT_PORT = 18790
const DEFAULT_WORKSPACE = "/home/user"
/** Tenant every computer is created under when config doesn't name one. */
export const DEFAULT_TENANT_ID = "agentproto"
export const DEFAULT_TEMPLATE = "agentproto-workstation"
/** Cap on one exec call: the controller accepts `timeoutSec ≤ 600`. */
const EXEC_TIMEOUT_MAX_SEC = 600
const DEFAULT_WAIT_READY_TIMEOUT_MS = 120_000
const DAEMON_READY_TIMEOUT_MS = 30_000
const UPDATE_CLI_TIMEOUT_MS = 600_000
/** Base64 chunk size for writeFile chunks: ~6668 chars stays under the
 *  controller's 8192-character argv element cap. */
const WRITE_CHUNK_BASE64 = 6668
/** readFile output cap: the controller truncates a stream at 1 MiB, so read
 *  in ~700 KB raw chunks to stay under it after base64 encoding. */
const READ_CHUNK_RAW = 700_000

/** Per-computer session bookkeeping for THIS process (sharedSessions). */
const activeSessions = new Map<string, number>()
/** Controller-side session slots this process holds, per computer. */
const controllerSlots = new Map<string, number>()
/** Holder identities this process actually took a controller slot under.
 *  Scopes detach to OUR slot: a repeated detach (or a detach after the
 *  controller already released it) is a no-op, never a decrement that hides
 *  another session's still-held slot. */
const controllerHolders = new Map<string, Set<string>>()

// ── config ─────────────────────────────────────────────────────────────

interface ComputerSandboxConfig {
  /** Controller base URL. Overrides `COMPUTER_CONTROLLER_URL`. */
  controllerUrl?: string
  /** Bearer service token (secret). Overrides `COMPUTER_CONTROLLER_TOKEN`. */
  token?: string
  /** Tenant the computers are created under (`X-Tenant-Id`). */
  tenantId?: string
  /** Controller template id. Default `agentproto-workstation`. */
  template?: string
  cpus?: number
  memoryMiB?: number
  rootDiskMiB?: number
  /** Computer TTL seconds forwarded as the controller create body's `ttl`. */
  ttlSeconds?: number
  /** Egress allowlist forwarded as the create body's `egress.allow`. Entries
   *  are `"host"`, `"host:port"` (port defaults to 443) or `{ host, port? }`.
   *  The controller denies all egress (DNS included) when this is absent. */
  egress?: Array<{ host: string; port: number }>
  /** Egress IP selection forwarded as the create body's `egressIp` when not
   *  `"shared"`: `"auto"`, `"dedicated"`, or a 1-8 char lowercase alphanumeric
   *  pool slot id. Defaults to `"shared"`. Also read from spec-level
   *  `network.egressIp`; this config wins, and two different values are an
   *  error. */
  egressIp?: string
  /** How many sessions this process may map onto one computer. Default 1. */
  maxSessions?: number
  /**
   * Stable holder identity sent on attach/detach (the controller of PR
   * agentproto/ts "feat(sandbox-computer): send a stable session holder on
   * attach and relayed requests" makes a re-attach by the same holder
   * idempotent, so a daemon restart no longer hits the 409 session limit
   * against the slot its dead predecessor still held). Falls back to the
   * `AGENTPROTO_SESSION_ID` env var when this process runs inside a spawned
   * agent session; absent means the body-less legacy attach.
   */
  sessionHolder?: string
  /** Port the agentproto daemon listens on inside the computer. Default 18790. */
  port?: number
  /** `--workspace` passed to `agentproto serve`. Default `/home/user`. */
  workspace?: string
  /**
   * Public URL template for reaching a computer's ports, containing a
   * `{port}` (and optionally `{id}`) placeholder, e.g.
   * `http://gate.internal:{port}/computers/{id}`. `{hostPort}` is the host
   * port the controller published for that guest port (create response
   * `ports`), e.g. `http://127.0.0.1:{hostPort}` through an ssh forward of
   * the published port range. Default:
   * `http://<computer-name>:<port>` — the microVM is assumed addressable by
   * its generated name from the network this process lives on. Set this when
   * computers sit behind an edge/proxy instead. Optional: in `daemonRoute`
   * mode it is not needed, and supplying both is rejected as a conflicting
   * configuration (see `daemonRoute`).
   */
  gatewayUrl?: string
  /**
   * Reach each computer's daemon THROUGH the controller instead of a
   * per-port gateway: `gatewayUrl` defaults to
   * `<controllerUrl>/v1/computers/{id}/daemon`, and the controller credential
   * and tenant travel as `X-Controller-Authorization` / `X-Tenant-Id`
   * alongside the daemon's own `Authorization`. `gatewayUrl` is not required
   * in this mode; supplying an explicit `gatewayUrl` too is rejected with a
   * clear error rather than silently picking one route. Env:
   * `COMPUTER_DAEMON_ROUTE=1`.
   */
  daemonRoute?: boolean
  /**
   * Extra headers sent on every controller call (and, in `daemonRoute` mode,
   * on every daemon call), e.g. the credentials an edge proxy in front of the
   * controller requires. Treated as secrets: never logged, redacted from
   * errors. Merged over `COMPUTER_EXTRA_HEADERS` (a JSON object) and the
   * `COMPUTER_ACCESS_CLIENT_ID` / `COMPUTER_ACCESS_CLIENT_SECRET` pair, which
   * map to `CF-Access-Client-Id` / `CF-Access-Client-Secret`.
   */
  extraHeaders?: Record<string, string>
  /** Run `npm i -g @agentproto/cli@<cliVersion>` before starting the daemon
   *  when the health probe finds it not already up. Default true. */
  updateCliOnBoot?: boolean
  /** CLI version pin for the on-boot install. Default `@latest`. */
  cliVersion?: string
  /** Extra npm specs installed globally ALONGSIDE the CLI update (single
   *  `npm i -g`) — e.g. the adapter about to be spawned. Ignored when
   *  `updateCliOnBoot` is false. */
  installPackages?: string[]
  /** Extra setup commands run (idempotent required) before the start. */
  setupCommands?: string[]
  /** How long to wait for the computer to reach `running` after create/resume. */
  waitReadyTimeoutMs?: number
  /** How long to wait for the daemon health probe after starting it. */
  daemonReadyTimeoutMs?: number
  /** Internal: headers added to `authHeaders` in `daemonRoute` mode. */
  routeHeaders?: Record<string, string>
}

function parseEgress(value: unknown): Array<{ host: string; port: number }> | undefined {
  if (!Array.isArray(value)) return undefined
  const rules: Array<{ host: string; port: number }> = []
  for (const entry of value) {
    let host: string | undefined
    let port = 443
    if (typeof entry === "string") {
      const m = /^(.+?)(?::(\d{1,5}))?$/.exec(entry.trim())
      host = m?.[1]
      if (m?.[2]) port = Number(m[2])
    } else if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>
      host = typeof e.host === "string" ? e.host.trim() : undefined
      if (typeof e.port === "number" && Number.isInteger(e.port)) port = e.port
    }
    if (host) rules.push({ host, port })
  }
  return rules.length > 0 ? rules : undefined
}

const TRUTHY = new Set(["1", "true", "on", "yes"])
const EGRESS_IP_KEYWORDS = new Set(["shared", "auto", "dedicated"])
const EGRESS_IP_SLOT_RE = /^[a-z0-9]{1,8}$/

function isEgressIp(value: string): boolean {
  return EGRESS_IP_KEYWORDS.has(value) || EGRESS_IP_SLOT_RE.test(value)
}

/** Validate an `egressIp` value from config or the spec's network block. An
 *  invalid value is rejected before any controller call. */
function readEgressIpOption(value: unknown, source: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !isEgressIp(value)) {
    throw new Error(
      `computer sandbox: invalid ${source} ${JSON.stringify(value)}; expected "shared", "auto", ` +
        `"dedicated", or a 1-8 character lowercase alphanumeric pool slot id`,
    )
  }
  return value
}

function envExtraHeaders(): Record<string, string> {
  const out: Record<string, string> = {}
  const raw = process.env.COMPUTER_EXTRA_HEADERS
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v
      }
    } catch {
      // A malformed value is ignored rather than echoed: it may hold a secret.
    }
  }
  const id = process.env.COMPUTER_ACCESS_CLIENT_ID
  const secret = process.env.COMPUTER_ACCESS_CLIENT_SECRET
  if (id && secret) {
    out["CF-Access-Client-Id"] = id
    out["CF-Access-Client-Secret"] = secret
  }
  return out
}

/** A holder id the controller will accept: 1..128 chars, single line. An
 *  overlong or control-character value is dropped (legacy attach), never
 *  forwarded: the controller would 400 the whole call. */
function validHolder(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (value.length === 0 || value.length > 128 || /[\r\n\0]/.test(value)) return undefined
  return value
}

/** Resolve the holder identity for attach/detach: explicit config wins,
 *  then the `AGENTPROTO_SESSION_ID` env var this process was spawned with
 *  (the session id of the agentproto daemon behind the provider). */
function resolveSessionHolder(config: Record<string, unknown>): string | undefined {
  return validHolder(
    typeof config.sessionHolder === "string" ? config.sessionHolder : process.env.AGENTPROTO_SESSION_ID,
  )
}

function readComputerConfig(spec: SandboxSpec): ComputerSandboxConfig {
  const config = (spec.config ?? {}) as Record<string, unknown>
  const int = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)
  const configEgressIp = readEgressIpOption(config.egressIp, "config.egressIp")
  const specEgressIp = readEgressIpOption(spec.network?.egressIp, "network.egressIp")
  // The schema defaults `network.egressIp` to "shared", so a parsed manifest
  // carries it even when the author never set it: "shared" is absent for
  // conflict resolution. Any explicit config value (including "shared") wins.
  const specSelection = specEgressIp === "shared" ? undefined : specEgressIp
  if (
    configEgressIp !== undefined &&
    configEgressIp !== "shared" &&
    specSelection !== undefined &&
    configEgressIp !== specSelection
  ) {
    throw new Error(
      `computer sandbox: conflicting egressIp values; config.egressIp is "${configEgressIp}" but ` +
        `network.egressIp is "${specSelection}". Set only one, or make them identical.`,
    )
  }
  return {
    controllerUrl: str(config.controllerUrl),
    token: str(config.token),
    tenantId: str(config.tenantId),
    template: str(config.template),
    cpus: int(config.cpus),
    memoryMiB: int(config.memoryMiB),
    rootDiskMiB: int(config.rootDiskMiB),
    ttlSeconds: int(config.ttlSeconds),
    egress: parseEgress(config.egress),
    egressIp: configEgressIp ?? specEgressIp,
    maxSessions: int(config.maxSessions),
    sessionHolder: resolveSessionHolder(config),
    port: int(config.port),
    workspace: str(config.workspace),
    gatewayUrl: str(config.gatewayUrl) ?? str(process.env.COMPUTER_GATEWAY_URL),
    daemonRoute:
      typeof config.daemonRoute === "boolean"
        ? config.daemonRoute
        : TRUTHY.has((process.env.COMPUTER_DAEMON_ROUTE ?? "").toLowerCase()),
    extraHeaders: sanitizeExtraHeaders({
      ...envExtraHeaders(),
      ...(config.extraHeaders && typeof config.extraHeaders === "object"
        ? (config.extraHeaders as Record<string, string>)
        : {}),
    }),
    updateCliOnBoot: typeof config.updateCliOnBoot === "boolean" ? config.updateCliOnBoot : undefined,
    cliVersion: str(config.cliVersion),
    installPackages: Array.isArray(config.installPackages)
      ? config.installPackages.filter((p): p is string => typeof p === "string" && p.length > 0)
      : undefined,
    setupCommands: Array.isArray(config.setupCommands)
      ? config.setupCommands.filter((c): c is string => typeof c === "string" && c.length > 0)
      : undefined,
    waitReadyTimeoutMs: int(config.waitReadyTimeoutMs),
    daemonReadyTimeoutMs: int(config.daemonReadyTimeoutMs),
  }
}

const CONTROLLER_ERROR_CODES: Record<string, ComputerSandboxErrorCode> = {
  "egress-pool-disabled": "sandbox_egress_pool_unavailable",
  "egress-pool-exhausted": "sandbox_egress_pool_exhausted",
  "egress-slot-dedicated": "sandbox_egress_slot_dedicated",
  "egress-pool-unknown": "sandbox_egress_slot_unknown",
  "host-capacity": "sandbox_capacity",
}

/** Map a controller's machine error code to the provider's typed error.
 *  Unknown errors are returned unchanged so existing handling/messages stay
 *  intact. Messages are built here from controller status/code and capacity
 *  numbers only — never from the service token (the client already redacts
 *  it from its own message). */
function mapControllerError(err: unknown): unknown {
  if (!(err instanceof ComputerApiError) || err.code === undefined) return err
  const code = CONTROLLER_ERROR_CODES[err.code]
  if (code === undefined) return err

  if (code === "sandbox_capacity") {
    // The controller's `resource` is not part of the stable contract: only
    // the two values it actually sizes ("memory" and "cpus") are usable in a
    // message; anything else is reported as unknown.
    const resource = err.resource === "memory" || err.resource === "cpus" ? err.resource : "unknown"
    const amounts =
      err.requested !== undefined || err.available !== undefined
        ? ` (requested ${err.requested ?? "unknown"}, available ${err.available ?? "unknown"})`
        : ""
    const retry =
      err.retryAfterMs !== undefined
        ? `; retry after ${Math.ceil(err.retryAfterMs / 1000)}s`
        : ""
    return new ComputerSandboxError(
      code,
      `computer sandbox: host capacity exhausted for resource "${resource}"${amounts}${retry}`,
      {
        status: err.status,
        resource: err.resource,
        requested: err.requested,
        available: err.available,
        retryAfterMs: err.retryAfterMs,
      },
    )
  }

  return new ComputerSandboxError(
    code,
    `computer sandbox: controller rejected egress selection (HTTP ${err.status}, "${err.code}")`,
    { status: err.status },
  )
}

/** Build a client from config + environment. The token comes from spec
 *  config, else `COMPUTER_CONTROLLER_TOKEN` (which the runtime's provider
 *  registry fills from the stored credential ref, exactly like e2b/Box). */
function resolveClientConfig(spec: SandboxSpec, config: ComputerSandboxConfig): ComputerClientConfig {
  const baseUrl = config.controllerUrl ?? process.env.COMPUTER_CONTROLLER_URL
  const token = config.token ?? process.env.COMPUTER_CONTROLLER_TOKEN
  if (!baseUrl) throw new Error("computer sandbox: missing controllerUrl (config or COMPUTER_CONTROLLER_URL env)")
  if (!token) throw new Error("computer sandbox: missing controller token (config or COMPUTER_CONTROLLER_TOKEN env)")
  return {
    baseUrl,
    token,
    tenantId: config.tenantId ?? process.env.COMPUTER_TENANT_ID ?? DEFAULT_TENANT_ID,
    ...(config.extraHeaders && Object.keys(config.extraHeaders).length > 0
      ? { extraHeaders: config.extraHeaders }
      : {}),
  }
}

/** In `daemonRoute` mode, point the gateway at the controller's daemon
 *  route and compute the headers every call against it must carry.
 *  `gatewayUrl` is optional here (there is nothing to configure: the route
 *  comes from `controllerUrl`). Supplying both is a contradiction — a
 *  `gatewayUrl` means a direct network path to the box, with no controller
 *  credential on daemon calls — so it is rejected instead of silently
 *  picking one. `routeHeaders` being set is `wrapBox`'s signal to put a
 *  LOCAL loopback proxy in front of that URL instead of handing the real
 *  one — with the controller credential — to the caller; see
 *  `local-daemon-proxy.ts`. Identity otherwise. */
function applyDaemonRoute(config: ComputerSandboxConfig, client: ComputerClientConfig): ComputerSandboxConfig {
  if (!config.daemonRoute) return config
  if (config.gatewayUrl) {
    throw new Error(
      'computer sandbox: config.gatewayUrl and config.daemonRoute are mutually exclusive; ' +
        'remove config.gatewayUrl (or COMPUTER_GATEWAY_URL) when daemonRoute is enabled',
    )
  }
  return {
    ...config,
    gatewayUrl: `${client.baseUrl.replace(/\/+$/, "")}/v1/computers/{id}/daemon`,
    routeHeaders: {
      ...sanitizeExtraHeaders(client.extraHeaders),
      "X-Controller-Authorization": `Bearer ${client.token}`,
      "X-Tenant-Id": client.tenantId,
      // Holder identity on every relayed request: the controller's proxy
      // attributes the activity to this holder's session slot, keeping the
      // slot's lease alive while this daemon talks. Dropped from the map
      // (no header) when no holder resolved.
      ...(config.sessionHolder !== undefined
        ? { "X-Computer-Session-Holder": config.sessionHolder }
        : {}),
    },
  }
}

// ── shell building ────────────────────────────────────────────────────
// The controller's exec endpoint takes an argv array (no shell string), with
// a per-element 8192-char cap and synchronous execution — every long-lived
// process is therefore started detached via `nohup … &` inside one bash -lc.

/** shQuote a value so a `bash -lc <script>` can interpolate it safely. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Computers run as an unprivileged user with no sudo, so a global npm install
 *  must target a user-writable prefix, and the serve script must find the CLI
 *  there (it shadows any CLI baked into the template). */
export const USER_BIN_PATH_EXPORT = `export PATH="$HOME/.local/bin:$PATH"; `

/** Log path for the in-box daemon. Computers run as uid 1000 and /var/log is
 *  root-owned, so the log must live under the user's home. */
export const DAEMON_LOG_PATH = "$HOME/.agentproto-daemon.log"
/** Records the `--allow-origin` the provider started the daemon with, so a
 *  reconnect can tell a stale origin (host port changed) from a current one. */
export const DAEMON_ORIGIN_PATH = "$HOME/.agentproto-daemon.origin"
/** The daemon's `--auth-token`, kept (0600) inside the box so a reconnect from
 *  a fresh host process can present it. It never leaves the box except in the
 *  returned `BootedSandbox.token`. */
export const DAEMON_TOKEN_PATH = "$HOME/.agentproto-daemon.token"

/** The `agentproto serve` boot script: a detached (nohup … &) daemon that
 *  outlives the synchronous exec call, logging to DAEMON_LOG_PATH so a failed
 *  boot can be diagnosed in-box. The token lives ONLY in this script. */
export function buildServeCommand(opts: {
  token: string
  port: number
  workspace: string
  allowOrigin?: string
}): string {
  const origin = opts.allowOrigin ? ` --allow-origin ${shQuote(opts.allowOrigin)}` : ""
  const marker = opts.allowOrigin ? `printf %s ${shQuote(opts.allowOrigin)} > "${DAEMON_ORIGIN_PATH}"; ` : ""
  const tokenFile = `umask 077; printf %s ${shQuote(opts.token)} > "${DAEMON_TOKEN_PATH}"; `
  return (
    USER_BIN_PATH_EXPORT +
    marker +
    tokenFile +
    `nohup agentproto serve --port ${opts.port} --bind 0.0.0.0` +
    ` --workspace ${shQuote(opts.workspace)} --auth-token ${shQuote(opts.token)}${origin}` +
    ` </dev/null > "${DAEMON_LOG_PATH}" 2>&1 & echo started`
  )
}

export function buildHealthCommand(port: number): string {
  return `curl -sf -m 4 http://127.0.0.1:${port}/health 2>/dev/null || echo __down__`
}

export function buildWaitHealthyCommand(port: number, attemptSeconds: number): string {
  return (
    `for i in $(seq 1 ${Math.max(1, attemptSeconds)}); do ` +
    `curl -sf -m 2 http://127.0.0.1:${port}/health >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`
  )
}

function inlineEnv(env: Record<string, string> | undefined): string {
  if (!env) return ""
  // Same shape gate the create payload uses (controller-validated): reject
  // malformed keys / overlong or newline-carrying values before they reach
  // the shell.
  const envKeyRe = /^[A-Z_][A-Z0-9_]{0,63}$/
  return Object.entries(env)
    .filter(([k, v]) => envKeyRe.test(k) && v.length <= 4096 && !/[\r\n\0]/.test(v))
    .map(([k, v]) => `export ${k}=${shQuote(v)};`)
    .join(" ")
}

/** Compose one `/bin/bash -lc` argv array from a script, a cwd and per-exec env. */
export function bashArgv(script: string, cwd?: string, env?: Record<string, string>): string[] {
  const cdPrefix = cwd ? `cd ${shQuote(cwd)} || exit 64; ` : ""
  const envPrefix = inlineEnv(env)
  return ["/bin/bash", "-lc", `${envPrefix}${envPrefix ? " " : ""}${cdPrefix}${script}`]
}

// ── shared-session bookkeeping ────────────────────────────────────────

/** Attach a session to `sandboxId`, honouring `maxSessions` (default 1).
 *  Returns false when the box is full — callers surface "attach to the
 *  existing session instead". */
function acquireSessionSlot(sandboxId: string, maxSessions: number): boolean {
  const held = activeSessions.get(sandboxId) ?? 0
  if (held >= maxSessions) return false
  activeSessions.set(sandboxId, held + 1)
  return true
}

function releaseSessionSlot(sandboxId: string): void {
  const held = activeSessions.get(sandboxId) ?? 0
  if (held <= 1) activeSessions.delete(sandboxId)
  else activeSessions.set(sandboxId, held - 1)
}

/** Take a controller-held session slot. A controller without the attach
 *  route (404) is tolerated: the process-local count still applies. The
 *  holder, when resolved, makes a controller that tracks holders treat the
 *  attach as idempotent for that holder (a restarted daemon re-attaches
 *  onto the slot its dead predecessor still held). */
async function attachController(
  client: ComputerControllerClient,
  id: string,
  holder: string | undefined,
): Promise<void> {
  try {
    await client.attach(id, holder !== undefined ? { holder } : {})
    if (holder !== undefined) {
      let holders = controllerHolders.get(id)
      if (!holders) {
        holders = new Set()
        controllerHolders.set(id, holders)
      }
      // A same-holder re-attach is idempotent on the controller: it answers
      // 200 without taking a second slot, so it must not count twice here.
      if (holders.has(holder)) return
      holders.add(holder)
    }
    controllerSlots.set(id, (controllerSlots.get(id) ?? 0) + 1)
  } catch (err) {
    if (err instanceof ComputerApiError && err.status === 404) return
    throw err
  }
}

/** Release one of this process's controller-side slots. Returns the sessions
 *  still attached, 0 when no slot was held, or undefined when the controller
 *  could not answer. The holder scopes the release to that holder's slot on
 *  a controller that tracks holders (an unknown holder is a no-op there). */
async function detachController(
  client: ComputerControllerClient,
  id: string,
  holder: string | undefined,
): Promise<number | undefined> {
  const held = controllerSlots.get(id) ?? 0
  if (held === 0) return 0
  const holders = controllerHolders.get(id)
  // This process no longer holds THIS holder's slot (already detached, or
  // never ours): report what we still track instead of decrementing again,
  // which would misreport another session's slot as released.
  if (holder !== undefined && !holders?.has(holder)) return held
  let remaining: number
  try {
    remaining = (await client.detach(id, holder !== undefined ? { holder } : {})).sessions ?? 0
  } catch {
    // The slot stays counted so a retried stop detaches it again.
    return undefined
  }
  if (holder !== undefined) holders?.delete(holder)
  const now = controllerSlots.get(id) ?? 0
  if (now <= 1) {
    controllerSlots.delete(id)
    controllerHolders.delete(id)
  } else {
    controllerSlots.set(id, now - 1)
  }
  return remaining
}

// ── fork identity bookkeeping ─────────────────────────────────────────
// Resume can rebuild a computer under a NEW generated name (full restore
// into a fresh unit). Map old → new within this process so probe()/exec on
// the originally-known id keep working instead of reading a phantom 404.

const idAliases = new Map<string, string>()

/**
 * Resolved controller creds per live computer id, captured from the spec
 * config at boot/connect. `probe` has no spec surface (contract takes only
 * the sandbox id), so it reuses the config the box was booted with — falling
 * back to `COMPUTER_CONTROLLER_*` env when this process never booted the
 * box (e.g. after an adapter restart).
 */
const probeClientConfigs = new Map<string, ComputerClientConfig>()

export function resolveAlias(sandboxId: string): string {
  let current = sandboxId
  const seen = new Set<string>()
  while (idAliases.has(current) && !seen.has(current)) {
    seen.add(current)
    current = idAliases.get(current) as string
  }
  return current
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** URL for reaching `port` on a computer: the gateway template with
 *  `{port}`/`{id}`/`{hostPort}` substituted, else the computer's own
 *  generated name — the default assumes the box network is addressable by
 *  name from this process's network; override with `config.gatewayUrl`.
 *  `{hostPort}` needs the controller to have published `port`. */
export function boxUrl(id: string, port: number, gatewayUrl?: string, published: readonly PortPublish[] = []): string {
  if (gatewayUrl) {
    let url = gatewayUrl.replace(/\{port\}/g, String(port)).replace(/\{id\}/g, id)
    if (url.includes("{hostPort}")) {
      const hit = published.find((p) => p.guest === port)
      if (!hit) {
        throw new Error(
          `@agentproto/sandbox-computer: gatewayUrl uses {hostPort} but the controller published no host port ` +
            `for guest port ${port} on computer "${id}" (published: ${JSON.stringify(published)})`,
        )
      }
      url = url.replace(/\{hostPort\}/g, String(hit.host))
    }
    return url
  }
  return `http://${id}:${port}`
}

/** One controller GET — `{alive:false}` on 404, otherwise the state. */
async function probeComputer(sandboxId: string, clientConfig: ComputerClientConfig): Promise<SandboxProbeResult> {
  const status = await new ComputerControllerClient(clientConfig).getComputer(sandboxId)
  return status === null ? { alive: false } : { alive: true, state: status.state }
}

// ── the provider ──────────────────────────────────────────────────────

export const computerSandboxProvider: SandboxProvider = {
  async boot(spec: SandboxSpec, opts: SandboxBootOpts): Promise<BootedSandbox> {
    const base = readComputerConfig(spec)
    const clientConfig = resolveClientConfig(spec, base)
    const config = applyDaemonRoute(base, clientConfig)
    const client = new ComputerControllerClient(clientConfig)
    let booted: BootedSandbox
    try {
      booted = await bootOnClient(client, spec, config, opts)
    } catch (err) {
      throw mapControllerError(err)
    }
    probeClientConfigs.set(booted.sandboxId, clientConfig)
    return booted
  },

  async connect(sandboxId: string, spec: SandboxSpec, opts: SandboxBootOpts): Promise<BootedSandbox> {
    const base = readComputerConfig(spec)
    const clientConfig = resolveClientConfig(spec, base)
    const config = applyDaemonRoute(base, clientConfig)
    const client = new ComputerControllerClient(clientConfig)
    let booted: BootedSandbox
    try {
      booted = await connectOnClient(client, sandboxId, spec, config, opts)
    } catch (err) {
      throw mapControllerError(err)
    }
    probeClientConfigs.set(booted.sandboxId, clientConfig)
    return booted
  },

  /** Open a running box for a one-shot exec. Unlike `connect()`, this takes
   *  no session slot and never probes, restarts or re-tokens the in-box
   *  daemon, so it is safe while a session holds the box. */
  async connectForExec(sandboxId: string, spec: SandboxSpec, _opts: SandboxBootOpts): Promise<BootedSandbox> {
    const base = readComputerConfig(spec)
    const clientConfig = resolveClientConfig(spec, base)
    const config = applyDaemonRoute(base, clientConfig)
    const client = new ComputerControllerClient(clientConfig)
    let booted: BootedSandbox
    try {
      booted = await connectForExecOnClient(client, sandboxId, config)
    } catch (err) {
      throw mapControllerError(err)
    }
    probeClientConfigs.set(booted.sandboxId, clientConfig)
    return booted
  },

  /** Liveness against the controller — one cheap GET, no box contact.
   *  404 ⇒ `{alive:false}`; anything else propagates ("check failed",
   *  never "box died"). Uses the spec config captured at boot/connect,
   *  falling back to the `COMPUTER_CONTROLLER_*` env vars. */
  async probe(sandboxId: string): Promise<SandboxProbeResult> {
    const fallbackConfig = () =>
      resolveClientConfig(
        { provider: "computer", config: { controllerUrl: process.env.COMPUTER_CONTROLLER_URL } },
        readComputerConfig({ provider: "computer", config: {} }),
      )
    // Probe the raw id first (its creds captured at boot/connect); when that
    // id is gone behind a resume-rename alias, chase the alias once.
    const first = await probeComputer(sandboxId, probeClientConfigs.get(sandboxId) ?? fallbackConfig())
    if (first.alive) return first
    const aliased = resolveAlias(sandboxId)
    if (aliased === sandboxId) return first
    return probeComputer(aliased, probeClientConfigs.get(aliased) ?? fallbackConfig())
  },
}

async function bootOnClient(
  client: ComputerControllerClient,
  spec: SandboxSpec,
  config: ComputerSandboxConfig,
  opts: SandboxBootOpts,
): Promise<BootedSandbox> {
  const port = config.port ?? DEFAULT_PORT
  const workspace = config.workspace ?? DEFAULT_WORKSPACE

  // Only controller-shapable env vars are forwarded into the create payload
  // (the controller 400s on anything else). Neither the controller token nor
  // the per-box daemon token ever appears in here.
  const envKeyRe = /^[A-Z_][A-Z0-9_]{0,63}$/
  const createEnv: Record<string, string> = {}
  for (const [k, raw] of Object.entries(opts.env ?? {})) {
    const v = typeof raw === "string" ? raw : undefined
    if (v !== undefined && envKeyRe.test(k) && v.length <= 4096 && !/[\r\n\0]/.test(v)) createEnv[k] = v
  }

  let created
  try {
    created = await client.createComputer({
      template: config.template ?? DEFAULT_TEMPLATE,
      tenantId: resolveClientConfig(spec, config).tenantId,
      ...(config.cpus !== undefined ? { cpus: config.cpus } : {}),
      ...(config.memoryMiB !== undefined ? { memoryMiB: config.memoryMiB } : {}),
      ...(config.rootDiskMiB !== undefined ? { rootDiskMiB: config.rootDiskMiB } : {}),
      ...(config.ttlSeconds !== undefined ? { ttl: config.ttlSeconds } : {}),
      ...(config.maxSessions !== undefined ? { maxSessions: config.maxSessions } : {}),
      ...(config.egress ? { egress: { allow: config.egress } } : {}),
      ...(config.egressIp !== undefined && config.egressIp !== "shared" ? { egressIp: config.egressIp } : {}),
      env: createEnv,
    })
  } catch (err) {
    if (err instanceof ComputerApiError) {
      const mapped = mapControllerError(err)
      if (mapped !== err) throw mapped
      throw new Error(
        `computer sandbox: create rejected (HTTP ${err.status}${err.code ? `, "${err.code}"` : ""})` +
          (err.code === "unknown template" || err.code === "invalid body"
            ? ` — check that config.template (default "${DEFAULT_TEMPLATE}") is registered on this controller; see the README's config.template note`
            : ""),
      )
    }
    throw err
  }
  const sandboxId = created.id
  let daemonToken: string | undefined
  let published: readonly PortPublish[] = []
  let status: ComputerStatus

  try {
    status = await waitRunning(client, sandboxId, config.waitReadyTimeoutMs ?? DEFAULT_WAIT_READY_TIMEOUT_MS)
    published = created.ports?.length ? created.ports : (status.ports ?? [])
    const mcpOrigin = new URL(boxUrl(sandboxId, port, config.gatewayUrl, published)).origin
    daemonToken = await daemonHealthyOrThrow(client, sandboxId, config, randomUUID(), port, workspace, mcpOrigin)
    await attachController(client, sandboxId, config.sessionHolder)
  } catch (err) {
    // A failed boot must never leak a computer (same never-leak contract as
    // sandbox-e2b): propagate the original error but reclaim the box. The
    // box was created here and no session has attached to it, so force is
    // safe and keeps a stray controller-held slot from blocking the cleanup.
    await client.remove(sandboxId, { force: true }).catch(() => undefined)
    throw err
  }

  const egressIp = created.egressIp !== undefined ? created.egressIp : status.egressIp

  acquireSessionSlot(sandboxId, config.maxSessions ?? 1)
  return wrapBox(client, sandboxId, spec, config, port, published, daemonToken, egressIp)
}

/** Resolve an existing computer to a running id (resuming when suspended and
 *  following a resume-rename alias) plus its published ports and egress IP. */
async function resolveRunningComputer(
  client: ComputerControllerClient,
  sandboxId: string,
  config: ComputerSandboxConfig,
): Promise<{ currentId: string; published: readonly PortPublish[]; egressIp: { id: string; publicIp: string } | null | undefined }> {
  const port = config.port ?? DEFAULT_PORT
  const status = await client.getComputer(sandboxId)
  if (status === null) throw new SandboxBoxGoneError(sandboxId)

  // A suspended/stopped computer is resumed first. The controller may
  // rebuild it under a NEW id — adopt it, remember the alias.
  let currentId = sandboxId
  let published: readonly PortPublish[] = status.ports ?? []
  let egressIp = status.egressIp
  if (status.state !== "running") {
    const resumeResult = await client.resume(sandboxId)
    const targetId = resumeResult.id ?? sandboxId
    if (targetId !== sandboxId) idAliases.set(sandboxId, targetId)
    currentId = targetId
    const running = await waitRunning(client, currentId, config.waitReadyTimeoutMs ?? DEFAULT_WAIT_READY_TIMEOUT_MS)
    published = running.ports ?? []
    if (running.egressIp !== undefined) egressIp = running.egressIp
  }
  if (config.gatewayUrl?.includes("{hostPort}") && !published.some((p) => p.guest === port)) {
    published = await recoverPublishedPort(client, currentId, port, published)
  }
  return { currentId, published, egressIp }
}

async function connectOnClient(
  client: ComputerControllerClient,
  sandboxId: string,
  spec: SandboxSpec,
  config: ComputerSandboxConfig,
  opts: SandboxBootOpts,
): Promise<BootedSandbox> {
  const port = config.port ?? DEFAULT_PORT
  const workspace = config.workspace ?? DEFAULT_WORKSPACE

  const { currentId, published, egressIp } = await resolveRunningComputer(client, sandboxId, config)

  // A restored computer keeps its disk but its daemon may be gone: same
  // ensure-healthy dance as a fresh boot (skips the install when up).
  const mcpOrigin = new URL(boxUrl(currentId, port, config.gatewayUrl, published)).origin
  const daemonToken = await daemonHealthyOrThrow(client, currentId, config, randomUUID(), port, workspace, mcpOrigin)

  const maxSessions = config.maxSessions ?? 1
  if (!acquireSessionSlot(currentId, maxSessions)) {
    throw new Error(
      `computer "${currentId}" already hosts the maximum number of sessions this process tracks ` +
        `(${maxSessions}); attach to the existing session instead of opening a new one`,
    )
  }
  try {
    await attachController(client, currentId, config.sessionHolder)
  } catch (err) {
    releaseSessionSlot(currentId)
    if (err instanceof ComputerApiError && err.status === 409) {
      throw new Error(
        `computer "${currentId}" already hosts the maximum number of sessions the controller allows; ` +
          "attach to the existing session instead of opening a new one",
      )
    }
    throw err
  }
  return wrapBox(client, currentId, spec, config, port, published, daemonToken, egressIp)
}

/** Exec-only attach: same running-box resolution as `connect()`, then a
 *  handle that shells in directly. No session slot, no daemon probe, no
 *  token read, no attach request. */
async function connectForExecOnClient(
  client: ComputerControllerClient,
  sandboxId: string,
  config: ComputerSandboxConfig,
): Promise<BootedSandbox> {
  const port = config.port ?? DEFAULT_PORT
  const { currentId, published, egressIp } = await resolveRunningComputer(client, sandboxId, config)
  const mcpUrl = `${boxUrl(currentId, port, config.gatewayUrl, published).replace(/\/+$/, "")}/mcp`
  return {
    mcpUrl,
    sandboxId: currentId,
    ...(egressIp !== undefined ? { egressIp } : {}),
    ...boxIo(client, currentId),
    async stop(): Promise<void> {
      throw new Error(
        `computer "${currentId}": an exec-only handle does not own the box; use connect() to manage its lifecycle`,
      )
    },
  }
}

/** The controller's GET may omit `ports` (the create response is the only
 *  place some deployments report them). The daemon this provider started
 *  recorded its `--allow-origin`, which for a `{hostPort}` gateway carries the
 *  host port: read it back so a reconnect from a fresh process still resolves
 *  the same URL. Returns `published` unchanged when nothing can be recovered. */
async function recoverPublishedPort(
  client: ComputerControllerClient,
  id: string,
  port: number,
  published: readonly PortPublish[],
): Promise<readonly PortPublish[]> {
  const recorded = await hardExec(client, id, bashArgv(`cat "${DAEMON_ORIGIN_PATH}" 2>/dev/null`), 10)
  if (recorded.exitCode !== 0) return published
  try {
    const hostPort = Number(new URL(recorded.stdout.trim()).port)
    return Number.isInteger(hostPort) && hostPort > 0 ? [...published, { host: hostPort, guest: port }] : published
  } catch {
    return published
  }
}

/** Poll until the computer reports `running`, or throw with the last state. */
async function waitRunning(
  client: ComputerControllerClient,
  id: string,
  timeoutMs: number,
): Promise<ComputerStatus> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await client.getComputer(id)
    if (status === null) throw new SandboxBoxGoneError(id)
    if (status.state === "running") return status
    if (Date.now() >= deadline) {
      throw new Error(`computer "${id}" did not reach running within ${timeoutMs}ms (last state: ${status.state})`)
    }
    await sleep(500)
  }
}

/** Probe the daemon in-box (loopback works regardless of outside routing);
 *  when it's down, run the CLI install + start + re-probe-and-wait. */
async function daemonHealthyOrThrow(
  client: ComputerControllerClient,
  id: string,
  config: ComputerSandboxConfig,
  daemonToken: string,
  port: number,
  workspace: string,
  mcpOrigin: string,
): Promise<string | undefined> {
  const probe = await hardExec(client, id, bashArgv(buildHealthCommand(port)), 10)
  const alreadyUp = probe.exitCode === 0 && !probe.stdout.includes("__down__")
  if (alreadyUp) {
    // The daemon only accepts the --allow-origin it was started with; with a
    // {hostPort} gatewayUrl the origin changes when the controller republishes
    // the port, so restart it when the recorded origin is stale. No marker
    // (a template-autostarted daemon) means the origin is unknown: leave it.
    const recorded = await hardExec(client, id, bashArgv(`cat "${DAEMON_ORIGIN_PATH}" 2>/dev/null`), 10)
    const current = recorded.exitCode === 0 ? recorded.stdout.trim() : ""
    if (current !== "" && current !== mcpOrigin) {
      await hardExec(client, id, bashArgv(`pkill -f '[a]gentproto serve' || true`), 10)
      await startDaemonAndWait(client, id, config, daemonToken, port, workspace, mcpOrigin)
      return daemonToken
    }
    // The running daemon keeps the token it was started with: read it back.
    const stored = await hardExec(client, id, bashArgv(`cat "${DAEMON_TOKEN_PATH}" 2>/dev/null`), 10)
    return stored.exitCode === 0 && stored.stdout.trim() !== "" ? stored.stdout.trim() : undefined
  }

  if (config.updateCliOnBoot !== false && !(await cliAlreadyPresent(client, id, config))) {
    const extras = (config.installPackages ?? []).map((p) => ` ${shQuote(p)}`).join("")
    const install = await hardExec(
      client,
      id,
      bashArgv(
        `${USER_BIN_PATH_EXPORT}npm i -g --prefix "$HOME/.local" @agentproto/cli@${shQuote(config.cliVersion ?? "latest")}${extras}`,
      ),
      Math.min(EXEC_TIMEOUT_MAX_SEC, Math.ceil(UPDATE_CLI_TIMEOUT_MS / 1000)),
    )
    if (install.exitCode !== 0) throw bootStepError("CLI install", id, install)
  }
  for (const command of config.setupCommands ?? []) {
    const setup = await hardExec(client, id, bashArgv(command), EXEC_TIMEOUT_MAX_SEC)
    if (setup.exitCode !== 0) throw bootStepError("setup command", id, setup)
  }

  await startDaemonAndWait(client, id, config, daemonToken, port, workspace, mcpOrigin)
  return daemonToken
}

async function startDaemonAndWait(
  client: ComputerControllerClient,
  id: string,
  config: ComputerSandboxConfig,
  daemonToken: string,
  port: number,
  workspace: string,
  mcpOrigin: string,
): Promise<void> {
  await hardExec(
    client,
    id,
    bashArgv(buildServeCommand({ token: daemonToken, port, workspace, allowOrigin: mcpOrigin })),
    15,
  )

  const readyMs = config.daemonReadyTimeoutMs ?? DAEMON_READY_TIMEOUT_MS
  const waitSeconds = Math.ceil(readyMs / 1000)
  const waited = await hardExec(
    client,
    id,
    bashArgv(buildWaitHealthyCommand(port, waitSeconds)),
    waitSeconds + 20,
  )
  if (waited.exitCode !== 0) {
    throw new Error(
      `@agentproto/sandbox-computer: agentproto daemon did not become healthy on computer "${id}" ` +
        `within ${waitSeconds}s (see ~/.agentproto-daemon.log in the box)`,
    )
  }
}

/** True when the computer image already carries an `agentproto` CLI that
 *  satisfies the config: the install is then pure boot latency. An extra
 *  `installPackages` list or a pinned `cliVersion` the baked CLI does not
 *  match still forces the install. */
async function cliAlreadyPresent(
  client: ComputerControllerClient,
  id: string,
  config: ComputerSandboxConfig,
): Promise<boolean> {
  if ((config.installPackages ?? []).length > 0) return false
  const probe = await hardExec(client, id, bashArgv(`${USER_BIN_PATH_EXPORT}agentproto --version`), 20)
  if (probe.exitCode !== 0) return false
  const pin = config.cliVersion
  if (!pin || pin === "latest") return true
  const want = semverCore(pin)
  const have = semverCore(probe.stdout)
  return want !== null && want === have
}

/** `major.minor.patch[-prerelease]` of the first version-looking token,
 *  ignoring a leading `v`/range operator and build metadata. A partial pin
 *  such as "1.2" yields null, so it never matches `1.26.0`. */
function semverCore(text: string): string | null {
  const match = /(?:^|[^0-9.])(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?(?![.\d])/.exec(text)
  return match ? (match[1] as string) + (match[2] ?? "") : null
}

function bootStepError(
  step: string,
  id: string,
  result: { exitCode: number; stdout: string; stderr: string },
): Error {
  const tail = (result.stderr.trim() || result.stdout.trim()).slice(-400)
  return new Error(
    `@agentproto/sandbox-computer: ${step} failed on computer "${id}" (exit ${result.exitCode})` +
      (tail ? `: ${tail}` : ""),
  )
}

/** Exec clamped into the controller's `timeoutSec ≤ 600` window. */
async function hardExec(
  client: ComputerControllerClient,
  id: string,
  argv: string[],
  timeoutSec: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return client.exec(id, argv, { timeoutSec: Math.max(1, Math.min(EXEC_TIMEOUT_MAX_SEC, Math.ceil(timeoutSec))) })
}

// ── handle wrapping ───────────────────────────────────────────────────

async function wrapBox(
  client: ComputerControllerClient,
  id: string,
  spec: SandboxSpec,
  config: ComputerSandboxConfig,
  port: number,
  published: readonly PortPublish[],
  daemonToken?: string,
  egressIp?: { id: string; publicIp: string } | null,
): Promise<BootedSandbox> {
  // `routeHeaders` is only set in daemonRoute mode — see
  // `applyDaemonRoute`. The controller's daemon-proxy route reaches exactly
  // one guest port (the daemon's), so any other port is simply unreachable
  // through it: reject rather than hand back a URL that silently points at
  // the wrong place.
  const trueRouteMode = config.routeHeaders !== undefined
  if (trueRouteMode && (spec.extraPorts ?? []).length > 0) {
    throw new Error(
      `computer "${id}": daemonRoute mode can only reach the daemon's own port (the controller's ` +
        `daemon-proxy route proxies guest port ${port} only) — extraPorts are not reachable this way. ` +
        "Disable daemonRoute and set an explicit config.gatewayUrl with a {port} placeholder instead.",
    )
  }
  const extraPorts: Record<number, string> = {}
  if (!trueRouteMode) {
    for (const extra of spec.extraPorts ?? []) {
      extraPorts[extra] = boxUrl(id, extra, config.gatewayUrl, published)
    }
  }

  // In true daemonRoute mode, a LOCAL loopback proxy stands in for the real
  // controller URL: it is the one place `routeHeaders` (the tenant-wide
  // controller bearer, and any edge Access secret) gets attached, so
  // `mcpUrl`/`authHeaders` below — which a caller may persist into a
  // session descriptor or a paste-ready `.mcp.json` — only ever carry the
  // box's own per-box daemon token. See `local-daemon-proxy.ts`.
  let localProxy: LocalDaemonProxy | undefined
  let mcpUrl: string
  if (trueRouteMode) {
    const remoteDaemonUrl = boxUrl(id, port, config.gatewayUrl, published)
    localProxy = await startLocalDaemonProxy(remoteDaemonUrl, config.routeHeaders as Record<string, string>)
    mcpUrl = `${localProxy.url}/mcp`
  } else {
    mcpUrl = `${boxUrl(id, port, config.gatewayUrl, published).replace(/\/+$/, "")}/mcp`
  }
  const closeProxy = (): void => localProxy?.close()

  return {
    mcpUrl,
    sandboxId: id,
    ...(egressIp !== undefined ? { egressIp } : {}),
    // The daemon is gated by its per-box `--auth-token` regardless of
    // `opts.expose` (the controller's port publish, or the daemon-proxy
    // route, is never a loopback hop inside the guest, so an open daemon
    // would answer `tunnel_unauthorized`). The host presents it via
    // `authHeaders`; a reconnect reads it back from the box. Absent only for
    // a template-autostarted daemon that was never given one — in which
    // case there is nothing for a caller to present either.
    ...(daemonToken ? { token: daemonToken, authHeaders: { Authorization: `Bearer ${daemonToken}` } } : {}),
    ...(Object.keys(extraPorts).length > 0 ? { ports: extraPorts } : {}),
    expose(exposePort: number): Promise<{ url: string }> {
      if (trueRouteMode) {
        return Promise.reject(
          new Error(
            `computer "${id}": daemonRoute mode cannot expose arbitrary ports (only the daemon's own ` +
              "port is reachable through the controller's daemon-proxy route). Disable daemonRoute " +
              "and set an explicit config.gatewayUrl to expose ports.",
          ),
        )
      }
      return Promise.resolve({ url: boxUrl(id, exposePort, config.gatewayUrl, published) })
    },
    async stop(): Promise<void> {
      closeProxy()
      releaseSessionSlot(id)
      const remaining = await detachController(client, id, config.sessionHolder)
      // Other sessions still attached keep the computer; the last one out
      // removes it.
      if (remaining !== undefined && remaining > 0) return
      // An unanswered detach leaves the count unknown: keep the computer
      // (another session may still use it) and report it; a retried stop
      // removes it once the controller answers, and its TTL reclaims it
      // otherwise.
      if (remaining === undefined) {
        throw new Error(`computer ${id}: could not release the controller session slot, computer left in place`)
      }
      await client.remove(id)
      // Free the per-process bookkeeping: session slot (done above), any
      // alias pointing at this id, and the probe config captured at
      // boot/connect — the box is gone, nothing should route here anymore.
      for (const [from, to] of idAliases) {
        if (to === id) idAliases.delete(from)
      }
      idAliases.delete(id)
      activeSessions.delete(id)
      controllerHolders.delete(id)
      probeClientConfigs.delete(id)
    },
    async pause(): Promise<void> {
      closeProxy()
      releaseSessionSlot(id)
      await detachController(client, id, config.sessionHolder)
      await client.suspend(id)
    },
    /** Release this session's controller slot without stopping or suspending
     *  the computer — the survivor half of a shared-box teardown. The box
     *  keeps running for the sessions still attached. Idempotent: once this
     *  process's slot count reaches zero no further detach is sent. */
    async detach(): Promise<void> {
      closeProxy()
      releaseSessionSlot(id)
      await detachController(client, id, config.sessionHolder)
    },
    async extendTimeout(): Promise<void> {
      // The controller sets a computer TTL at create time and has no
      // extend-timeout endpoint — nothing to renew. Kept as a no-op so a
      // host that re-arms on detach/activity still succeeds.
    },
    ...boxIo(client, id),
  }
}

/** In-box command/file I/O shared by session-owning and exec-only handles. */
function boxIo(
  client: ComputerControllerClient,
  id: string,
): Pick<BootedSandbox, "exec" | "readFile" | "writeFile"> {
  return {
    async exec(execOpts: SandboxExecOpts): Promise<SandboxExecResult> {
      const startedAt = Date.now()
      const timeoutSec = Math.max(
        1,
        Math.min(EXEC_TIMEOUT_MAX_SEC, Math.ceil((execOpts.timeoutMs ?? 120_000) / 1000)),
      )
      const result = await hardExec(client, id, bashArgv(execOpts.command, execOpts.cwd, execOpts.env), timeoutSec)
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - startedAt,
      }
    },
    async readFile(path: string): Promise<Uint8Array> {
      const exists = await hardExec(
        client,
        id,
        bashArgv(`test -f ${shQuote(path)} && exit 0 || exit 65`),
        15,
      )
      if (exists.exitCode !== 0) throw new Error(`computer "${id}": no file at ${JSON.stringify(path)}`)
      const chunks: Uint8Array[] = []
      for (let offset = 0; ; offset += READ_CHUNK_RAW) {
        const out = await hardExec(
          client,
          id,
          bashArgv(
            `dd if=${shQuote(path)} bs=${READ_CHUNK_RAW} skip=${offset / READ_CHUNK_RAW} 2>/dev/null | base64; exit 0`,
          ),
          60,
        )
        if (out.exitCode !== 0) {
          throw new Error(`computer "${id}": cannot read ${JSON.stringify(path)} (exit ${out.exitCode})`)
        }
        const decoded = Buffer.from(out.stdout.trim(), "base64")
        if (decoded.length === 0) break
        chunks.push(new Uint8Array(decoded))
        if (decoded.length < READ_CHUNK_RAW) break
      }
      const total = chunks.reduce((n, c) => n + c.length, 0)
      const merged = new Uint8Array(total)
      let cursor = 0
      for (const chunk of chunks) {
        merged.set(chunk, cursor)
        cursor += chunk.length
      }
      return merged
    },
    async writeFile(path: string, data: Uint8Array): Promise<void> {
      const dir = path.replace(/\/[^/]*$/, "") || "/"
      await hardExec(client, id, bashArgv(`mkdir -p ${shQuote(dir)}`), 15)
      const b64 = Buffer.from(data).toString("base64")
      if (b64.length > 0) {
        await hardExec(client, id, bashArgv(`: > ${shQuote(path)}; exit 0`), 15)
      }
      for (let offset = 0; offset < b64.length; offset += WRITE_CHUNK_BASE64) {
        const chunk = b64.slice(offset, offset + WRITE_CHUNK_BASE64)
        const result = await hardExec(
          client,
          id,
          bashArgv(`printf %s ${shQuote(chunk)} | base64 -d >> ${shQuote(path)} && exit 0 || exit 65`),
          30,
        )
        if (result.exitCode !== 0) {
          throw new Error(`computer "${id}": cannot write ${JSON.stringify(path)} (exit ${result.exitCode})`)
        }
      }
    },
  }
}
