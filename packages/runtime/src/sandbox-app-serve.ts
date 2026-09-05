/**
 * WP3 — `agent_start.sandbox` + `appServe`: serve an agentproto app's UI
 * from INSIDE a booted sandbox box and hand back its public URL.
 *
 * The sandbox spawn path (`session-spawn.ts`'s `bootSandboxAgentSession`)
 * boots a box whose own agentproto daemon is reachable at `BootedSandbox
 * .mcpUrl`. That daemon already registers every tool the plain `/mcp`
 * gateway mounts — notably `app_install` (app-tools.ts), `file_read` /
 * `file_write` (fs-tools.ts, anchored to the box workspace) and
 * `command_execute` (command-tools.ts, allowlist-gated). This module
 * drives exactly those three, in order:
 *
 *   1. `app_install { dir }`        — install the app (dir is a path INSIDE
 *                                     the box; on the workstation image the
 *                                     daemon workspace is `/home/user`, so a
 *                                     pulled app lives at
 *                                     `/home/user/apps/<slug>`).
 *   2. allowlist seed               — `command_execute` is default-deny
 *                                     against the box workspace's
 *                                     `.agentproto/allowed-commands.json`.
 *                                     The launcher below needs `sh` (the
 *                                     detached backgrounding shell) and
 *                                     `agentproto` (the CLI that runs the
 *                                     server). Both are merged into the
 *                                     existing allowlist via `file_read` +
 *                                     `file_write` — additive only, so an
 *                                     operator-seeded allowlist is preserved.
 *   3. `command_execute`            — launch `agentproto app serve <dir>
 *                                     --host 0.0.0.0 --port <port>` DETACHED
 *                                     (`sh -c 'nohup … &'`): the sh wrapper
 *                                     exits immediately, so the RPC returns
 *                                     while the orphaned server lives as
 *                                     long as the box does. A direct
 *                                     (non-backgrounded) call would be
 *                                     hard-killed at `command_execute`'s
 *                                     timeoutMs cap — the server must
 *                                     outlive the RPC.
 *
 * The caller resolves the PUBLIC URL from the provider (a port declared in
 * `SandboxSpec.extraPorts` comes back pre-resolved in `BootedSandbox.ports`;
 * otherwise `BootedSandbox.expose(port)` works for any port on providers
 * that support it) and passes it in — readiness is probed against it.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

/** Default port `appServe` serves on when the caller doesn't pin one. */
export const DEFAULT_APP_SERVE_PORT = 3210

/** Workspace-relative allowlist file the box daemon's `command_execute`
 *  gates on (`ALLOWLIST_REL` in command-allowlist.ts — mirrored here as a
 *  literal so this module stays import-light). */
export const BOX_ALLOWLIST_REL = ".agentproto/allowed-commands.json"

/** Basenames the launcher needs allowlisted in the box workspace. */
const REQUIRED_ALLOWLIST_BASENAMES = ["sh", "agentproto"] as const

/** The `appServe` request carried on `agent_start` — an in-box app dir plus
 *  the port to serve its UI on. */
export interface SandboxAppServeSpec {
  /** Absolute path to the app's directory INSIDE the box (e.g.
   *  `/home/user/apps/<slug>`). Must not contain a single quote — the
   *  launcher shell-quotes it. */
  dir: string
  /** Port `agentproto app serve` binds inside the box. Must also be exposed
   *  by the provider (the spawn path appends it to `extraPorts` so a
   *  boot-time exposure exists on providers that pre-resolve). Defaults to
   *  `DEFAULT_APP_SERVE_PORT` when omitted. */
  port?: number
}

/** What a served app records on the session descriptor and echoes in the
 *  spawn result — non-secret, caller-visible. */
export interface SessionAppServeInfo {
  /** App id the box's `app_install` registered. */
  appId: string
  /** The in-box app dir that was installed + served. */
  dir: string
  /** Port the UI binds inside the box. */
  port: number
  /** Provider-resolved public URL for the served UI. */
  url: string
  /** True when a probe against `url` answered OK within the readiness
   *  window. False means the URL is the right address but the server had
   *  not answered yet — retry the fetch rather than re-spawning. */
  ready: boolean
}

/** The wire shape a daemon MCP tool reply carries — the subset this module
 *  reads. Tool results come back as `content: [{ type: "text", text }]`. */
export interface ToolTextResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

/** Minimal typed client over the BOX daemon's `/mcp` endpoint. Narrowed so
 *  tests can inject a fake without the MCP SDK. */
export interface BoxToolClient {
  callTool(
    name: string,
    args: Record<string, string | number | string[]>,
  ): Promise<ToolTextResult>
  close(): Promise<void>
}

/** The SDK's `callTool` reply is effectively index-signature-typed
 *  (`{ [key: string]: unknown }`), so the wrapper round-trips it through
 *  the guarded JSON parser below — no casts, and a malformed reply fails
 *  loudly instead of smuggling untyped data through. */
export async function connectBoxToolClient(mcpUrl: string): Promise<BoxToolClient> {
  const client = new Client(
    { name: "agentproto-sandbox-app-serve", version: "0.1.0" },
    { capabilities: {} },
  )
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl))
  await client.connect(transport)
  return {
    async callTool(name, args): Promise<ToolTextResult> {
      const raw = await client.callTool({ name, arguments: args })
      const reply = parseJsonRecordText(JSON.stringify(raw))
      if (!reply) {
        throw new Error(`box tool "${name}" returned an unreadable reply`)
      }
      const content = textBlocks(reply.content)
      if (reply.isError === true) {
        const text = content.find(c => c.type === "text")?.text
        throw new Error(
          `box tool "${name}" failed${text ? `: ${text}` : ""}`,
        )
      }
      return { content }
    },
    async close(): Promise<void> {
      await client.close()
    },
  }
}

/** Normalize a parsed reply's `content` value into the block shape this
 *  module reads, dropping anything that isn't a `{ type, text? }` record. */
function textBlocks(value: JsonValue | undefined): ToolTextResult["content"] {
  if (!Array.isArray(value)) return []
  const blocks: Array<{ type: string; text?: string }> = []
  for (const item of value) {
    if (!isJsonRecord(item)) continue
    blocks.push({
      type: typeof item.type === "string" ? item.type : "",
      ...(typeof item.text === "string" ? { text: item.text } : {}),
    })
  }
  return blocks
}

/** First text block of a tool result, or undefined when there is none. */
function firstText(res: ToolTextResult): string | undefined {
  const block = res.content.find(c => c.type === "text")
  return block?.text
}

// ── JSON parsing without casts ─────────────────────────────────────────────

type JsonValue = string | number | boolean | null | JsonValue[] | JsonRecord
export interface JsonRecord {
  [key: string]: JsonValue
}

function isJsonRecord(value: JsonValue): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Parse a text payload as a JSON object. Returns undefined when the text is
 *  empty or is not a JSON object — never throws. */
export function parseJsonRecordText(text: string): JsonRecord | undefined {
  if (text.length === 0) return undefined
  const parsed: JsonValue = JSON.parse(text)
  return isJsonRecord(parsed) ? parsed : undefined
}

/** Parse a tool result's text payload as a JSON object. Returns undefined
 *  when the payload is missing or is not a JSON object — never throws. */
export function parseToolJson(res: ToolTextResult): JsonRecord | undefined {
  const text = firstText(res)
  if (text === undefined) return undefined
  return parseJsonRecordText(text)
}

// ── pure helpers (unit-tested without any I/O) ─────────────────────────────

/**
 * Build the `sh -c` script that launches `agentproto app serve` detached
 * inside the box: `nohup … &` backgrounds the server (the orphaned process
 * survives the RPC that spawned it) and `echo $!` prints the server's PID so
 * the caller's result records it. Throws on a `dir` containing a single
 * quote — the shell quoting below would otherwise turn it into an injection.
 */
export function buildServeLaunchScript(dir: string, port: number): string {
  if (dir.includes("'")) {
    throw new Error(
      `sandbox app serve: app dir must not contain a single quote: "${dir}"`,
    )
  }
  const log = `${dir.replace(/\/+$/, "")}/.agentproto/app-serve.log`
  return `nohup agentproto app serve '${dir}' --host 0.0.0.0 --port ${port} >> '${log}' 2>&1 & echo $!`
}

/** Merge the basenames the launcher needs into an allowlist file's text.
 *  Additive only — every existing entry is preserved verbatim (a plain
 *  string or a `{command, args}` object). Returns the new file body as
 *  pretty-printed JSON. Accepts `null` (file absent / unreadable) and
 *  returns a minimal allowlist containing just the required basenames. */
export function mergeAllowlistForAppServe(existing: string | null): string {
  const commands: Array<string | JsonRecord> = []
  if (existing !== null) {
    const parsed: JsonValue = JSON.parse(existing)
    if (isJsonRecord(parsed) && Array.isArray(parsed.commands)) {
      for (const entry of parsed.commands) {
        if (typeof entry === "string") {
          commands.push(entry)
        } else if (isJsonRecord(entry) && typeof entry.command === "string") {
          commands.push(entry)
        }
      }
    }
  }
  for (const name of REQUIRED_ALLOWLIST_BASENAMES) {
    if (!commands.some(c => typeof c === "string" && c === name)) {
      commands.push(name)
    }
  }
  return `${JSON.stringify({ version: 1, commands }, null, 2)}\n`
}

// ── orchestration ───────────────────────────────────────────────────────────

/** The slice of a booted sandbox host the serve bootstrap needs — the shape
 *  `SandboxAgentSessionHost` already satisfies. */
export interface SandboxServeHost {
  mcpUrl: string
  ports?: Record<number, string>
  expose?(port: number): Promise<{ url: string }>
}

export type StartSandboxAppServeResult =
  | { ok: true; appServe: SessionAppServeInfo }
  | { ok: false; message: string }

/** Readiness probe: fetch the served URL and report whether it answered OK.
 *  Injectable for tests; the default is a plain fetch with a per-attempt
 *  timeout. */
export type ServeReadinessProbe = (url: string) => Promise<boolean>

async function defaultProbe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) })
    return res.ok
  } catch {
    return false
  }
}

/** Poll the probe until it answers true or the window elapses. */
export async function pollServeReady(
  url: string,
  opts?: { probe?: ServeReadinessProbe; timeoutMs?: number; intervalMs?: number },
): Promise<boolean> {
  const probe = opts?.probe ?? defaultProbe
  const timeoutMs = opts?.timeoutMs ?? 15_000
  const intervalMs = opts?.intervalMs ?? 1_000
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await probe(url)) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

async function seedAllowlist(client: BoxToolClient): Promise<void> {
  let existing: string | null = null
  try {
    const read = await client.callTool("file_read", { path: BOX_ALLOWLIST_REL })
    const text = firstText(read)
    if (text !== undefined) existing = text
  } catch {
    // Absent / unreadable → start from the minimal allowlist below.
  }
  const merged = mergeAllowlistForAppServe(existing)
  if (existing !== null && merged === existing) return
  await client.callTool("file_write", { path: BOX_ALLOWLIST_REL, content: merged })
}

/** Install the app on the box and return its registered appId. */
async function installApp(client: BoxToolClient, dir: string): Promise<string> {
  const res = await client.callTool("app_install", { dir })
  const record = parseToolJson(res)
  const appId = record?.appId
  if (typeof appId !== "string" || appId.length === 0) {
    throw new Error(
      `box app_install returned no appId for dir "${dir}" — ` +
        `${JSON.stringify(firstText(res) ?? "")}`,
    )
  }
  return appId
}

/** Launch `agentproto app serve` detached inside the box via the box
 *  daemon's `command_execute` (sh -c + nohup backgrounding — see module
 *  docs). Throws when the launcher itself fails (non-zero sh exit). */
async function launchServeProcess(
  client: BoxToolClient,
  dir: string,
  port: number,
): Promise<string> {
  const script = buildServeLaunchScript(dir, port)
  const res = await client.callTool("command_execute", {
    command: "sh",
    args: ["-c", script],
    cwd: dir,
    timeoutMs: 30_000,
  })
  const result = parseToolJson(res)
  const exitCode = typeof result?.exitCode === "number" ? result.exitCode : -1
  if (exitCode !== 0) {
    const stderr = typeof result?.stderr === "string" ? result.stderr : ""
    throw new Error(
      `box command_execute failed to launch the app server (exit ${exitCode})` +
        `${stderr ? `: ${stderr.trim()}` : ""}`,
    )
  }
  return typeof result?.stdout === "string" ? result.stdout.trim() : ""
}

/**
 * Run the whole in-box bootstrap against a booted sandbox host: resolve the
 * public URL, connect to the box daemon, install the app, seed the
 * allowlist, launch the detached server, and probe readiness. Every failure
 * returns `{ ok: false, message }` — never throws — so the spawn path can
 * surface a clean `sandbox_app_serve_failed` code.
 */
export async function startSandboxAppServe(
  host: SandboxServeHost,
  req: SandboxAppServeSpec,
  opts?: {
    probe?: ServeReadinessProbe
    /** Readiness window forwarded to `pollServeReady`. Default 15s. */
    timeoutMs?: number
    intervalMs?: number
    /** Client factory — injectable for tests; defaults to a real MCP
     *  connection against `host.mcpUrl`. */
    connect?: (mcpUrl: string) => Promise<BoxToolClient>
  },
): Promise<StartSandboxAppServeResult> {
  const port = req.port ?? DEFAULT_APP_SERVE_PORT
  let url: string | undefined = host.ports?.[port]
  if (url === undefined) {
    if (!host.expose) {
      return {
        ok: false,
        message:
          `sandbox app serve: port ${port} has no public URL — the sandbox ` +
          "provider resolved no extraPorts entry and has no expose() to expose it lazily.",
      }
    }
    try {
      url = (await host.expose(port)).url
    } catch (err) {
      return {
        ok: false,
        message:
          `sandbox app serve: exposing port ${port} failed — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  let client: BoxToolClient
  try {
    client = await (opts?.connect ?? connectBoxToolClient)(host.mcpUrl)
  } catch (err) {
    return {
      ok: false,
      message:
        `sandbox app serve: could not connect to the box daemon at ${host.mcpUrl} — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    }
  }

  try {
    const appId = await installApp(client, req.dir)
    await seedAllowlist(client)
    await launchServeProcess(client, req.dir, port)
    const ready = await pollServeReady(url, {
      ...(opts?.probe ? { probe: opts.probe } : {}),
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts?.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
    })
    return {
      ok: true,
      appServe: { appId, dir: req.dir, port, url, ready },
    }
  } catch (err) {
    return {
      ok: false,
      message:
        `sandbox app serve: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    await client.close().catch(() => undefined)
  }
}
