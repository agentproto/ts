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
 *   - MCP tools (agent_start, agent_prompt, …) are
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
import { randomUUID } from "node:crypto"
import * as childProc from "node:child_process"
import {
  readHost,
  isExpired,
  formatExpiry,
} from "../util/credentials.js"
import { refreshTunnelToken } from "../util/tunnel-token-refresh.js"
import { loadNodePtyFactory, type PtyFactory } from "../util/pty-factory.js"
import { loadConfig } from "@agentproto/runtime/config"
import { loadWorkspacesConfig } from "@agentproto/runtime/workspaces-config"
import { loadImportedMcps } from "@agentproto/runtime/mcp-imports"
import {
  createTunnelServer,
  wrapWebSocket,
  DEFAULT_WS_DIAL_TIMEOUT_MS,
  DEFAULT_HTTP_FORWARD_TIMEOUT_MS,
  type FrameSink,
} from "@agentproto/acp/tunnel"
import {
  createGateway,
  sweepStaleRuntimeMetas,
  sweepStaleDaemonRegistry,
  unlinkRuntimeMeta,
  injectProviderKeysIntoEnv,
  type AgentAdapterResolver,
  type GatewayHandle,
} from "@agentproto/runtime"
import { registerCatalogOverlay } from "@agentproto/model-catalog/overlay"
import { loadCachedCatalogVoices } from "../provider-catalog.js"
import { getBrowserAdapter, browserAdapters } from "@agentproto/adapter-browser"
import { createAgentCliRuntime } from "@agentproto/driver-agent-cli"
import { readHermesUsage } from "@agentproto/adapter-hermes"
import { driverSpec } from "@agentproto/driver"
import {
  resolveAdapter,
  listAdaptersWithCatalog,
} from "../registry/resolve.js"
import { CATALOG } from "../registry/catalog.js"
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
  /** Extra Origin patterns trusted to drive mutating /sessions/* routes
   *  + the PTY WS without a Bearer token. Localhost is always trusted
   *  by default; add production origins via repeatable `--allow-origin`. */
  allowedOrigins?: readonly string[]
  /** When true, drop the localhost-wildcard default. Only `allowedOrigins`
   *  is honoured. Useful for hardened / shared-host setups. */
  strictOrigins?: boolean
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
      "allow-origin": { type: "string", multiple: true },
      interactive: { type: "boolean", short: "i" },
      profile: { type: "string" },
    },
  })

  // Load ~/.agentproto/config.json once and fall back through it for
  // every knob below. Order: CLI flag → env var → config.json →
  // hardcoded default. Errors during read are non-fatal — the file
  // is optional. Resolves to an empty object when missing.
  const cfg = await loadConfig()

  // ── Profile resolution ─────────────────────────────────────────
  // `--profile <name>` (or `activeProfile` in config.json) picks a
  // named bundle from `profiles[name]` and shallow-merges it OVER the
  // top-level daemon/tunnel. A profile only needs to declare the
  // fields that differ from the top-level (typically tunnel.host +
  // tunnel.token); everything else falls through.
  //
  // Explicit `--profile <name>` is fatal if the profile doesn't
  // exist (better than silently using top-level defaults — that
  // path led to "why is it connecting to prod?" head-scratching).
  // An `activeProfile` pointing at a missing profile only warns,
  // since the user may have just deleted it.
  const profileName = values.profile ?? cfg.activeProfile
  const profile = profileName ? cfg.profiles?.[profileName] : undefined
  if (values.profile && !profile) {
    process.stderr.write(
      `agentproto serve: profile "${values.profile}" not found in ` +
        `~/.agentproto/config.json. Available: ${
          cfg.profiles ? Object.keys(cfg.profiles).join(", ") || "(none)" : "(no profiles block)"
        }\n`
    )
    return 2
  }
  if (cfg.activeProfile && !values.profile && !profile) {
    process.stderr.write(
      `agentproto serve: ⚠ activeProfile="${cfg.activeProfile}" but no matching ` +
        `entry in profiles[]; falling back to top-level config.\n`
    )
  }
  if (profile && process.stdout.isTTY) {
    process.stdout.write(
      `agentproto serve: using profile "${profileName}"\n`
    )
  }

  const cfgDaemon = { ...(cfg.daemon ?? {}), ...(profile?.daemon ?? {}) }
  const cfgTunnel = { ...(cfg.tunnel ?? {}), ...(profile?.tunnel ?? {}) }

  // Workspace defaults: --workspace > config.json > cwd. Validated
  // below — must exist + be a directory.
  const workspace = resolvePath(
    values.workspace ?? cfgDaemon.workspace ?? process.cwd(),
  )
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

  const port = values.port
    ? Number.parseInt(values.port, 10)
    : typeof cfgDaemon.port === "number"
      ? cfgDaemon.port
      : 18790
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    process.stderr.write(`agentproto serve: invalid --port "${values.port}".\n`)
    return 2
  }

  // Default label is informative — the host's UI shows it next to
  // every spawn so users know which laptop is executing what.
  const label = values.label ?? cfgDaemon.label ?? `${userInfo().username}@${hostname()}`

  // tunnel.host + tunnel.autoconnect from config feed --connect when
  // the user hasn't passed one. autoconnect=false leaves it CLI-only.
  const connectFlag =
    values.connect ??
    (cfgTunnel.autoconnect && cfgTunnel.host ? cfgTunnel.host : undefined)

  // Token resolution precedence:
  //   1. --token <jwt>            — explicit override
  //   2. $AGENTPROTO_TOKEN        — env, useful for CI / docker
  //   3. config.json `tunnel.token` (or profile.tunnel.token) — set
  //      via `agentproto config set tunnel.token` or hand-edited.
  //      Profiles use this so a per-environment token lives next to
  //      its host without the credentials.json host-key footgun.
  //   4. ~/.agentproto/credentials.json[host] — `agentproto auth login`
  //
  // Step 4 only applies when --connect is set (we have a host to look up).
  // An expired credential is renewed via a silent, ceremony-free refresh
  // (`refreshTunnelToken` → device-code engine's `refreshOnly` mode) when a
  // cached `refresh_token` makes that possible; otherwise we warn and fall
  // back to the stale token, letting the host reject the connect — a
  // clearer failure than a daemon that silently blocks on an interactive
  // ceremony (print code, open a browser, poll) it'll never get a response to.
  let token: string | undefined =
    values.token ?? process.env.AGENTPROTO_TOKEN ?? cfgTunnel.token
  if (!token && connectFlag) {
    const cred = await readHost(connectFlag)
    if (cred) {
      let refreshed: string | null = null
      if (isExpired(cred)) {
        refreshed = await refreshTunnelToken(connectFlag, cred)
        if (refreshed) {
          process.stdout.write(
            `agentproto serve: silently refreshed expired credentials for ${connectFlag}\n`
          )
        } else {
          process.stderr.write(
            `agentproto serve: ⚠ credentials for ${connectFlag} are expired (${formatExpiry(cred)}) and could not be silently refreshed. ` +
              `Re-run \`agentproto auth login --host ${connectFlag}\`.\n`
          )
        }
      }
      token = refreshed ?? cred.token
      if (!refreshed) {
        process.stdout.write(
          `agentproto serve: using token from credentials.json (${formatExpiry(cred)})\n`
        )
      }
    }
  }

  // `--allow-origin <url>` is repeatable. parseArgs gives us a string[]
  // when `multiple: true` is set. Origins are merged with config's
  // daemon.allowedOrigins so CLI flags ADD to (not replace) the config.
  const allowOriginRaw = values["allow-origin"]
  const cliOrigins = Array.isArray(allowOriginRaw) ? allowOriginRaw : []
  const cfgOrigins = Array.isArray(cfgDaemon.allowedOrigins)
    ? cfgDaemon.allowedOrigins
    : []
  const merged = [...new Set([...cfgOrigins, ...cliOrigins])]
  const allowedOrigins = merged.length > 0 ? merged : undefined

  const opts: ServeOpts = {
    workspace,
    port,
    bind: values.bind ?? cfgDaemon.bind ?? "127.0.0.1",
    ...(connectFlag ? { connect: connectFlag } : {}),
    ...(token ? { token } : {}),
    label,
    ...(allowedOrigins ? { allowedOrigins } : {}),
    ...(cfgDaemon.strictOrigins === true ? { strictOrigins: true } : {}),
  }

  // ── provider keys ──
  // Inject any keys stored via `agentproto auth provider set` into this
  // process's env BEFORE the gateway boots, so every spawned adapter
  // (mastra-agent's Mastra gateway, hermes/opencode routers) inherits
  // them. Explicit env always wins (a `FOO_API_KEY=… serve` or CI secret
  // is never overwritten). Best-effort; a missing/locked store is non-fatal.
  try {
    const injected = await injectProviderKeysIntoEnv(process.env)
    if (injected.length > 0) {
      process.stderr.write(
        `${color.dim}loaded ${injected.length} provider key(s) from store: ${injected.join(", ")}${color.reset}\n`,
      )
    }
  } catch {
    // providers.json missing / unreadable — env-only operation is fine.
  }

  // Live-on-setup catalog overlay: fold any cached provider catalogs
  // (~/.agentproto/catalog/*.json, written by `auth provider set`) over the
  // committed model-catalog baseline. AVAILABILITY only (account-specific
  // voices); pricing stays pinned in the package. Best-effort and additive.
  try {
    const voices = await loadCachedCatalogVoices()
    if (voices.length > 0) {
      registerCatalogOverlay({ voice: voices })
      process.stderr.write(
        `${color.dim}loaded ${voices.length} catalog voice(s) from live-on-setup cache${color.reset}\n`,
      )
    }
  } catch {
    // No cache / unreadable — the committed baseline serves on its own.
  }

  // ── adapter resolver (powers MCP agent_start) ──
  // Wires the cli's adapter registry into the gateway's
  // /sessions/agent route + the agent_start MCP tool.
  // When unwired, those routes return 501 with a clear message.
  const resolveAgentAdapter: AgentAdapterResolver = async slug => {
    try {
      const adapter = await resolveAdapter(slug)
      const runtime = createAgentCliRuntime(adapter.handle)
      return {
        async startSession({ cwd, resumeSessionId, mode, options, model, effort, mcpServers, onActivity }) {
          // Build config.options only when there's something to set — an
          // empty object would pass undefined validation but trips the
          // "no declared options" early-return in composeSpawn. Caller-
          // supplied `options` (AIP-45 option ids, e.g. hermes' `skills`)
          // seed the map first; the dedicated `model`/`effort` fields win
          // on collision since those have their own ACP-level handling
          // elsewhere and predate the generic `options` map.
          const optionOverrides: Record<string, boolean | number | string> = {
            ...options,
          }
          if (model) optionOverrides.model = model
          if (effort) optionOverrides.effort = effort
          // composeSpawn validates `mode` against the manifest's declared
          // `modes` and throws RuntimeConfigError on an unknown id — for an
          // adapter with no `modes` at all (hermes) that means ANY `mode`
          // value fails the spawn rather than being silently ignored, so
          // callers should only pass `mode` for adapters known to declare it.
          const config: {
            mode?: string
            options?: Record<string, boolean | number | string>
          } = {}
          if (mode) config.mode = mode
          if (Object.keys(optionOverrides).length > 0) config.options = optionOverrides
          return runtime.start({
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            ...(Object.keys(config).length > 0 ? { config } : {}),
            ...(mcpServers ? { mcpServers } : {}),
            ...(onActivity ? { onActivity } : {}),
          })
        },
        commandPreview:
          `${adapter.handle.bin} ${(adapter.handle.bin_args ?? []).join(" ")}`.trim(),
        ...(slug === "hermes" ? { readUsage: (sid: string) => readHermesUsage(sid) } : {}),
        declaredOptions: (adapter.handle.options ?? []).map(o => ({
          id: o.id,
          type: o.type,
        })),
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

  // ── pty factory ──
  // Resolved once at boot and shared between the local gateway (powers
  // POST /sessions/terminal + the four terminal_start MCP
  // tools + the WS /sessions/:id/pty bridge) AND the tunnel server
  // below (cloud-driven spawns with pty:true on the spawn frame).
  // When node-pty is missing, the factory is null and both paths
  // gracefully degrade — PTY routes return 501 / the tunnel rejects
  // pty:true spawns.
  const spawnPty = await loadNodePtyFactory()

  // ── browser adapter resolver + lister (powers MCP start_browser / browser_adapter_list) ──
  const resolveBrowserAdapter = (id: string) => getBrowserAdapter(id)
  const listBrowserAdapters = () =>
    Object.values(browserAdapters).map(a => ({
      id: a.id,
      name: a.name,
      description: a.description,
      defaultPort: a.defaultPort,
      location: a.location,
      install: a.install,
      config: a.config,
    }))

  // ── boot the gateway ──
  // Empty specs + noop buildAgent. The playground gateway script
  // still has its own setup for spec authoring + Mastra heartbeat.
  let gateway: GatewayHandle
  try {
    gateway = await createGateway({
      workspace: opts.workspace,
      port: opts.port,
      bind: opts.bind,
      specs: [driverSpec],
      name: "agentproto-serve",
      // BOOT.md is silly for a tunnel daemon — skip it.
      boot: false,
      resolveAgentAdapter,
      // Discovery for UIs / operators — `GET /adapters` + `adapter_list`
      // MCP tool. Starts from the bundled catalog so known adapters always
      // appear (with status "supported") even when not yet installed.
      listAgentAdapters: () => listAdaptersWithCatalog(CATALOG),
      resolveBrowserAdapter,
      listBrowserAdapters,
      ...(spawnPty ? { spawnPty } : {}),
      ...(opts.allowedOrigins
        ? { allowedOrigins: opts.allowedOrigins }
        : {}),
      ...(opts.strictOrigins ? { strictOrigins: true } : {}),
    })
  } catch (err) {
    process.stderr.write(
      `agentproto serve: gateway boot failed — ${
        err instanceof Error ? err.message : String(err)
      }\n`
    )
    return 1
  }

  // The capability set this daemon announces in its tunnel hello: the MCP
  // doctypes it serves PLUS the agent adapters installed on this machine.
  // The adapters are what differentiate one daemon from another (every daemon
  // registers the same base doctypes), so a multi-daemon host routes on them.
  // Computed once at boot — the adapter walk is cheap but not worth per-reconnect.
  const installedAdapterSlugs = await listAdaptersWithCatalog(CATALOG)
    .then(list => list.filter(a => a.status !== "supported").map(a => a.slug))
    .catch(() => [] as string[])
  const announcedTools = [
    ...new Set([...gateway.registered, ...installedAdapterSlugs]),
  ]

  printBootBanner({
    url: gateway.url,
    workspace: gateway.workspace,
    ptyEnabled: spawnPty != null,
    allowedOrigins: opts.allowedOrigins,
    strictOrigins: opts.strictOrigins === true,
    connect: opts.connect,
  })

  // ── stale runtime.json sweep ──
  // Other workspaces may carry leftover runtime.json files from
  // previous daemon processes that didn't shut down gracefully
  // (kill -9, crash, reboot). Their tokens are stale; the CLI's
  // discovery layer would otherwise pick them up and send wrong
  // tokens to THIS daemon, producing a confusing 401. Clean them
  // here at boot so the user doesn't have to.
  try {
    const wsConfig = await loadWorkspacesConfig()
    const paths = wsConfig.workspaces.map(w => w.path)
    const cleaned = await sweepStaleRuntimeMetas(paths, opts.workspace)
    if (cleaned.length > 0) {
      process.stderr.write(
        `${color.dim}cleaned ${cleaned.length} stale runtime.json file(s) (dead PID)${color.reset}\n`,
      )
    }
  } catch {
    // workspaces.json may not exist yet — no cleanup needed.
  }
  // Same sweep for the central daemon registry — a SIGKILLed daemon
  // leaves a dead-PID `<port>.json` there too, which discovery would
  // otherwise trust. Independent of workspaces.json, so it runs even
  // when no workspaces are registered.
  try {
    const cleaned = await sweepStaleDaemonRegistry(opts.port)
    if (cleaned.length > 0) {
      process.stderr.write(
        `${color.dim}cleaned ${cleaned.length} stale daemon registry entr${cleaned.length === 1 ? "y" : "ies"} (dead PID)${color.reset}\n`,
      )
    }
  } catch {
    // best-effort
  }

  // ── shutdown wiring (covers both local-only and tunnel modes) ──
  const aborter = new AbortController()
  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    process.stderr.write(
      `\n${color.dim}── shutting down (${signal}) ──${color.reset}\n`,
    )
    aborter.abort()
    await gateway.stop().catch(() => undefined)
    // Delete our own runtime.json so the next CLI invocation doesn't
    // discover it as a "live daemon". Best-effort — the next boot
    // would clean it up anyway via the sweep above.
    await unlinkRuntimeMeta(opts.workspace, opts.port).catch(() => undefined)
    process.exit(0)
  }
  process.once("SIGINT", () => void shutdown("SIGINT"))
  process.once("SIGTERM", () => void shutdown("SIGTERM"))
  // Terminal-window close / SSH-disconnect / logout → SIGHUP. Without
  // a handler, Node default-terminates the process which bypasses our
  // gateway.stop() — sessions.json then never gets the final flush.
  // Registry's `process.on("exit")` belt-and-suspenders catches it
  // too, but firing the same logical path here gives a clean shutdown
  // banner + tunnel teardown.
  process.once("SIGHUP", () => void shutdown("SIGHUP"))

  // ── interactive mode: chain into the watch TUI as a child ─────
  // Spawn `agentproto sessions --watch` in the same terminal,
  // inheriting stdio. When the child exits (q / Ctrl-C in the TUI),
  // we treat it as a shutdown request for the daemon too — running
  // the TUI WITHOUT a daemon underneath would just show "no
  // sessions" forever, which isn't what `serve --interactive`
  // promised. The user can still detach with Ctrl-] then q
  // (PTY-attach detach chord) to leave the TUI but keep the daemon
  // running — but a Ctrl-C / q in the watch view tears the lot.
  if (values.interactive) {
    process.stderr.write(
      `${color.dim}entering interactive monitor — q in the TUI to quit (daemon + TUI both).${color.reset}\n`,
    )
    // Use process.argv[0] (this node) + process.argv[1] (this script)
    // for the child so we don't depend on $PATH finding the right
    // shim. argv carries `sessions --watch` plus an env override so
    // the child discovers THIS daemon's URL + token directly without
    // re-walking workspaces.json.
    const childArgv = [process.argv[1] ?? "", "sessions", "--watch"]
    const child = childProc.spawn(process.execPath, childArgv, {
      stdio: "inherit",
      env: {
        ...process.env,
        AGENTPROTO_DAEMON_URL: gateway.url,
        // `gateway.token` is the per-boot daemon bearer (different
        // from `token`, which was the tunnel JWT). Without this, the
        // child's restart/kill calls would 401 against its own
        // parent — exactly the bug that closed --interactive after
        // any failed action.
        AGENTPROTO_DAEMON_TOKEN: gateway.token,
      },
    })
    await new Promise<void>(resolve => {
      child.once("exit", () => resolve())
      aborter.signal.addEventListener("abort", () => {
        try {
          child.kill("SIGTERM")
        } catch {
          /* ignore */
        }
      })
    })
    // TUI quit → tear daemon down. If the SIGINT handler already
    // started a shutdown (parent + child both saw Ctrl-C from the
    // same process group), skip — the handler will finish on its
    // own. Otherwise drive the shutdown ourselves. The
    // `shuttingDown` flag in the outer scope is the source of truth.
    if (!shuttingDown) {
      aborter.abort()
      await gateway.stop().catch(() => undefined)
      await unlinkRuntimeMeta(opts.workspace, opts.port).catch(() => undefined)
    }
    return 0
  }

  // ── local-only mode: nothing else to do ──
  if (!opts.connect) {
    // Banner already covered the "local-only" state. Just park.
    process.stderr.write(
      `${color.dim}Press Ctrl-C to stop.${color.reset}\n`,
    )
    await new Promise<void>(resolve => {
      aborter.signal.addEventListener("abort", () => resolve())
    })
    return 0
  }

  process.stderr.write(
    `${color.dim}tunnel · connecting to ${opts.connect} as '${opts.label}'…${color.reset}\n`,
  )

  let backoffMs = opts.reconnectMinMs ?? 1_000
  const backoffMax = opts.reconnectMaxMs ?? 30_000
  // Shared flag — flipped by the `reconnect_soon` handler inside
  // runOneTunnel to skip the 2s post-clean-close pause. Lets a host
  // doing a graceful preStop drain finish its rollover in ~2s instead
  // of the daemon's normal ~30s backoff (or even the 2s settle).
  const reconnectState = { immediate: false }
  while (!aborter.signal.aborted) {
    try {
      await runOneTunnel(
        opts,
        gateway,
        announcedTools,
        spawnPty,
        aborter.signal,
        reconnectState
      )
      backoffMs = opts.reconnectMinMs ?? 1_000 // success resets backoff
      if (reconnectState.immediate) {
        reconnectState.immediate = false
        // Host signaled graceful drain — skip the settle pause and
        // reconnect right away (the new replica is already listening).
        continue
      }
      // Brief pause before reconnecting even on a clean close. This prevents
      // an infinite reconnect fight when two daemon processes are running with
      // the same token — each close-then-reconnect gets a minimum delay rather
      // than spinning at CPU speed.
      await sleep(2_000, aborter.signal)
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
  announcedTools: readonly string[],
  spawnPty: PtyFactory | null,
  signal: AbortSignal,
  reconnectState: { immediate: boolean }
): Promise<void> {
  if (!opts.connect) throw new Error("runOneTunnel: --connect not set")
  const headers: Record<string, string> = {
    "user-agent": `agentproto/${__CLI_VERSION__}`,
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

  // Keep-alive: Cloud Run (and most reverse-proxies) close idle WebSocket
  // connections after ~5 minutes. Send a ping every 30s so the connection
  // stays alive between infrequent agent calls.
  const keepaliveInterval = setInterval(() => {
    try {
      sink.send({ t: "ping", nonce: randomUUID() })
    } catch {
      // sink already closing — the onClose handler below will clear us
    }
  }, 30_000)

  const server = createTunnelServer({
    sink,
    label: opts.label,
    pty: spawnPty !== null,
    ...(spawnPty ? { spawnPty } : {}),
    // Announce what this daemon serves (doctypes + installed agent adapters)
    // so a multi-daemon host can enumerate + route by capability.
    ...(announcedTools.length ? { tools: announcedTools } : {}),
    // Generic HTTP-relay upstream for tunnel `http_request` frames.
    // Cloud-side callers (e.g. the API's local-daemon filesystem
    // provider) can now route MCP JSON-RPC + any other HTTP through
    // the daemon without needing a public URL. We point at the local
    // gateway since that's where `/mcp`, `/sessions`, `/events` live.
    httpUpstream: gateway.url,
    // Forward bounds, stated explicitly so they're visible and tunable here
    // (the local gateway is fast, so the package defaults fit; bump these if
    // this daemon ever fronts a slower upstream):
    //  - connect + buffered-body / connect + stream-headers ceiling
    httpForwardTimeoutMs: DEFAULT_HTTP_FORWARD_TIMEOUT_MS,
    //  - WS upgrade dial ceiling
    wsDialTimeoutMs: DEFAULT_WS_DIAL_TIMEOUT_MS,
    // Bound a streaming forward against a silent upstream: if an SSE/ndjson
    // stream sends headers then stalls with no bytes for 2 min, end it instead
    // of holding the reqId open forever. The window resets per chunk, so a
    // well-behaved stream (events or heartbeat comments) is never cut — only a
    // genuinely dead upstream trips it.
    httpStreamIdleTimeoutMs: 120_000,
    // WS forwarding upstream — daemon dials the local gateway's WS
    // endpoints (/sessions/:id/pty, etc) and pipes frames to the host.
    // Used by the cloud tunnel pod so browsers on mobile can attach to
    // interactive PTY sessions even though the daemon is only reachable
    // through the host (not directly).
    dialUpstreamWs: async ({ url, protocols, headers, signal }) => {
      // Dial with the same `ws` lib already used for the host tunnel.
      // Resolve once we receive `open`; reject on `error` / `unexpected-response`.
      //
      // Origin gotcha: the daemon's own HTTP gateway requires Origin in
      // its allowlist for mutating + WS routes. When we self-dial here
      // (no browser in the path), `ws` doesn't set Origin and the
      // request gets 401'd by the daemon's own auth. Inject a loopback
      // Origin matching the URL — `http://127.0.0.1:*` is always in the
      // default allowlist.
      const upstreamHeaders: Record<string, string> = {
        ...(headers as Record<string, string> | undefined),
      }
      if (!upstreamHeaders["origin"] && !upstreamHeaders["Origin"]) {
        try {
          const u = new URL(url)
          const httpScheme = u.protocol === "wss:" ? "https:" : "http:"
          upstreamHeaders["Origin"] = `${httpScheme}//${u.host}`
        } catch {
          /* malformed url — daemon will reject with a clear error */
        }
      }
      return await new Promise((resolve, reject) => {
        const sock = new WebSocket(url, protocols ? [...protocols] : undefined, {
          headers: upstreamHeaders,
        })
        // The server bounds the dial and aborts via `signal` on timeout/teardown.
        // Honour it: tear down the half-open socket and reject promptly so we
        // don't leak a connecting socket.
        const onAbort = () => {
          sock.off("open", onceOpen)
          sock.off("error", onceError)
          sock.off("unexpected-response", onceUnexpected)
          try {
            sock.terminate()
          } catch {
            /* defensive — socket may already be closing */
          }
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new Error("ws dial aborted"),
          )
        }
        const detachAbort = () => signal?.removeEventListener("abort", onAbort)
        const onceOpen = () => {
          detachAbort()
          sock.off("error", onceError)
          sock.off("unexpected-response", onceUnexpected)
          resolve({
            protocol: sock.protocol ?? "",
            send: (data, sendOpts) => {
              sock.send(data, { binary: sendOpts.binary })
            },
            close: (code, reason) => {
              try {
                sock.close(code, reason)
              } catch {
                /* defensive — socket may already be closed */
              }
            },
            onMessage: handler => {
              sock.on("message", (raw: Buffer, isBinary: boolean) => {
                handler(raw, isBinary)
              })
            },
            onClose: handler => {
              sock.on("close", (code: number, reason: Buffer) => {
                handler(code, reason.toString("utf8"))
              })
            },
            onError: handler => {
              sock.on("error", (err: Error) => handler(err))
            },
          })
        }
        const onceError = (err: Error) => {
          detachAbort()
          sock.off("open", onceOpen)
          reject(err)
        }
        const onceUnexpected = (
          _req: unknown,
          res: { statusCode?: number }
        ) => {
          detachAbort()
          sock.off("open", onceOpen)
          reject(new Error(`Unexpected server response: ${res.statusCode ?? 0}`))
        }
        if (signal) {
          if (signal.aborted) {
            onAbort()
            return
          }
          signal.addEventListener("abort", onAbort, { once: true })
        }
        sock.once("open", onceOpen)
        sock.once("error", onceError)
        sock.once("unexpected-response", onceUnexpected)
      })
    },
    // Resolve a named WS upstream to a registered import's origin. A host
    // can watch a tab on an imported capability server (e.g. a browser
    // daemon) by aliasing the import instead of the default gateway — the
    // path rides the import's own origin (`http://127.0.0.1:<port>`), the
    // daemon never accepts a raw origin from the host.
    resolveWsUpstream: async alias => {
      const cfg = await loadImportedMcps()
      const entry = cfg.imports.find(e => e.alias === alias)
      const url = entry?.snapshot.url
      if (!url) return undefined
      try {
        return new URL(url).origin
      } catch {
        return undefined
      }
    },
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
    // Graceful drain hook — flip the outer loop's "reconnect immediately"
    // flag and close the WS so the supervisor reconnects without backoff.
    // Host will follow up with close(1012) ~2s later as a hard backstop.
    onReconnectSoon: ({ reasonMs }) => {
      process.stderr.write(
        `agentproto serve: host signaled drain (reasonMs=${reasonMs ?? "?"}) — reconnecting immediately\n`
      )
      reconnectState.immediate = true
      try {
        ws.close(1000, "host_drain")
      } catch {
        /* socket already closing */
      }
    },
  })

  // Block until the sink closes (peer disconnect or our shutdown).
  await new Promise<void>(resolve => {
    const offClose = sink.onClose(() => {
      clearInterval(keepaliveInterval)
      offClose()
      resolve()
    })
    if (signal.aborted) {
      clearInterval(keepaliveInterval)
      server.close().finally(() => resolve())
    }
    signal.addEventListener("abort", () => {
      clearInterval(keepaliveInterval)
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

/**
 * Boot banner. Single block so the user sees the whole "gateway up"
 * picture in one place, with subtle color when stdout is a TTY. The
 * old format was:
 *
 *   agentproto serve: gateway up on http://...
 *     workspace: /abs/path
 *     mcp:       http://.../mcp
 *     …
 *
 * What this prints instead:
 *
 *   ─ agentproto · gateway up · http://127.0.0.1:18790 ─
 *     workspace      /abs/path
 *     pty            enabled (node-pty)
 *     origins        localhost:* (default)
 *     endpoints      /mcp · /sessions · /events · /sessions/:id/pty (WS)
 *     mode           local-only
 */
function printBootBanner(opts: {
  url: string
  workspace: string
  ptyEnabled: boolean
  allowedOrigins?: readonly string[]
  strictOrigins?: boolean
  connect?: string
}): void {
  const c = color
  const home = process.env.HOME ?? ""
  const workspace =
    home && opts.workspace.startsWith(home)
      ? "~" + opts.workspace.slice(home.length)
      : opts.workspace
  const ptyState = opts.ptyEnabled
    ? `${c.green}enabled${c.reset} ${c.dim}(node-pty)${c.reset}`
    : `${c.amber}disabled${c.reset} ${c.dim}(install node-pty to enable)${c.reset}`
  let origins: string
  if (opts.strictOrigins) {
    origins =
      opts.allowedOrigins && opts.allowedOrigins.length > 0
        ? `${c.amber}STRICT${c.reset} ${opts.allowedOrigins.join(" · ")} ${c.dim}(localhost defaults disabled)${c.reset}`
        : `${c.red}STRICT · empty allowlist${c.reset} ${c.dim}(every Origin will 401 — only Bearer-token works)${c.reset}`
  } else {
    origins =
      opts.allowedOrigins && opts.allowedOrigins.length > 0
        ? opts.allowedOrigins.join(" · ") +
          ` ${c.dim}+ localhost (default)${c.reset}`
        : `${c.dim}localhost:* only (default)${c.reset}`
  }
  const mode = opts.connect
    ? `${c.cyan}tunnel${c.reset} ${c.dim}→ ${opts.connect}${c.reset}`
    : `${c.dim}local-only${c.reset}`
  const line = `${c.dim}─${c.reset}`
  process.stderr.write(
    `\n${line} ${c.bold}agentproto${c.reset} ${c.dim}·${c.reset} gateway up ${c.dim}·${c.reset} ${c.cyan}${opts.url}${c.reset} ${line}\n` +
      `  ${c.dim}workspace${c.reset}    ${workspace}\n` +
      `  ${c.dim}pty${c.reset}          ${ptyState}\n` +
      `  ${c.dim}origins${c.reset}      ${origins}\n` +
      `  ${c.dim}endpoints${c.reset}    /mcp · /sessions · /events · /sessions/:id/pty ${c.dim}(WS)${c.reset}\n` +
      `  ${c.dim}mode${c.reset}         ${mode}\n` +
      `\n`,
  )
}

/**
 * Tiny ANSI palette gated on stdout being a TTY. Writing colors into
 * a logfile (launchd `StandardOutPath`) would litter the file with
 * `\x1b[…m` noise; this strips when piped.
 */
const _isTty = !!(process.stderr as NodeJS.WriteStream).isTTY
const color = _isTty
  ? {
      reset: "\x1b[0m",
      bold: "\x1b[1m",
      dim: "\x1b[2m",
      green: "\x1b[32m",
      amber: "\x1b[33m",
      cyan: "\x1b[36m",
      red: "\x1b[31m",
    }
  : {
      reset: "",
      bold: "",
      dim: "",
      green: "",
      amber: "",
      cyan: "",
      red: "",
    }
