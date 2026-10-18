/**
 * InstaBox `SandboxProvider` (https://instabox.sh, API
 * https://api.instabox.sh) for @agentproto/sandbox — boots an InstaBox VM,
 * publishes the agentproto daemon behind the account's public edge, and hands
 * its `/mcp` endpoint to `createSandboxAgentSessionHost` the same way
 * `@agentproto/sandbox-box` (ascii.dev Box) does.
 *
 * Shape notes measured live on 2026-10-18 (see `api.ts` for the API itself):
 *
 * - Synchronous `exec` API (`POST /machines/{id}/exec`): a non-zero exit is a
 *   normal 200 RESULT (not an error); a command that runs past its
 *   `timeoutSeconds` answers with `exitCode: 124, timedOut: true`; each
 *   stream is capped at 1 MiB (`truncated: true`). There is NO upload route
 *   (PUT/POST on `/files` 404), so `writeFile`/`readFile` go through `exec`:
 *   write = `mkdir -p` + base64 on STDIN to `base64 -d > file` in chunks of at
 *   most 700 KB; read = `dd` slice + `base64 -w0` in chunks small enough that
 *   each stdout stays under the API's 1 MiB capture cap.
 * - A published port's edge (`https://{port}-{machineIdWithoutM_}.instabox.tech`,
 *   stable per machine+port) is PUBLIC with NO InstaBox-side authentication,
 *   so the daemon MUST be started with an auth token: the unit's ExecStart
 *   carries `--auth-token`, whose value is ONLY substituted by systemd from
 *   the EnvironmentFile (`AGENTPROTO_AUTH_TOKEN`), so the token never lands in
 *   an exec command's argv; secrets ride the heredoc body (exec stdin) into a
 *   root-owned 0600 EnvironmentFile.
 * - Backgrounded in-VM processes MUST redirect their stdio: a bare `cmd &`
 *   keeps the synchronous exec open until its timeout. The provider never
 *   backgrounds anything itself: the daemon runs as a systemd unit
 *   (`Restart=always`), which survives `kill -9`, suspend/resume and
 *   auto-suspend (proven live).
 * - A MANUALLY suspended machine does NOT wake on its own: its public URL
 *   503s, its exec and `wake` answer 409. This provider therefore NEVER sends
 *   the suspend verb and deliberately does NOT implement `pause()` (omitting
 *   it lets callers fall back to `stop()`, which deletes the box). Instead it
 *   leaves `autoSuspendAfterSeconds` at 0 by default (configurable):
 *   auto-suspended machines DO wake on a public request, on `wake` and on
 *   `exec`.
 */

import { randomBytes } from "node:crypto"
import type {
  BootedSandbox,
  SandboxBootOpts,
  SandboxExecOpts,
  SandboxExecResult,
  SandboxProbeResult,
  SandboxProvider,
  SandboxSpec,
} from "@agentproto/sandbox"
import { SandboxBoxGoneError, SandboxQuotaError, scrubCommandFromMessage } from "@agentproto/sandbox"
import {
  InstaboxApiError,
  InstaboxClient,
  isInstaboxQuotaFailure,
  type InstaboxExecResult as InstaboxExecResultApi,
  type InstaboxMachine,
} from "./api.js"

/** `serve.ts`'s default port (`DEFAULT_MCP_URL` in `@agentproto/harness`). */
const DEFAULT_PORT = 18790
/** InstaBox's Debian 13 image boots with user home under /data (`HOME` is
 *  `/data/home`; `/data` itself is root-owned, so the daemon workspace is
 *  written under HOME). */
const DEFAULT_WORKSPACE = "/data/home"
/** Default template: `universal` (Debian 13, git, gh, Node 22, Python, Go,
 *  Rust, Docker, Claude Code, Codex; one fixed 4 vCPU / 8 GB / 20 GB shape,
 *  passwordless sudo). */
const DEFAULT_TEMPLATE = "universal"
/**
 * Default box lifetime, seconds. InstaBox restarts the countdown from NOW on
 * every PATCH `timeoutSeconds` (`extendTimeout`), the same re-arm contract as
 * e2b's `setTimeout` (see `@agentproto/sandbox-e2b`'s DEFAULT_SANDBOX_TIMEOUT_MS
 * for why a 1h default is survivable only with re-arms).
 */
const DEFAULT_TIMEOUT_SECONDS = 3600
/** Clamp range for machine `timeoutSeconds` (create and extend re-arms). */
const MIN_TIMEOUT_SECONDS = 60
const MAX_TIMEOUT_SECONDS = 86400
/** Default auto-suspend window: 0 disables (a daemon that must stay reachable
 *  over its public edge must not auto-sleep). */
const DEFAULT_AUTO_SUSPEND_AFTER_SECONDS = 0
const HEALTH_PROBE_TIMEOUT_MS = 5_000
/** Pre-install probe window (the daemon can only be there by luck; keep the
 *  "already up?" check short so a fresh boot does not stall on it). */
const ALREADY_UP_PROBE_TIMEOUT_MS = 2_000
const POLL_INTERVAL_MS = 500
/** Overall wait for a fresh/starting machine to reach `runtime.ready`. */
const READY_TIMEOUT_MS = 120_000
/** Overall wait for the freshly-started daemon to answer /health. The
 *  InstaBox edge 502s a connection with no bytes for 20s, so the probe
 *  cadence stays well under that. */
const DAEMON_READY_TIMEOUT_MS = 60_000
/** Per-command exec clamp range (seconds), measured API contract 1..600. */
const EXEC_MAX_TIMEOUT_SECONDS = 600
/** Default per-call exec timeout when the caller gives none: the API's own
 *  60s default is the same mid-work-kill trap e2b's 5-minute box default
 *  was (a busy `pnpm test` legitimately runs past a minute). */
const EXEC_DEFAULT_TIMEOUT_SECONDS = 600
/** Default exec timeout (seconds) for the boot `npm i -g @agentproto/cli`. */
const DEFAULT_UPDATE_CLI_TIMEOUT_SECONDS = 600
/** Chunk size for file transfer through exec: 700 KB stays under the API's
 *  1 MiB stdin and stdout caps after base64 inflation (700 KB -> ~933 KB). */
const FILE_CHUNK_BYTES = 700 * 1024
/** B64 chars of one max chunk (4/3 rounding up to a multiple of 4, so every
 *  slice boundary decodes AND a shorter answer means EOF was reached). */
const FILE_CHUNK_B64_CHARS = Math.ceil(FILE_CHUNK_BYTES / 3) * 4
/** Length (bytes) of the generated daemon bearer token. */
const AUTH_TOKEN_BYTES = 32
const PROVIDER_SLUG = "instabox"

const ENV_FILE_DIR = "/etc/agentproto"
export const ENV_FILE_PATH = `${ENV_FILE_DIR}/agentproto.env`
export const SYSTEMD_UNIT_PATH = "/etc/systemd/system/agentproto.service"
/** Unit name of the systemd service wrapping the daemon. */
export const DAEMON_UNIT_NAME = "agentproto"
/** Env var the EnvironmentFile sets for the unit's `--auth-token` value. */
export const AUTH_TOKEN_ENV_VAR = "AGENTPROTO_AUTH_TOKEN"
/** Machine metadata stamp: which machines this provider owns (`agentproto: "1"`). */
export const AGENTPROTO_METADATA_KEY = "agentproto"
const AGENTPROTO_METADATA_VALUE = "1"

/** Suffix that MANDATORY redirection takes on any in-box background
 *  invocation (a background `cmd &` without it keeps the synchronous exec
 *  open until its timeout). Exported so tests can assert every provider-built
 *  command that backgrounds something carries it. */
export const BACKGROUND_REDIRECT = ">/dev/null 2>&1 </dev/null"

export interface InstaboxSandboxSpecConfig {
  /** InstaBox API key (`ibk_...`). Falls back to `INSTABOX_API_KEY` in the
   *  host process env. Sent only as the `X-API-Key` header (never logged,
   *  never part of an error message). */
  apiKey?: string
  /** Default `https://api.instabox.sh`. */
  apiUrl?: string
  /** Template id. Default `universal`. (A `snapshotId` would win on the API,
   *  but this provider always boots from a template.) */
  template?: string
  /** Machine lifetime in seconds, re-armed from now on every extend.
   *  Default 3600, clamp 60..86400. */
  timeoutSeconds?: number
  /** This provider only ever sends `kill`: `pause` would leave a manually
   *  suspended box stranded (it does not wake on its own). */
  onTimeout?: "kill"
  /** 0 disables auto-suspend (default); 120..86400 arms it. */
  autoSuspendAfterSeconds?: number
  /** Port the agentproto daemon listens on inside the box. Default 18790. */
  port?: number
  /** `--workspace` passed to `agentproto serve`. Default `/data/home`. */
  workspace?: string
  /** CLI version pinned on boot, instead of a floating `@latest`.
   *  Produces `@agentproto/cli@<version>`. */
  cliVersion?: string
  /** Run `npm i -g @agentproto/cli@...` before installing the systemd unit.
   *  Default true. Skipped when the health probe finds the daemon already up. */
  updateCliOnBoot?: boolean
  /** Extra npm package specs installed globally ALONGSIDE the CLI update
   *  (one `npm i -g`). Ignored when `updateCliOnBoot` is false or the daemon
   *  was already up. */
  installPackages?: string[]
  /** Timeout (seconds, exec-clamped 1..600) for the `npm i -g` update. */
  updateCliTimeoutSeconds?: number
  /** How long to wait for the machine itself to reach `runtime.ready`. */
  readyTimeoutMs?: number
  /** How long to wait for the daemon to become healthy after starting it. */
  daemonReadyTimeoutMs?: number
  /** Extra machine metadata written at create time (merged with the
   *  provider's own `agentproto: "1"` stamp). */
  metadata?: Record<string, string>
  /** Extra shell commands host-executed after the boot update, before the
   *  daemon starts. Runs on EVERY boot/connect; entries must be idempotent. */
  setupCommands?: string[]
}

interface ResolvedConfig {
  apiKey: string
  apiUrl: string
  template: string
  timeoutSeconds: number
  autoSuspendAfterSeconds: number
  port: number
  workspace: string
  cliVersion: string
  updateCliOnBoot: boolean
  installPackages: string[]
  updateCliTimeoutSeconds: number
  readyTimeoutMs: number
  daemonReadyTimeoutMs: number
  metadata: Record<string, string>
  setupCommands: string[]
}

function readConfig(rawConfig: unknown): ResolvedConfig {
  const raw = (rawConfig ?? {}) as Record<string, unknown>
  const num = (field: unknown, fallback: number, min: number, max: number): number => {
    if (typeof field !== "number" || !Number.isFinite(field)) return fallback
    return Math.min(max, Math.max(min, Math.floor(field)))
  }
  const str = (field: unknown): string | undefined =>
    typeof field === "string" && field.length > 0 ? field : undefined
  const metadata =
    typeof raw.metadata === "object" && raw.metadata !== null
      ? Object.fromEntries(
          Object.entries(raw.metadata as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {}
  return {
    apiKey: str(raw.apiKey) ?? process.env.INSTABOX_API_KEY ?? "",
    apiUrl: str(raw.apiUrl) ?? "https://api.instabox.sh",
    template: str(raw.template) ?? DEFAULT_TEMPLATE,
    timeoutSeconds: num(raw.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS),
    autoSuspendAfterSeconds:
      typeof raw.autoSuspendAfterSeconds === "number" && Number.isFinite(raw.autoSuspendAfterSeconds)
        ? Math.min(86400, Math.max(0, Math.floor(raw.autoSuspendAfterSeconds)))
        : DEFAULT_AUTO_SUSPEND_AFTER_SECONDS,
    port: num(raw.port, DEFAULT_PORT, 1, 65_535),
    workspace: str(raw.workspace) ?? DEFAULT_WORKSPACE,
    cliVersion: str(raw.cliVersion) ?? "latest",
    updateCliOnBoot: typeof raw.updateCliOnBoot === "boolean" ? raw.updateCliOnBoot : true,
    installPackages: Array.isArray(raw.installPackages)
      ? raw.installPackages.filter((p): p is string => typeof p === "string" && p.length > 0)
      : [],
    updateCliTimeoutSeconds: num(
      raw.updateCliTimeoutSeconds,
      DEFAULT_UPDATE_CLI_TIMEOUT_SECONDS,
      1,
      EXEC_MAX_TIMEOUT_SECONDS,
    ),
    readyTimeoutMs: num(raw.readyTimeoutMs, READY_TIMEOUT_MS, 1_000, 600_000),
    daemonReadyTimeoutMs: num(raw.daemonReadyTimeoutMs, DAEMON_READY_TIMEOUT_MS, 1_000, 600_000),
    metadata,
    setupCommands: Array.isArray(raw.setupCommands)
      ? raw.setupCommands.filter((c): c is string => typeof c === "string" && c.length > 0)
      : [],
  }
}

/** The EnvironmentFile body: resolved secrets from `opts.env` PLUS the token
 *  gating the public edge. Never rendered into a command line. */
export function environmentFileContents(env: Record<string, string>, authToken: string): string {
  const lines = [
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    `${AUTH_TOKEN_ENV_VAR}=${authToken}`,
  ]
  return `${lines.join("\n")}\n`
}

/**
 * One shell command that writes the daemon's EnvironmentFile (root, 0600)
 * and its systemd unit, BOTH through heredocs. No secret is ever part of an
 * argv token: the env content sits inside the heredoc body (which the exec
 * API turns into `sudo tee`'s stdin), and the unit's ExecStart references the
 * token as `${AGENTPROTO_AUTH_TOKEN}`, substituted by systemd from the
 * EnvironmentFile. Heredoc terminators must sit on their own lines (the same
 * live-tested lesson as `@agentproto/sandbox-box`'s writeSystemdUnitCommand:
 * chaining " && " after a heredoc lands the next command INSIDE it and the
 * unit write silently no-ops at exit 0).
 */
export function writeDaemonUnitCommand(
  port: number,
  workspace: string,
  env: Record<string, string>,
  authToken: string,
): { command: string; envFileContents: string; unitContents: string } {
  const envFileContents = environmentFileContents(env, authToken)
  const unit = [
    "[Unit]",
    "Description=agentproto daemon",
    "After=network.target",
    "",
    "[Service]",
    `EnvironmentFile=-${ENV_FILE_PATH}`,
    `ExecStart=agentproto serve --port ${port} --bind 0.0.0.0 --workspace "${workspace}" ` +
      `--auth-token \${${AUTH_TOKEN_ENV_VAR}}`,
    "Restart=always",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\n")
  const command = [
    "set -e",
    `sudo mkdir -p ${ENV_FILE_DIR}`,
    `sudo tee ${ENV_FILE_PATH} > /dev/null <<'AGENTPROTO_ENV'\n${envFileContents}AGENTPROTO_ENV`,
    `sudo chmod 600 ${ENV_FILE_PATH}`,
    `sudo tee ${SYSTEMD_UNIT_PATH} > /dev/null <<'AGENTPROTO_UNIT'\n${unit}\nAGENTPROTO_UNIT`,
  ].join("\n")
  return { command, envFileContents, unitContents: unit }
}

/** The global install command line (exported for tests: only package spec
 *  names, never a secret). The box user is the unprivileged `user` and the
 *  npm prefix is the root-owned /usr/local (measured live: a bare `npm i -g`
 *  dies with EACCES), so it runs through `sudo`, keeping the caller's PATH
 *  because `sudo`'s secure_path may not list node's directory. */
export function buildCliInstallCommand(cliVersion: string, extras: string[]): string {
  const extraText = extras.map(extra => ` '${extra.replace(/'/g, "")}'`).join("")
  return `sudo env "PATH=$PATH" npm i -g "@agentproto/cli@${cliVersion}"${extraText}`
}

/**
 * Quota gate, run BEFORE creating anything: the account limit is 5 machines
 * and suspended/stopped ones count against it, so a pre-check (`GET /v1/usage`
 * + `GET /v1/machines`) catches the common case early and throws a typed
 * `SandboxQuotaError` a caller can fall back to another provider on. The
 * calls are best-effort: a usage API that does not answer must not break a
 * boot that the create call could still grant.
 */
export async function assertQuotaAvailable(client: InstaboxClient): Promise<void> {
  const [usage, machines] = await Promise.all([
    client.readUsage().catch(() => undefined),
    client.listMachines({}, 200).catch(() => undefined),
  ])
  const max = usage?.limits?.maxMachines
  if (typeof max === "number" && machines !== undefined && machines.length >= max) {
    throw new SandboxQuotaError(
      PROVIDER_SLUG,
      `instabox: account limit is ${max} machines and ${machines.length} already exist ` +
        "(suspended and stopped machines count); stop one before booting another.",
    )
  }
}

/** Re-map a create/lifecycle failure that is quota-shaped (HTTP 402/403/429,
 *  or a code/message containing "quota" or "limit"; the string exists in the
 *  official CLI but was never received live) to `SandboxQuotaError`, so a
 *  caller falls back to a different provider instead of surfacing the noise. */
export function normalizeQuotaError(err: unknown): unknown {
  if (err instanceof InstaboxApiError && isInstaboxQuotaFailure(err.status, err.code, err.message)) {
    return new SandboxQuotaError(
      PROVIDER_SLUG,
      `instabox: account limit reached (HTTP ${err.status ?? "?"}, code "${err.code}"): ` +
        "fall back to a different sandbox provider.",
      err,
    )
  }
  return err
}

function bootMetadata(config: ResolvedConfig, spec: SandboxSpec): Record<string, string> {
  const sessionId = (spec as SandboxSpec & { id?: unknown }).id
  const metadata: Record<string, string> = { ...config.metadata }
  metadata[AGENTPROTO_METADATA_KEY] = AGENTPROTO_METADATA_VALUE
  if (typeof sessionId === "string" && sessionId.length > 0) {
    metadata.session = sessionId
  }
  return metadata
}

/** Poll the machine until `runtime.ready` (or the deadline). */
async function waitMachineReady(
  client: InstaboxClient,
  machineId: string,
  timeoutMs: number,
): Promise<InstaboxMachine> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const machine = await client.getMachine(machineId)
    if (machine.runtime?.ready === true) return machine
    if (Date.now() >= deadline) {
      throw new Error(
        `@agentproto/sandbox-instabox: machine ${machineId} did not reach runtime.ready ` +
          `within ${timeoutMs}ms.`,
      )
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

/** Poll `<url>/health` until it answers OK, or false once the deadline
 *  elapses. */
async function probeHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) })
      if (res.ok) return true
    } catch {
      // not up yet (the InstaBox edge answers 502 while nothing listens)
    }
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

interface PendingProvision {
  client: InstaboxClient
  machineId: string
  config: ResolvedConfig
  env: Record<string, string>
  authToken: string
}

/**
 * Shared tail of `boot` and `connect`: publish the daemon port, then probe
 * the daemon through the PUBLIC edge (/health unauthenticated; /mcp itself is
 * bearer-gated by `--auth-token`). Only when the probe stays red: update the
 * CLI, write the EnvironmentFile (0600) and the systemd unit (secrets in the
 * heredoc, token via env substitution), run the setup hooks, enable the unit,
 * and re-probe through the edge. `deleteOnFailure` (the FRESH boot path)
 * reaps the machine when the daemon never comes up, so a failed boot never
 * leaks a running, session-less box; connect leaves the machine alone.
 */
async function provisionAndProbe(
  state: PendingProvision,
  deleteOnFailure: boolean,
): Promise<{ url: string; mcpUrl: string }> {
  const { client, machineId, config } = state
  const published = await client.publishPort(machineId, config.port)
  const publicUrl = published.url
  const healthUrl = `${publicUrl}/health`

  const alreadyUp = await probeHealth(healthUrl, ALREADY_UP_PROBE_TIMEOUT_MS)
  if (!alreadyUp) {
    if (config.updateCliOnBoot) {
      await execChecked(client, machineId, "CLI install", {
        cmd: buildCliInstallCommand(
          config.cliVersion,
          config.installPackages.map(extra => extra.replace(/'/g, "")),
        ),
        timeoutSeconds: config.updateCliTimeoutSeconds,
      })
    }
    await execChecked(client, machineId, "workspace setup", {
      cmd: `mkdir -p '${config.workspace}' && sudo mkdir -p ${ENV_FILE_DIR}`,
    })
    // stderr is NOT quoted here: the command carries the secrets heredoc.
    await execChecked(
      client,
      machineId,
      "daemon unit install",
      { cmd: writeDaemonUnitCommand(config.port, config.workspace, state.env, state.authToken).command },
      { quoteStderr: false },
    )
    for (const command of config.setupCommands) {
      await execChecked(client, machineId, "setup command", {
        cmd: command,
        timeoutSeconds: EXEC_MAX_TIMEOUT_SECONDS,
      })
    }
    await execChecked(client, machineId, "daemon enable", {
      cmd: `sudo systemctl daemon-reload && sudo systemctl enable --now ${DAEMON_UNIT_NAME} ${BACKGROUND_REDIRECT}`,
    })
    const ready = await probeHealth(healthUrl, config.daemonReadyTimeoutMs)
    if (!ready) {
      if (deleteOnFailure) await client.deleteMachine(machineId).catch(() => undefined)
      throw new Error(
        `@agentproto/sandbox-instabox: agentproto daemon did not become healthy at ${healthUrl} ` +
          `within ${config.daemonReadyTimeoutMs}ms (machine ${machineId}).`,
      )
    }
  }
  return { url: publicUrl, mcpUrl: `${publicUrl}/mcp` }
}

/** Run one exec for provisioning; a non-zero exit is a RESULT, a transport
 *  failure throws with its message scrubbed (so the error never carries the
 *  command body, let alone a secret). */
async function execScrubbed(
  client: InstaboxClient,
  machineId: string,
  input: { cmd: string; stdin?: string; timeoutSeconds?: number },
): Promise<InstaboxExecResultApi> {
  try {
    return await client.exec(machineId, input)
  } catch (err) {
    if (err instanceof Error) {
      const scrubbed = scrubCommandFromMessage(err.message, input.cmd)
      if (scrubbed !== err.message) {
        const wrapped = new Error(scrubbed)
        wrapped.name = err.name
        throw wrapped
      }
    }
    throw err
  }
}

/** `execScrubbed` that also refuses a non-zero exit: a failed install must
 *  surface as itself instead of as a daemon that "never became healthy" 60s
 *  later. Only the exit code and the head of stderr are reported, never the
 *  command (it can carry the env file heredoc). */
async function execChecked(
  client: InstaboxClient,
  machineId: string,
  what: string,
  input: { cmd: string; stdin?: string; timeoutSeconds?: number },
  opts: { quoteStderr?: boolean } = {},
): Promise<InstaboxExecResultApi> {
  const result = await execScrubbed(client, machineId, input)
  if (result.exitCode !== 0) {
    const detail =
      opts.quoteStderr === false ? "" : scrubCommandFromMessage(result.stderr.trim(), input.cmd).slice(0, 300)
    throw new Error(
      `@agentproto/sandbox-instabox: ${what} failed on machine ${machineId} ` +
        `(exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}${detail ? `: ${detail}` : ""}).`,
    )
  }
  return result
}

function newInstanceName(): string {
  return `agentproto-${randomBytes(5).toString("hex")}`
}

function newAuthToken(): string {
  return randomBytes(AUTH_TOKEN_BYTES).toString("hex")
}

function machineIdOf(machine: InstaboxMachine): string {
  if (typeof machine.id !== "string" || machine.id.length === 0) {
    throw new Error("instabox: machine response carries no id")
  }
  return machine.id
}

/** Clamp for machine `timeoutSeconds` (create and extend re-arms). */
function clampTimeoutSeconds(seconds: number): number {
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, Math.floor(seconds)))
}

/** InstaBox execs clamp 1..600 seconds; an absent bound maps to the max (not
 *  the API's own 60s default, see module docs). */
function clampExecTimeoutSeconds(timeoutMs: number | undefined): number {
  const seconds = Math.floor((timeoutMs ?? EXEC_DEFAULT_TIMEOUT_SECONDS * 1000) / 1000)
  return Math.min(EXEC_MAX_TIMEOUT_SECONDS, Math.max(1, seconds))
}

/** Wrap a healthy machine into the `BootedSandbox` shape common to `boot` and
 *  `connect`. Deliberately NO `pause()`: a manually suspended InstaBox machine
 *  does not wake on its own, so callers must fall back to `stop()` (delete). */
function toBootedSandbox(
  client: InstaboxClient,
  machineId: string,
  mcpUrl: string,
  authToken: string,
  config: ResolvedConfig,
  ports: Record<number, string>,
): BootedSandbox {
  return {
    mcpUrl,
    sandboxId: machineId,
    ...(Object.keys(ports).length > 0 ? { ports } : {}),
    // The public edge is UNGATED at InstaBox: the daemon's own bearer (minted
    // here at unit install time and substituted from the 0600 EnvironmentFile)
    // is the only thing gating /mcp, so it is ALWAYS surfaced.
    token: authToken,
    authHeaders: { Authorization: `Bearer ${authToken}` },
    async stop(): Promise<void> {
      try {
        const op = await client.deleteMachine(machineId)
        await client.waitForOperation(op.id)
      } catch (err) {
        if (err instanceof InstaboxApiError && err.status === 404) return
        await client.deleteMachine(machineId).catch(() => undefined)
        throw err
      }
    },
    async exec(opts: SandboxExecOpts): Promise<SandboxExecResult> {
      const startedAt = Date.now()
      const result = await client.exec(machineId, {
        cmd: opts.command,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.env !== undefined ? { envs: opts.env } : {}),
        // InstaBox clamps exec 1..600s. An omitted bound maps to the max,
        // NOT the API's own 60s default (mid-work-kill trap, module docs).
        timeoutSeconds: clampExecTimeoutSeconds(opts.timeoutMs),
      })
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - startedAt,
        ...(result.truncated ? { truncated: result.truncated } : {}),
      }
    },
    async readFile(path: string): Promise<Uint8Array> {
      const chunks: Uint8Array[] = []
      for (let index = 0; ; index++) {
        // `dd ibs=<chunk> skip=<index> count=1` slices the file, `base64 -w0`
        // inlines it under the 1 MiB stdout cap (700 KB -> ~933 KB of b64).
        const result = await client.exec(machineId, {
          cmd: `dd if='${path}' ibs=${FILE_CHUNK_BYTES} skip=${index} count=1 2>/dev/null | base64 -w0`,
          timeoutSeconds: EXEC_MAX_TIMEOUT_SECONDS,
        })
        const encoded = result.stdout.trim()
        if (index === 0 && result.exitCode !== 0 && encoded === "") {
          throw new Error(
            `instabox readFile: cannot read "${path}" (exit ${result.exitCode}, ` +
              `stderr: ${result.stderr.trim() || "(none)"})`,
          )
        }
        if (encoded.length === 0) break
        chunks.push(new Uint8Array(Buffer.from(encoded, "base64")))
        if (encoded.length < FILE_CHUNK_B64_CHARS) break
      }
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      const out = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.byteLength
      }
      return out
    },
    async writeFile(path: string, data: Uint8Array): Promise<void> {
      // Base64 the whole payload once, then stream `dd`-independent slices of
     //  that b64 through exec STDIN (never an argv token). Slicing on
     //  `FILE_CHUNK_B64_CHARS` (a multiple of 4) keeps every middle chunk
      // cleanly decodable; the trailing chunk keeps the base64 padding.
      const encoded = Buffer.from(data).toString("base64")
      const directory = path.slice(0, Math.max(path.lastIndexOf("/"), 0)) || "/"
      for (let offset = 0, index = 0; index === 0 || offset < encoded.length; offset += FILE_CHUNK_B64_CHARS, index++) {
        const slice = encoded.slice(offset, offset + FILE_CHUNK_B64_CHARS)
        await client.exec(machineId, {
          cmd:
            index === 0
              ? `mkdir -p '${directory}' && base64 -d > '${path}'`
              : `base64 -d >> '${path}'`,
          stdin: slice,
          timeoutSeconds: EXEC_MAX_TIMEOUT_SECONDS,
        })
      }
    },
    async expose(port: number): Promise<{ url: string }> {
      const published = await client.publishPort(machineId, port)
      return { url: published.url }
    },
    async extendTimeout(ms: number): Promise<void> {
      // PATCH timeoutSeconds restarts the countdown FROM NOW (the API's own
      // semantics), so `ms` simply maps to a clamped second count.
      const seconds = clampTimeoutSeconds(ms / 1000)
      await client.patchMachine(machineId, { timeoutSeconds: seconds })
    },
    lifetimeMs: config.timeoutSeconds * 1000,
  }
}

/**
 * Bring a machine back to running, STATE-AWARE (module docs): `running` is a
 * no-op; `suspended` first tries `wake` (the AUTO-suspend path: 200 direct)
 * then `resume` for a manually-suspended box; anything else (`stopped`) goes
 * through `start`. A verb the API refuses surfaces a clear error instead of a
 * silent wrong-state reconnect.
 */
async function reviveMachine(client: InstaboxClient, machineId: string, state: string): Promise<void> {
  if (state === "running") return
  if (state === "suspended") {
    try {
      await client.wake(machineId)
      return
    } catch (err) {
      // Only a CONFLICT means "manually suspended, wake refuses" (the API
      // answers 409 machine_not_running). Any other failure — a transport
      // error, a 5xx — must surface as itself rather than be misreported as
      // "wake and resume both refused".
      const conflict =
        err instanceof InstaboxApiError &&
        (err.status === 409 || err.code === "machine_not_running")
      if (!conflict) throw err
    }
    const resume = await client.machineAction(machineId, "resume").catch(err => {
      throw new Error(
        `@agentproto/sandbox-instabox: machine ${machineId} is suspended and refused both ` +
          `wake and resume (${err instanceof Error ? err.message : String(err)}).`,
      )
    })
    await client.waitForOperation(resume.id)
    return
  }
  const start = await client.machineAction(machineId, "start").catch(err => {
    throw new Error(
      `@agentproto/sandbox-instabox: machine ${machineId} is "${state}" and refused start ` +
        `(${err instanceof Error ? err.message : String(err)}).`,
    )
  })
  await client.waitForOperation(start.id)
}

/**
 * Re-derive the daemon bearer from the 0600 EnvironmentFile the boot that
 * installed this daemon wrote: connect never rewrites the env file while the
 * daemon is running, so the token it returns MUST match what is installed.
 */
async function readExistingAuthToken(client: InstaboxClient, machineId: string): Promise<string> {
  // Read ONLY the token line: `cat`-ing the whole EnvironmentFile would pull
  // every box secret (OPENROUTER_API_KEY, …) back into this host process for
  // no reason. `grep` keeps the sensitive values in the box.
  const result = await client.exec(machineId, {
    cmd: `sudo grep '^${AUTH_TOKEN_ENV_VAR}=' ${ENV_FILE_PATH} 2>/dev/null || true`,
    timeoutSeconds: 60,
  })
  if (result.exitCode !== 0) {
    throw new Error(`instabox: daemon env file unreadable (exit ${result.exitCode})`)
  }
  const line = result.stdout
    .split("\n")
    .map(entry => entry.trim())
    .find(entry => entry.startsWith(`${AUTH_TOKEN_ENV_VAR}=`))
  const value = line?.slice(`${AUTH_TOKEN_ENV_VAR}=`.length)
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`instabox: ${AUTH_TOKEN_ENV_VAR} missing from the daemon env file`)
  }
  return value
}

function resolveExtraPorts(spec: SandboxSpec): number[] {
  const extras = (spec as SandboxSpec & { extraPorts?: unknown }).extraPorts
  if (!Array.isArray(extras)) return []
  return extras.filter((port): port is number => typeof port === "number" && Number.isInteger(port))
}

/**
 * `createInstaboxSandboxProvider(config)` — an AIP-36 `SandboxProvider`
 * factory. `config` seeds every boot/connect's spec.config (a per-spec value
 * wins per field). The bare `instaboxSandboxProvider` export (what the
 * registry wraps) seeds nothing: credentials come from spec.config or the
 * `INSTABOX_API_KEY` env var.
 */
export function createInstaboxSandboxProvider(baseConfig: InstaboxSandboxSpecConfig = {}): SandboxProvider {
  function resolveConfig(spec: SandboxSpec): ResolvedConfig {
    const raw = (spec.config ?? {}) as Record<string, unknown>
    const merged: Record<string, unknown> = { ...baseConfig, ...raw }
    if (baseConfig.metadata !== undefined && raw.metadata !== undefined) {
      merged.metadata = {
        ...baseConfig.metadata,
        ...(typeof raw.metadata === "object" && raw.metadata !== null
          ? (raw.metadata as Record<string, string>)
          : {}),
      }
    }
    return readConfig(merged)
  }

  function assertApiKey(config: ResolvedConfig): void {
    if (config.apiKey === "") {
      throw new Error(
        "@agentproto/sandbox-instabox: no InstaBox API key — set spec.config.apiKey " +
          "or the INSTABOX_API_KEY environment variable.",
      )
    }
  }

  return {
    async boot(spec: SandboxSpec, opts: SandboxBootOpts): Promise<BootedSandbox> {
      const config = resolveConfig(spec)
      assertApiKey(config)
      const client = new InstaboxClient({ apiKey: config.apiKey, apiUrl: config.apiUrl })
      const authToken = newAuthToken()
      await assertQuotaAvailable(client)
      const created = await client
        .createMachine(
          {
            name: newInstanceName(),
            templateId: config.template,
            timeoutSeconds: config.timeoutSeconds,
            onTimeout: "kill",
            autoSuspendAfterSeconds: config.autoSuspendAfterSeconds,
            metadata: bootMetadata(config, spec),
            // ALWAYS sent and ALWAYS false: a vault would write the caller's
            // secrets into a box that runs agent code.
            vault: false,
          },
          crypto.randomUUID(),
        )
        .catch(err => {
          throw normalizeQuotaError(err)
        })
      try {
        await client.waitForOperation(created.id)
        const machineId = created.machineId ?? created.machine?.id
        if (machineId === undefined) {
          throw new Error(
            `@agentproto/sandbox-instabox: create operation ${created.id} settled with no machine id.`,
          )
        }
        await waitMachineReady(client, machineId, config.readyTimeoutMs)
        const extraPorts = resolveExtraPorts(spec)
        const provisioned = await provisionAndProbe(
          { client, machineId, config, env: opts.env, authToken },
          true,
        )
        const ports: Record<number, string> = {}
        for (const port of extraPorts) {
          ports[port] = (await client.publishPort(machineId, port)).url
        }
        return toBootedSandbox(client, machineId, provisioned.mcpUrl, authToken, config, ports)
      } catch (err) {
        // Every failure past the create must reclaim the machine, so a failed
        // create operation or a long provisioning failure never leaves a
        // running, session-less box behind.
        const machineId = created.machineId ?? created.machine?.id
        if (machineId !== undefined) await client.deleteMachine(machineId).catch(() => undefined)
        throw normalizeQuotaError(err)
      }
    },

    /** Reconnect to an existing box, state-aware (see `reviveMachine`).
     *  State mapping: `running` = ok, auto-`suspended` = `wake`, manually
     *  `suspended` or `stopped` = `resume`/`start` as the API allows, else a
     *  clear error. A deleted machine surfaces as `SandboxBoxGoneError`. */
    async connect(sandboxId: string, spec: SandboxSpec, opts: SandboxBootOpts): Promise<BootedSandbox> {
      const config = resolveConfig(spec)
      assertApiKey(config)
      const client = new InstaboxClient({ apiKey: config.apiKey, apiUrl: config.apiUrl })
      let machine: InstaboxMachine
      try {
        machine = await client.getMachine(sandboxId)
      } catch (err) {
        if (err instanceof InstaboxApiError && err.status === 404) {
          throw new SandboxBoxGoneError(sandboxId, err)
        }
        throw err
      }
      const machineId = machineIdOf(machine)
      await reviveMachine(client, machineId, machine.state)
      await waitMachineReady(client, machineId, config.readyTimeoutMs)
      if (machine.state !== "running" && (await client.getMachine(machineId)).state !== "running") {
        throw new Error(
          `@agentproto/sandbox-instabox: machine ${machineId} did not reach "running" — cannot reconnect.`,
        )
      }
      let authToken: string
      try {
        authToken = await readExistingAuthToken(client, machineId)
      } catch (err) {
        throw new Error(
          `@agentproto/sandbox-instabox: machine ${machineId} is running but its daemon token ` +
            `could not be read from ${ENV_FILE_PATH} (${err instanceof Error ? err.message : String(err)}) ` +
            "— reconnect needs the token the boot that installed the daemon issued.",
        )
      }
      // Re-arm the SAME runway a fresh boot gets (InstaBox restarts the life
      // countdown from now), like e2b's connect `setTimeout` re-arm.
      await client.patchMachine(machineId, { timeoutSeconds: clampTimeoutSeconds(config.timeoutSeconds) })
      const provisioned = await provisionAndProbe(
        { client, machineId, config, env: opts.env, authToken },
        false,
      )
      const ports: Record<number, string> = {}
      for (const port of resolveExtraPorts(spec)) {
        ports[port] = (await client.publishPort(machineId, port)).url
      }
      return toBootedSandbox(client, machineId, provisioned.mcpUrl, authToken, config, ports)
    },

    /** Provider control-plane liveness: 404 means gone; any other answer (or
     *  thrown error) stays verbatim so callers read "check failed", never
     *  "box died". */
    async probe(sandboxId: string): Promise<SandboxProbeResult> {
      // probe() has no spec to carry a key: fall back to the factory config,
      // then the env var, and be loud when there is nothing to authenticate.
      const providerApiKey = baseConfig.apiKey ?? process.env.INSTABOX_API_KEY
      if (providerApiKey === undefined || providerApiKey === "") {
        throw new Error(
          "@agentproto/sandbox-instabox: no InstaBox API key for probe — construct the " +
            "provider with createInstaboxSandboxProvider({ apiKey }) or set INSTABOX_API_KEY.",
        )
      }
      const client = new InstaboxClient({ apiKey: providerApiKey, apiUrl: baseConfig.apiUrl })
      try {
        const machine = await client.getMachine(sandboxId)
        return { alive: true, ...(machine.state !== undefined ? { state: String(machine.state) } : {}) }
      } catch (err) {
        if (err instanceof InstaboxApiError && err.status === 404) return { alive: false }
        throw err
      }
    },
  }
}

/** Bare provider instance the catalog/registry wraps. */
export const instaboxSandboxProvider: SandboxProvider = createInstaboxSandboxProvider()
