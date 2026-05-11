/**
 * `agentproto serve [--workspace <dir>] [--port <n>] [--connect <wss>]`
 *
 * The single canonical agentproto daemon. Boots a local gateway
 * (HTTP + MCP server + sessions registry + workspace fs +
 * heartbeat) on `--port` (default 18790), and OPTIONALLY opens an
 * outbound WebSocket tunnel to a host (Guilde-shaped API) when
 * `--connect <url>` is set. With or without the tunnel:
 *
 *   - HTTP /sessions, /sessions/agent, /sessions/:id/* routes work
 *   - MCP tools (start_agent_session, prompt_agent_session, …) are
 *     reachable via the daemon's /mcp transport
 *   - the LocalDaemonSessionsCard in guilde-web sees every spawn
 *
 * When the tunnel is up, every tunnel-driven spawn is also adopted
 * into the gateway's sessions registry via the
 * `createTunnelServer.onChildSpawned` hook, so an operator
 * dispatching from the cloud lands in the same /sessions list as a
 * user spawning locally — single source of truth for what's running
 * on the user's machine.
 *
 * Replaces the old `playground/scripts/gateway.ts` for production
 * use (the playground keeps its own script for the MCP CRUD
 * doctype demo). v1 reuses createGateway with empty specs + a
 * noop heartbeat; the playground variant adds toolSpec/agentSpec/
 * etc. for its specific spec-authoring use case.
 *
 * Reconnect-with-backoff is built in for the tunnel. The local
 * gateway stays up across reconnects — only the tunnel cycles.
 *
 * Authorization: v0 trusts every spawn frame the host sends — there
 * is no policy file. Future work will gate spawn requests on a
 * `~/.agentproto/policy.toml` allowlist (see project_agentproto_repos
 * memory). The token is the only access control today.
 */

import { parseArgs } from "node:util"
import { hostname, userInfo } from "node:os"
import { resolve as resolvePath } from "node:path"
import { promises as fs } from "node:fs"
import {
  readHost,
  isExpired,
  formatExpiry,
} from "../util/credentials.js"
import {
  createTunnelServer,
  wrapWebSocket,
  type FrameSink,
} from "@agentproto/acp/tunnel"
import {
  createGateway,
  type AgentAdapterResolver,
  type GatewayHandle,
} from "@agentproto/runtime"
import { createAgentCliRuntime } from "@agentproto/driver-agent-cli"
import {
  resolveAdapter,
  listInstalledAdapters,
} from "../registry/resolve.js"
import WebSocket from "ws"

interface ServeOpts {
  /** Workspace dir. Defaults to cwd. */
  workspace: string
  /** Local HTTP port. Default 18790. */
  port: number
  /** Bind addr. Default 127.0.0.1. */
  bind: string
  /** Optional cloud WS URL. When unset, daemon runs local-only. */
  connect?: string
  token?: string
  label: string
  /** Initial reconnect delay in ms; doubled on each failure up to 30s. */
  reconnectMinMs?: number
  reconnectMaxMs?: number
}

export async function runServe(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      connect: { type: "string", short: "c" },
      token: { type: "string", short: "t" },
      label: { type: "string", short: "l" },
      workspace: { type: "string", short: "w" },
      port: { type: "string", short: "p" },
      bind: { type: "string", short: "b" },
    },
  })

  // Workspace defaults to cwd. Validated below — must exist + be a
  // directory (createGateway throws on missing, but a clearer
  // message at this layer beats the stack trace).
  const workspace = resolvePath(values.workspace ?? process.cwd())
  try {
    const stat = await fs.stat(workspace)
    if (!stat.isDirectory()) {
      process.stderr.write(
        `agentproto serve: --workspace "${workspace}" is not a directory.\n`
      )
      return 2
    }
  } catch {
    process.stderr.write(
      `agentproto serve: --workspace "${workspace}" does not exist.\n` +
        `  Create it first: mkdir -p "${workspace}"\n`
    )
    return 2
  }

  const port = values.port ? Number.parseInt(values.port, 10) : 18790
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    process.stderr.write(`agentproto serve: invalid --port "${values.port}".\n`)
    return 2
  }

  // Default label is informative — the host's UI shows it next to
  // every spawn so users know which laptop is executing what.
  const label = values.label ?? `${userInfo().username}@${hostname()}`

  // Token resolution precedence:
  //   1. --token <jwt>            — explicit override
  //   2. $AGENTPROTO_TOKEN        — env, useful for CI / docker
  //   3. ~/.agentproto/credentials.json[host] — `agentproto auth login`
  //
  // Step 3 only applies when --connect is set (we have a host to look
  // up) and the credential isn't expired. Expiry is non-fatal: we log
  // a warning and let the host reject the connect; that surfaces a
  // clearer error than a silent 401 mid-tunnel.
  let token: string | undefined = values.token ?? process.env.AGENTPROTO_TOKEN
  if (!token && values.connect) {
    const cred = await readHost(values.connect)
    if (cred) {
      if (isExpired(cred)) {
        process.stderr.write(
          `agentproto serve: ⚠ credentials for ${values.connect} are expired (${formatExpiry(cred)}). ` +
            `Re-run \`agentproto auth login --host ${values.connect}\`.\n`
        )
      }
      token = cred.token
      process.stdout.write(
        `agentproto serve: using token from credentials.json (${formatExpiry(cred)})\n`
      )
    }
  }

  const opts: ServeOpts = {
    workspace,
    port,
    bind: values.bind ?? "127.0.0.1",
    ...(values.connect ? { connect: values.connect } : {}),
    ...(token ? { token } : {}),
    label,
  }

  // ── adapter resolver (powers MCP start_agent_session) ──
  // Wires the cli's adapter registry into the gateway's
  // /sessions/agent route + the start_agent_session MCP tool.
  // When unwired, those routes return 501 with a clear message.
  const resolveAgentAdapter: AgentAdapterResolver = async slug => {
    try {
      const adapter = await resolveAdapter(slug)
      const runtime = createAgentCliRuntime(adapter.handle)
      return {
        async startSession({ cwd }) {
          return runtime.start({ cwd })
        },
        commandPreview:
          `${adapter.handle.bin} ${(adapter.handle.bin_args ?? []).join(" ")}`.trim(),
      }
    } catch (err) {
      console.warn(
        `[agentproto serve] resolveAgentAdapter('${slug}') failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return null
    }
  }

  // ── boot the gateway ──
  // Empty specs + noop buildAgent. The playground gateway script
  // still has its own setup for spec authoring + Mastra heartbeat.
  let gateway: GatewayHandle
  try {
    gateway = await createGateway({
      workspace: opts.workspace,
      port: opts.port,
      bind: opts.bind,
      specs: [],
      name: "agentproto-serve",
      // BOOT.md is silly for a tunnel daemon — skip it.
      boot: false,
      resolveAgentAdapter,
      // Discovery for UIs / operators — `GET /adapters` + `list_adapters`
      // MCP tool. Walks node_modules @agentproto/adapter-* on each call;
      // cheap enough that we don't bother caching here.
      listAgentAdapters: listInstalledAdapters,
    })
  } catch (err) {
    process.stderr.write(
      `agentproto serve: gateway boot failed — ${
        err instanceof Error ? err.message : String(err)
      }\n`
    )
    return 1
  }

  process.stderr.write(
    `agentproto serve: gateway up on ${gateway.url}\n` +
      `  workspace: ${gateway.workspace}\n` +
      `  mcp:       ${gateway.url}/mcp\n` +
      `  sessions:  ${gateway.url}/sessions\n` +
      `  events:    ${gateway.url}/events\n`
  )

  // ── shutdown wiring (covers both local-only and tunnel modes) ──
  const aborter = new AbortController()
  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    process.stderr.write(`\nagentproto serve: ${signal} — shutting down.\n`)
    aborter.abort()
    await gateway.stop().catch(() => undefined)
    process.exit(0)
  }
  process.once("SIGINT", () => void shutdown("SIGINT"))
  process.once("SIGTERM", () => void shutdown("SIGTERM"))

  // ── local-only mode: nothing else to do ──
  if (!opts.connect) {
    process.stderr.write(
      `agentproto serve: running local-only (no --connect). Press Ctrl-C to stop.\n`
    )
    // Park indefinitely until shutdown signal.
    await new Promise<void>(resolve => {
      aborter.signal.addEventListener("abort", () => resolve())
    })
    return 0
  }

  // ── tunnel mode: connect-loop + onChildSpawned bridge ──
  process.stderr.write(
    `agentproto serve: tunnel — connecting to ${opts.connect} as '${opts.label}'…\n`
  )

  let backoffMs = opts.reconnectMinMs ?? 1_000
  const backoffMax = opts.reconnectMaxMs ?? 30_000
  while (!aborter.signal.aborted) {
    try {
      await runOneTunnel(opts, gateway, aborter.signal)
      backoffMs = opts.reconnectMinMs ?? 1_000 // success resets backoff
    } catch (err) {
      if (aborter.signal.aborted) break
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(
        `agentproto serve: tunnel error: ${msg}\n  reconnecting in ${backoffMs}ms…\n`
      )
      await sleep(backoffMs, aborter.signal)
      backoffMs = Math.min(backoffMs * 2, backoffMax)
    }
  }

  return 0
}

/**
 * One end-to-end tunnel attempt. Resolves when the socket closes
 * cleanly (host hung up); rejects on connection error or unexpected
 * close. The reconnect loop catches both and retries.
 */
async function runOneTunnel(
  opts: ServeOpts,
  gateway: GatewayHandle,
  signal: AbortSignal
): Promise<void> {
  if (!opts.connect) throw new Error("runOneTunnel: --connect not set")
  const headers: Record<string, string> = {
    "user-agent": "agentproto/0.1.0-alpha",
  }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`

  const ws = new WebSocket(opts.connect, { headers })

  // Wait for OPEN (or fail).
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.off("error", onError)
      resolve()
    }
    const onError = (err: Error) => {
      ws.off("open", onOpen)
      reject(err)
    }
    ws.once("open", onOpen)
    ws.once("error", onError)
    if (signal.aborted) {
      ws.close()
      reject(new Error("Aborted before WS opened."))
    }
    signal.addEventListener("abort", () => {
      ws.close()
      reject(new Error("Aborted while WS connecting."))
    })
  })

  process.stderr.write(`agentproto serve: tunnel up.\n`)

  const sink: FrameSink = wrapWebSocket(ws as unknown as Parameters<typeof wrapWebSocket>[0])
  const server = createTunnelServer({
    sink,
    label: opts.label,
    pty: false,
    // Generic HTTP-relay upstream for tunnel `http_request` frames.
    // Cloud-side callers (e.g. the API's local-daemon filesystem
    // provider) can now route MCP JSON-RPC + any other HTTP through
    // the daemon without needing a public URL. We point at the local
    // gateway since that's where `/mcp`, `/sessions`, `/events` live.
    httpUpstream: gateway.url,
    // v0 authorize hook: trust the bearer-authenticated host completely.
    // Token possession proves the host was provisioned for this daemon.
    // Per-spawn policy filtering will land alongside the policy.toml.
    authorize: req => req,
    // ── AIP-46 bridge: tunnel spawns land in the gateway registry ──
    // Every cloud-driven spawn shows up in `gateway.url/sessions`
    // and the LocalDaemonSessionsCard, alongside spawns originated
    // through MCP tools or POST /sessions/agent. The execId is the
    // host's stable id — keep it so cloud cli_sessions rows can
    // cross-ref the daemon-side descriptor.
    onChildSpawned: ({ execId, child, request }) => {
      gateway.sessions.register({
        id: execId,
        child,
        workspaceSlug: opts.label,
        command: [request.command, ...request.args].join(" "),
        kind: "agent-cli",
        label: `tunnel: ${request.command.split("/").pop() ?? request.command}`,
      })
    },
  })

  // Block until the sink closes (peer disconnect or our shutdown).
  await new Promise<void>(resolve => {
    const offClose = sink.onClose(() => {
      offClose()
      resolve()
    })
    if (signal.aborted) {
      server.close().finally(() => resolve())
    }
    signal.addEventListener("abort", () => {
      server.close().finally(() => resolve())
    })
  })

  process.stderr.write(`agentproto serve: tunnel closed.\n`)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
