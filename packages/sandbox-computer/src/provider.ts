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
 * behaviour reads the flag yet. `config.maxSessions` independently caps
 * how many sessions this PROCESS maps onto one computer (default 1); the
 * controller has no attach/detach refcount, so cross-process counting is a
 * known gap (see README).
 *
 * TOKENS: the controller service token travels only in the Authorization
 * header; the per-box daemon token travels only inside the serve command
 * executed IN the box. Neither is ever logged by this package, embedded in
 * the create `env` payload, or included in an error message (the client
 * redacts the service token; this file never puts a token into a message).
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
import { ComputerApiError, ComputerControllerClient, type ComputerClientConfig } from "./client.js"

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
  /** How many sessions this process may map onto one computer. Default 1. */
  maxSessions?: number
  /** Port the agentproto daemon listens on inside the computer. Default 18790. */
  port?: number
  /** `--workspace` passed to `agentproto serve`. Default `/home/user`. */
  workspace?: string
  /**
   * Public URL template for reaching a computer's ports, containing a
   * `{port}` (and optionally `{id}`) placeholder, e.g.
   * `http://gate.internal:{port}/computers/{id}`. Default:
   * `http://<computer-name>:<port>` — the microVM is assumed addressable by
   * its generated name from the network this process lives on. Set this when
   * computers sit behind an edge/proxy instead.
   */
  gatewayUrl?: string
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
}

function readComputerConfig(spec: SandboxSpec): ComputerSandboxConfig {
  const config = (spec.config ?? {}) as Record<string, unknown>
  const int = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)
  return {
    controllerUrl: str(config.controllerUrl),
    token: str(config.token),
    tenantId: str(config.tenantId),
    template: str(config.template),
    cpus: int(config.cpus),
    memoryMiB: int(config.memoryMiB),
    rootDiskMiB: int(config.rootDiskMiB),
    ttlSeconds: int(config.ttlSeconds),
    maxSessions: int(config.maxSessions),
    port: int(config.port),
    workspace: str(config.workspace),
    gatewayUrl: str(config.gatewayUrl),
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

/** The `agentproto serve` boot script: a detached (nohup … &) daemon that
 *  outlives the synchronous exec call, logging to /var/log so a failed boot
 *  can be diagnosed in-box. The token lives ONLY in this script. */
export function buildServeCommand(opts: {
  token: string
  port: number
  workspace: string
  allowOrigin?: string
}): string {
  const origin = opts.allowOrigin ? ` --allow-origin ${shQuote(opts.allowOrigin)}` : ""
  return (
    `mkdir -p /var/log 2>/dev/null; ` +
    `nohup agentproto serve --port ${opts.port} --bind 0.0.0.0` +
    ` --workspace ${shQuote(opts.workspace)} --auth-token ${shQuote(opts.token)}${origin}` +
    ` </dev/null > /var/log/agentproto-daemon.log 2>&1 & echo started`
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
  return Object.entries(env).map(([k, v]) => `export ${k}=${shQuote(v)};`).join(" ")
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

// ── fork identity bookkeeping ─────────────────────────────────────────
// Resume can rebuild a computer under a NEW generated name (full restore
// into a fresh unit). Map old → new within this process so probe()/exec on
// the originally-known id keep working instead of reading a phantom 404.

const idAliases = new Map<string, string>()

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
 *  `{port}`/`{id}` substituted, else the computer's own generated name —
 *  the default assumes the box network is addressable by name from this
 *  process's network; override with `config.gatewayUrl`. */
export function boxUrl(id: string, port: number, gatewayUrl?: string): string {
  if (gatewayUrl) return gatewayUrl.replace(/\{port\}/g, String(port)).replace(/\{id\}/g, id)
  return `http://${id}:${port}`
}

// ── the provider ──────────────────────────────────────────────────────

export const computerSandboxProvider: SandboxProvider = {
  async boot(spec: SandboxSpec, opts: SandboxBootOpts): Promise<BootedSandbox> {
    const config = readComputerConfig(spec)
    const client = new ComputerControllerClient(resolveClientConfig(spec, config))
    return bootOnClient(client, spec, config, opts)
  },

  async connect(sandboxId: string, spec: SandboxSpec, opts: SandboxBootOpts): Promise<BootedSandbox> {
    const config = readComputerConfig(spec)
    const client = new ComputerControllerClient(resolveClientConfig(spec, config))
    return connectOnClient(client, sandboxId, spec, config, opts)
  },

  /** Liveness against the controller — one cheap GET, no box contact.
   *  404 ⇒ `{alive:false}`; anything else propagates ("check failed",
   *  never "box died"). */
  async probe(sandboxId: string): Promise<SandboxProbeResult> {
    const client = new ComputerControllerClient(
      resolveClientConfig({ provider: "computer", config: { controllerUrl: process.env.COMPUTER_CONTROLLER_URL } }, readComputerConfig({ provider: "computer", config: {} })),
    )
    const status = await client.getComputer(resolveAlias(sandboxId))
    if (status === null) return { alive: false }
    return { alive: true, state: status.state }
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
      env: createEnv,
    })
  } catch (err) {
    if (err instanceof ComputerApiError) {
      throw new Error(
        `computer sandbox: create rejected (HTTP ${err.status}${err.code ? `, "${err.code}"` : ""})` +
          (err.code === "unknown template"
            ? ` — that template is not registered on this controller; see the README's config.template note`
            : ""),
      )
    }
    throw err
  }
  const sandboxId = created.id
  const daemonToken = randomUUID()

  try {
    await waitRunning(client, sandboxId, config.waitReadyTimeoutMs ?? DEFAULT_WAIT_READY_TIMEOUT_MS)
    await daemonHealthyOrThrow(client, sandboxId, config, daemonToken, port, workspace)
  } catch (err) {
    // A failed boot must never leak a computer (same never-leak contract as
    // sandbox-e2b): propagate the original error but reclaim the box.
    await client.remove(sandboxId).catch(() => undefined)
    throw err
  }

  acquireSessionSlot(sandboxId, config.maxSessions ?? 1)
  return wrapBox(client, sandboxId, spec, config, port)
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

  const status = await client.getComputer(sandboxId)
  if (status === null) throw new SandboxBoxGoneError(sandboxId)

  // A suspended/stopped computer is resumed first. The controller may
  // rebuild it under a NEW id — adopt it, remember the alias.
  let currentId = sandboxId
  if (status.state !== "running") {
    const resumeResult = await client.resume(sandboxId)
    const targetId = resumeResult.id ?? sandboxId
    if (targetId !== sandboxId) idAliases.set(sandboxId, targetId)
    currentId = targetId
    await waitRunning(client, currentId, config.waitReadyTimeoutMs ?? DEFAULT_WAIT_READY_TIMEOUT_MS)
  }

  // A restored computer keeps its disk but its daemon may be gone: same
  // ensure-healthy dance as a fresh boot (skips the install when up).
  const daemonToken = randomUUID()
  try {
    await daemonHealthyOrThrow(client, currentId, config, daemonToken, port, workspace)
  } catch (err) {
    throw err
  }

  const maxSessions = config.maxSessions ?? 1
  if (!acquireSessionSlot(currentId, maxSessions)) {
    throw new Error(
      `computer "${currentId}" already hosts the maximum number of sessions this process tracks ` +
        `(${maxSessions}); attach to the existing session instead of opening a new one`,
    )
  }
  return wrapBox(client, currentId, spec, config, port)
}

/** Poll until the computer reports `running`, or throw with the last state. */
async function waitRunning(
  client: ComputerControllerClient,
  id: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await client.getComputer(id)
    if (status === null) throw new SandboxBoxGoneError(id)
    if (status.state === "running") return
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
): Promise<void> {
  const probe = await hardExec(client, id, bashArgv(buildHealthCommand(port)), 10)
  const alreadyUp = probe.exitCode === 0 && !probe.stdout.includes("__down__")
  if (alreadyUp) return

  if (config.updateCliOnBoot !== false) {
    const extras = (config.installPackages ?? []).map((p) => ` ${shQuote(p)}`).join("")
    await hardExec(
      client,
      id,
      bashArgv(`npm i -g @agentproto/cli@${shQuote(config.cliVersion ?? "latest")}${extras}`),
      Math.min(EXEC_TIMEOUT_MAX_SEC, Math.ceil(UPDATE_CLI_TIMEOUT_MS / 1000)),
    )
  }
  for (const command of config.setupCommands ?? []) {
    await hardExec(client, id, bashArgv(command), EXEC_TIMEOUT_MAX_SEC)
  }

  const mcpOrigin = new URL(boxUrl(id, port, config.gatewayUrl)).origin
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
        `within ${waitSeconds}s (see /var/log/agentproto-daemon.log in the box)`,
    )
  }
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

function wrapBox(
  client: ComputerControllerClient,
  id: string,
  spec: SandboxSpec,
  config: ComputerSandboxConfig,
  port: number,
): BootedSandbox {
  const extraPorts: Record<number, string> = {}
  for (const extra of spec.extraPorts ?? []) {
    extraPorts[extra] = boxUrl(id, extra, config.gatewayUrl)
  }

  return {
    mcpUrl: boxUrl(id, port, config.gatewayUrl),
    sandboxId: id,
    // `expose: "private"` (the attach path) asks for a durable token-gated
    // URL. This daemon IS token-gated (`--auth-token`), but the token lives
    // only inside the box and is deliberately never surfaced here — callers
    // that require a token must treat a missing one as "not gated" per the
    // SandboxBootOpts contract; attach fails closed on its side.
    ...(Object.keys(extraPorts).length > 0 ? { ports: extraPorts } : {}),
    expose(port: number): Promise<{ url: string }> {
      return Promise.resolve({ url: boxUrl(id, port, config.gatewayUrl) })
    },
    async stop(): Promise<void> {
      releaseSessionSlot(id)
      await client.remove(id)
    },
    async pause(): Promise<void> {
      await client.suspend(id)
    },
    async extendTimeout(): Promise<void> {
      // The controller sets a computer TTL at create time and has no
      // extend-timeout endpoint — nothing to renew. Kept as a no-op so a
      // host that re-arms on detach/activity still succeeds.
    },
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
