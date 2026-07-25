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
import {
  makeWorktreeProvisioner,
  makeWorktreeStatusLister,
  makeWorktreeGcRunner,
  makeOpenPrResolver,
  makePrStateResolver,
} from "./worktree.js"
import { loadConfig } from "@agentproto/runtime/config"
import {
  loadWorkspacesConfig,
  findWorkspaceByPath,
} from "@agentproto/runtime/workspaces-config"
import {
  createTunnelServer,
  wrapWebSocket,
  connectSinkE2E,
  type FrameSink,
  type E2eFrameSink,
} from "@agentproto/acp/tunnel"
import {
  startTunnelHandshake,
  encodeTunnelMessage,
  decodeTunnelAccept,
} from "@agentproto/secrets/pairing"
import {
  createGateway,
  createPairingRegistry,
  createReconnectLogGate,
  sweepStaleRuntimeMetas,
  sweepStaleDaemonRegistry,
  resolveBucketSlug,
  unlinkRuntimeMeta,
  injectProviderKeysIntoEnv,
  setMcpCredentialDeps,
  type AgentAdapterResolver,
  type AdapterAuthDescriptor,
  type GatewayHandle,
  type PairingRegistry,
  type PairingChannelHandle,
} from "@agentproto/runtime"
import { CatalogProviderSchema } from "@agentproto/model-catalog"
import { loadOrCreateIdentity } from "@agentproto/secrets/identity"
import { buildDaemonTunnelServerOptions } from "../util/tunnel-serve.js"
import { homedir } from "node:os"
import { join as joinPath } from "node:path"
import {
  CredentialBroker,
  KeychainStore,
  getAuthProvider,
  registerAuthProvider,
} from "@agentproto/auth"
import {
  buildBrokerProvider,
  loadAuthProviders,
} from "../util/auth-providers-store.js"
import { registerCatalogOverlay } from "@agentproto/model-catalog/overlay"
import { loadCachedCatalogVoices } from "../provider-catalog.js"
import { getBrowserAdapter, browserAdapters } from "@agentproto/adapter-browser"
import { createAgentCliRuntime } from "@agentproto/driver-agent-cli"
import { readHermesUsage } from "@agentproto/adapter-hermes"
import { driverSpec } from "@agentproto/driver"
import {
  resolveAdapter,
  listAdaptersWithCatalog,
  listAdaptersWithAcp,
  listHarnessCapabilities,
} from "../registry/resolve.js"
import { installAdapter } from "../registry/install-driver.js"
import { listCatalogModelsFromInstalled } from "../registry/catalog-models.js"
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
  /** Bearer token gating the gateway at boot. When set, the daemon
   *  starts already gated (mode "bearer") instead of the default
   *  open (mode "none") — no `remote_enable` call needed, and the
   *  token is stable across restarts. See `daemon.authToken` in
   *  config.json. */
  authToken?: string
  /** Opt into E2E-encrypting the outbound tunnel (config `tunnel.e2e`). When
   *  set (and a `token` is present), the daemon negotiates a token-authenticated
   *  handshake with the host and wraps the tunnel in an AEAD box. Falls back to
   *  plaintext against a host that doesn't advertise e2e. */
  e2e?: boolean
}

const SERVE_USAGE = `agentproto serve — run the local agentproto daemon

Usage:
  agentproto serve [options]

Options:
  --profile <name>            bundle from ~/.agentproto/config.json profiles[]
  --workspace <dir>           workspace root (default: cwd)
  --port <n>                  local HTTP port (default: 18790)
  --bind <ip>                 bind address (default: 127.0.0.1)
  --connect <url>             cloud WS URL to relay spawns to (default: off)
  --token <jwt>               tunnel auth token (or $AGENTPROTO_TOKEN, or config)
  --label <name>              host label shown in the cloud UI
  --allow-origin <url>        trusted Origin (repeatable; localhost always trusted)
  --auth-token <token>        bearer token gating the gateway (or config daemon.authToken)
  --interactive, -i           interactive mode
  --help, -h                  print this usage and exit

Boots the local gateway (HTTP + MCP server + sessions registry) on --port.
With --connect, also opens an outbound WS tunnel to the host so cloud-driven
spawns land in the same /sessions list as local ones.

Examples:
  agentproto serve                                   # local-only daemon on :18790
  agentproto serve --connect wss://guilde.work/api/v1/agentproto/tunnel
  agentproto serve --profile prod --workspace ~/code/my-app
`

export async function runServe(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(SERVE_USAGE)
    return 0
  }
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
      "auth-token": { type: "string" },
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

  // Auth token: --auth-token > config.json daemon.authToken. Unset ⇒
  // no `authToken` in ServeOpts ⇒ gateway boots with auth mode "none",
  // identical to today's behaviour. This is independent of `remote_enable`
  // (RemoteController's ephemeral quick-tunnel token), which still wins
  // when active — see the `auth` getter passed to `createGateway` in
  // `@agentproto/runtime`.
  const authToken = values["auth-token"] ?? cfgDaemon.authToken

  const opts: ServeOpts = {
    workspace,
    port,
    bind: values.bind ?? cfgDaemon.bind ?? "127.0.0.1",
    ...(connectFlag ? { connect: connectFlag } : {}),
    ...(token ? { token } : {}),
    label,
    ...(allowedOrigins ? { allowedOrigins } : {}),
    ...(cfgDaemon.strictOrigins === true ? { strictOrigins: true } : {}),
    ...(authToken ? { authToken } : {}),
    ...(cfgTunnel.e2e === true ? { e2e: true } : {}),
  }

  // E2E requested but no token to authenticate the handshake against — the
  // whole scheme binds to the shared `tunnel.token`, so without one we cannot
  // encrypt. Warn and stay plaintext (the connect itself needs a bearer anyway,
  // so this is a misconfiguration guard, not a normal path).
  if (opts.e2e && !opts.token) {
    process.stderr.write(
      `agentproto serve: ⚠ tunnel.e2e is set but no tunnel token is available — ` +
        `E2E needs the shared token to authenticate. Continuing without encryption.\n`,
    )
    delete opts.e2e
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
      // Project the manifest's billing-auth fields into the descriptor the
      // runtime resolver reads (DECISION 3). `provider` is validated against
      // the catalog enum here (the driver types it as a plain string to stay
      // catalog-decoupled) — an unrecognized value narrows to undefined so the
      // resolver falls back to model-derivation rather than trusting a typo.
      const providerParse = adapter.handle.provider
        ? CatalogProviderSchema.safeParse(adapter.handle.provider)
        : undefined
      const authDescriptor: AdapterAuthDescriptor = {
        ...(providerParse?.success ? { provider: providerParse.data } : {}),
        ...(adapter.handle.authEnforce ? { authEnforce: adapter.handle.authEnforce } : {}),
        ...(adapter.handle.authSubscription
          ? { authSubscription: adapter.handle.authSubscription }
          : {}),
        ...(adapter.handle.modelDerivedApiKey
          ? { modelDerivedApiKey: adapter.handle.modelDerivedApiKey }
          : {}),
      }
      return {
        async startSession({ cwd, resumeSessionId, mode, options, model, effort, posture, contextProfile, mcpServers, onActivity, permissionHold, auth, commandSandbox }) {
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
            ...(permissionHold ? { permissionHold: true } : {}),
            ...(auth ? { auth } : {}),
            ...(typeof posture === "string" ? { posture } : {}),
            ...(contextProfile ? { contextProfile } : {}),
            ...(commandSandbox ? { commandSandbox } : {}),
          })
        },
        commandPreview:
          `${adapter.handle.bin} ${(adapter.handle.bin_args ?? []).join(" ")}`.trim(),
        ...(slug === "hermes" ? { readUsage: (sid: string) => readHermesUsage(sid) } : {}),
        declaredOptions: (adapter.handle.options ?? []).map(o => ({
          id: o.id,
          type: o.type,
        })),
        authDescriptor,
        ...(adapter.handle.models?.default
          ? { defaultModel: adapter.handle.models.default }
          : {}),
        ...(adapter.handle.capabilities?.resumable !== undefined
          ? { resumable: adapter.handle.capabilities.resumable }
          : {}),
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

  // ── MCP credential broker (dependency-injected into runtime) ──
  // Runtime is intentionally auth-free; the CLI wires the broker here
  // so `agent_start.mcpServers[].credentialRef` resolves to an
  // Authorization header at spawn time. Failures (missing provider,
  // no keychain on non-macOS, expired credential) are caught by the
  // runtime overlay and logged as warnings — they never kill a spawn.
  const credentialBroker = new CredentialBroker({
    store: new KeychainStore(),
    getProvider: getAuthProvider,
  })
  // Re-register persisted broker auth-providers (`agentproto auth cred set …`)
  // onto the module-level registry the broker looks up by id — an unregistered
  // id throws, so without this every `credentialRef` would fail. Non-fatal: a
  // malformed def is skipped with a warning, never blocking daemon boot.
  try {
    const { providers } = await loadAuthProviders()
    for (const [id, def] of Object.entries(providers)) {
      try {
        registerAuthProvider(buildBrokerProvider(id, def))
      } catch (err) {
        console.warn(
          `[serve] skipping broker auth-provider "${id}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
  } catch (err) {
    console.warn(
      `[serve] could not load broker auth-providers: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  setMcpCredentialDeps({
    resolveMcpCredentialHeaders: ({ credentialRef, signal }) =>
      credentialBroker.resolveHeaders({
        path: credentialRef,
        audience: "mcp",
        signal,
      }),
    // Sandbox env-slug resolution (`agent_start.sandbox` inline specs'
    // `env.passthrough` / `env.auth.state.env`): resolve against the DAEMON
    // process's own environment — an explicit host decision, not the
    // `@agentproto/sandbox` default (`session-spawn.ts` deliberately never
    // falls back on its own). The operator who started `agentproto serve`
    // controls this env (e.g. CI exports CLAUDE_CODE_OAUTH_TOKEN /
    // GITHUB_TOKEN for the e2b reviewer box); a missing slug still fails the
    // boot loudly upstream.
    resolveSandboxSecret: async (slug) => process.env[slug] ?? null,
  })

  // ── E2E pairing registry ──
  // Built BEFORE createGateway (so it can wire the /pairings REST routes + the
  // pair_* MCP tools) but its `serve` callback captures `gateway` by reference
  // — invoked only at splice time, well after boot, so the binding is set. The
  // registry owns the crypto (offer store, handshake, pairings.json); the CLI
  // injects the ws `dial` and a `serve` that reuses the SAME createTunnelServer
  // config as `--connect` (buildDaemonTunnelServerOptions), plus the daemon's
  // own bearer so a peer-authenticated pairing passes mutating-route gates.
  // Identity is loaded lazily — a daemon that never pairs writes no identity file.
  const agentprotoHome =
    process.env.AGENTPROTO_HOME ?? joinPath(homedir(), ".agentproto")
  const cfgPairing = cfg.pairing ?? {}
  let gateway: GatewayHandle
  const servePairedChannel = (sink: E2eFrameSink): PairingChannelHandle => {
    const server = createTunnelServer({
      sink,
      ...buildDaemonTunnelServerOptions({
        gateway,
        label: opts.label,
        spawnPty,
        announcedTools,
        // Inject the gateway's per-boot bearer so mutating /sessions routes
        // (no loopback bypass) work over the peer-authenticated pairing.
        injectAuthToken: gateway.token,
      }),
    })
    return { close: () => server.close() }
  }
  const pairingRegistry: PairingRegistry = createPairingRegistry({
    loadIdentity: () => loadOrCreateIdentity(joinPath(agentprotoHome, "identity.json")),
    pairingsPath: joinPath(agentprotoHome, "pairings.json"),
    // Pass `pairing.rendezvous` through verbatim, including "" — the registry
    // treats an explicit "" as an opt-out from the hosted default (an absent
    // key falls back to it). Coercing "" away here would silently re-enable it.
    ...(cfgPairing.rendezvous !== undefined
      ? { defaultRendezvousUrl: cfgPairing.rendezvous }
      : {}),
    dial: daemonDialRendezvous,
    serve: servePairedChannel,
    log: line => process.stderr.write(`${color.dim}${line}${color.reset}\n`),
  })

  // ── idempotent boot ──
  // Empty specs + noop buildAgent. The playground gateway script
  // still has its own setup for spec authoring + Mastra heartbeat.
  //
  // Before binding, preflight `<url>/health`: if a healthy daemon already
  // owns this bind+port, a second `serve` is a redundant launch (a
  // hand-relaunch, a `pnpm dev` spawning one, or a launchd respawn racing the
  // incumbent). We exit 0 cleanly instead of colliding on EADDRINUSE — which,
  // under `KeepAlive`-style supervision, otherwise crash-loops. If the bind
  // still races (two serves launched near-simultaneously, both past the
  // preflight), `bootGatewayIdempotent` re-probes on EADDRINUSE and defers to
  // the winner rather than failing.
  const probeHost =
    opts.bind === "0.0.0.0" || opts.bind === "::" ? "127.0.0.1" : opts.bind
  const healthUrl = `http://${probeHost}:${opts.port}`
  const bootOutcome = await bootGatewayIdempotent({
    healthUrl,
    probe: probeHealthyDaemon,
    boot: () =>
      createGateway({
        pairingRegistry,
        workspace: opts.workspace,
        port: opts.port,
        bind: opts.bind,
        specs: [driverSpec],
        name: "agentproto-serve",
        // BOOT.md is silly for a tunnel daemon — skip it.
        boot: false,
        // Opt-in eager resume-on-boot (§5, PR-4). Resolved from
        // daemon.resumeSessionsOnBoot (profile-overlaid). Off ⇒ the handle
        // method short-circuits and only lazy resume-on-prompt applies.
        resumeSessionsOnBoot: cfgDaemon.resumeSessionsOnBoot === true,
        // Idle agent-session reaper (PR-6). Resolution order mirrors the config
        // module docblock: AGENTPROTO_IDLE_REAP_AFTER_MS env > config field >
        // off. A positive ms value arms the periodic sweep; anything else keeps
        // it off (0), so idle sessions are never auto-retired unless opted in.
        idleReapAfterMs: resolveIdleReapAfterMs(cfgDaemon.idleReapAfterMs),
        // Crash-detect sweep (crash-detect PR-1). DEFAULT ON: resolution order
        // mirrors idleReapAfterMs's comment above (env > config field), but an
        // unset value here passes `undefined` through so createGateway applies
        // its own sane default rather than reading "unset" as off.
        crashDetectIntervalMs: resolveCrashDetectIntervalMs(cfgDaemon.crashDetectIntervalMs),
        // Restart-sweep tick (restart-scheduler PR-2). OFF by default —
        // resolution order mirrors idleReapAfterMs's comment above (env >
        // config field > off).
        restartSweepIntervalMs: resolveRestartSweepIntervalMs(cfgDaemon.restartSweepIntervalMs),
        resolveAgentAdapter,
        // Injected port behind `agent_start.worktree` + the `worktrees.isolation`
        // policy: runs `worktree.provision` over @agentproto/worktree, a dep the
        // runtime deliberately doesn't take (so it's wired here, at the daemon's
        // composition root).
        provisionWorktree: makeWorktreeProvisioner(),
        // Injected port behind `worktree_status` + `GET /worktrees`: runs the
        // `listWorktreeStatuses` join over @agentproto/worktree, same dep
        // reasoning as above.
        listWorktreeStatuses: makeWorktreeStatusLister(),
        // Injected port behind `worktree_gc` + `POST /worktrees/gc`: runs the
        // `planGc` / `applyGc` engine over @agentproto/worktree (defaults to a
        // dry run), same dep reasoning as above.
        runWorktreeGc: makeWorktreeGcRunner(),
        // Injected port behind the daemon PR-provenance reconciler: resolves the
        // open PR for a session's branch (branch→PR over @agentproto/worktree),
        // so an executor's PR gets the provenance footer even though it opened it
        // through its own shell, not command_execute.
        resolveOpenPr: makeOpenPrResolver(),
        // Injected port behind the Activity projector's PR settlement pass:
        // resolves a PR url's forge state (gh-backed, same dep reasoning as
        // above), so a pending-on-forge `pr` activity settles to done/cancelled
        // once the PR is merged/closed.
        resolvePrState: makePrStateResolver(),
        // Discovery for UIs / operators — `GET /adapters` + `adapter_list`
        // MCP tool. Starts from the bundled catalog so known adapters always
        // appear (with status "supported") even when not yet installed, and
        // appends the generic ACP agents (curated ACP_CATALOG + a user's
        // config.acpAgents) so a zero-code ACP CLI is discoverable too.
        listAgentAdapters: () => listAdaptersWithAcp(CATALOG),
        // Harness capability-discovery — the `harness_capabilities` MCP tool.
        // What each installed adapter can actually DO on this host (creds
        // present, reachable providers, model-discovery mechanism, endpoint
        // compat, model/posture application), complementing the static
        // manifest fields `listAgentAdapters` surfaces.
        listHarnessCapabilities: (opts) => listHarnessCapabilities(opts),
        // Mutation companion to `listAgentAdapters` — `POST /adapters/:slug/
        // install` + the `adapter_install` MCP tool. Drives npm-global for
        // acp-catalog CLIs and the manifest install[] pipeline for first-party
        // adapters (see install-driver.ts). Lets the VS Code Harnesses panel
        // install a not-yet-ready harness inline.
        installAgentAdapter: (slug: string) => installAdapter(slug),
        // Read-only catalog/vendor endpoint (SPEC §5) — `GET /catalog/models`
        // + `catalog_models` MCP tool. Joins the same installed-adapter
        // listing `listAgentAdapters` uses with the real named-profile store.
        listCatalogModels: query => listCatalogModelsFromInstalled(query),
        resolveBrowserAdapter,
        listBrowserAdapters,
        ...(spawnPty ? { spawnPty } : {}),
        ...(opts.allowedOrigins
          ? { allowedOrigins: opts.allowedOrigins }
          : {}),
        ...(opts.strictOrigins ? { strictOrigins: true } : {}),
        ...(opts.authToken
          ? { auth: { mode: "bearer" as const, token: opts.authToken } }
          : {}),
      }),
  })
  if (bootOutcome.kind === "peer-up") {
    process.stdout.write(
      `agentproto serve: a healthy daemon already owns ${bootOutcome.url} — nothing to do\n`,
    )
    return 0
  }
  if (bootOutcome.kind === "failed") {
    process.stderr.write(
      `agentproto serve: gateway boot failed — ${bootOutcome.message}\n`,
    )
    return 1
  }
  gateway = bootOutcome.gateway

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
    authGated: opts.authToken != null,
    e2e: opts.e2e === true,
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

  // ── eager resume-on-boot (opt-in, §5 / PR-4) ──
  // Runs AFTER the stale sweeps — and, because createGateway already returned,
  // AFTER the supervisor was re-armed (§5 "Event ordering"): the pass emits
  // `session:resumed`, never a second `session:exited`, so a re-armed
  // lone-session policy survives the restart. Gated on the daemon actually
  // serving each row's workspace (§5 cross-process bullet): two daemons on
  // different ports share the `~/.agentproto/workspaces/*` buckets, so each
  // must only resume rows whose home bucket matches the one IT serves — else
  // both would race to resume the same sessions out of a shared bucket. No-op
  // (enabled:false) unless daemon.resumeSessionsOnBoot is set. Best-effort:
  // a failure here must never gate the daemon being up.
  try {
    const wsConfig = await loadWorkspacesConfig()
    const registeredSlugs = new Set(wsConfig.workspaces.map(w => w.slug))
    const servedSlug = findWorkspaceByPath(wsConfig, opts.workspace)?.slug
    const servedBucket = resolveBucketSlug(servedSlug, registeredSlugs)
    const eager = await gateway.resumeSessionsOnBoot({
      isServed: desc =>
        resolveBucketSlug(desc.workspaceSlug, registeredSlugs) === servedBucket,
    })
    if (eager.enabled && eager.candidates > 0) {
      process.stderr.write(
        `${color.dim}eager-resumed ${eager.resumed}/${eager.candidates} session(s)` +
          `${eager.failed > 0 ? ` (${eager.failed} failed)` : ""}` +
          `${color.reset}\n`,
      )
    }
  } catch (err) {
    process.stderr.write(
      `${color.dim}eager resume-on-boot skipped — ${
        err instanceof Error ? err.message : String(err)
      }${color.reset}\n`,
    )
  }

  // ── pairing autoconnect ──
  // Open standing rendezvous connections for every persisted pairing so a
  // paired client can reconnect anytime (same pattern as tunnel.autoconnect).
  // Non-blocking + best-effort — a broker being down must never gate boot.
  if (cfgPairing.autoconnect !== false) {
    void pairingRegistry.startAutoconnect().catch(err =>
      process.stderr.write(
        `agentproto serve: pairing autoconnect failed — ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      ),
    )
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
  // Rate-limit tunnel-error logging. A dead host (wrong URL, revoked token,
  // permanently-down peer) reconnects on backoff forever; logging every
  // attempt buried daemon.log (this line alone spun 1344× in one log). Log
  // the first failure at once, then at most one line per window with the
  // suppressed count; a successful connect resets it. Backoff is unchanged.
  const tunnelLogGate = createReconnectLogGate()
  const TUNNEL_LOG_KEY = "tunnel"
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
      tunnelLogGate.onSuccess(TUNNEL_LOG_KEY)
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
      const line = tunnelLogGate.onFailure(
        TUNNEL_LOG_KEY,
        `agentproto serve: tunnel error: ${msg}\n  reconnecting in ${backoffMs}ms…`,
      )
      if (line) process.stderr.write(`${line}\n`)
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

  const rawSink: FrameSink = wrapWebSocket(ws as unknown as Parameters<typeof wrapWebSocket>[0])

  // ── opt-in E2E upgrade (tunnel-e2e/v1) ──
  // Before any tunnel/v1 traffic, run a token-authenticated ephemeral handshake
  // over the raw sink and wrap it in the AEAD box, so even the trusted host
  // loses plaintext visibility. Fully backward-compatible:
  //   - host doesn't advertise e2e (old host) → `connectSinkE2E` times out and
  //     returns null → we keep the raw sink and behave exactly as today.
  //   - wrong token / tampered handshake → `connectSinkE2E` throws (fail closed);
  //     it bubbles to the reconnect loop, never downgrading to plaintext.
  // With `tunnel.e2e` unset, this block is skipped entirely — byte-identical.
  let sink: FrameSink = rawSink
  let e2eActive = false
  if (opts.e2e && opts.token) {
    const started = startTunnelHandshake(opts.token)
    const wrapped = await connectSinkE2E(
      rawSink,
      encodeTunnelMessage(started.offer),
      reply => {
        const session = started.complete(decodeTunnelAccept(reply))
        return { sendKey: session.sendKey, recvKey: session.recvKey }
      },
    )
    if (wrapped) {
      sink = wrapped
      e2eActive = true
      process.stderr.write(
        `agentproto serve: tunnel · e2e ↑ encrypted (token-authenticated).\n`,
      )
    } else {
      process.stderr.write(
        `agentproto serve: tunnel · host did not negotiate e2e — continuing plaintext.\n`,
      )
    }
  }

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
    // The daemon-side serving config (HTTP/WS forwarding to the local gateway,
    // spawn authorize, PTY, sessions-registry adoption) is shared verbatim with
    // the E2E pairing serve path — see util/tunnel-serve.ts. `serve --connect`
    // trusts its bearer-authenticated host, so it injects no token (unlike a
    // pairing) and labels adopted spawns "tunnel:".
    ...buildDaemonTunnelServerOptions({
      gateway,
      label: opts.label,
      spawnPty,
      announcedTools,
      childLabelPrefix: "tunnel",
    }),
    // Advertise the encrypted channel in the (now in-box) hello so the host can
    // confirm/display it. Purely informational — the encryption is already live.
    ...(e2eActive ? { e2e: true } : {}),
    // Graceful drain hook — connect-only. Flip the outer loop's "reconnect
    // immediately" flag and close the WS so the supervisor reconnects without
    // backoff. Host follows up with close(1012) ~2s later as a hard backstop.
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
 * Probe a candidate daemon's `/health`. Returns true iff a 2xx answers within a
 * short timeout — i.e. a healthy daemon already owns this bind+port, so a fresh
 * `serve` would only collide with it. Connection-refused / timeout / non-2xx
 * all read as "no live incumbent", so the caller proceeds to bind.
 */
export async function probeHealthyDaemon(healthUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${healthUrl}/health`, {
      signal: AbortSignal.timeout(800),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Discriminated outcome of {@link bootGatewayIdempotent}. */
export type BootOutcome =
  | { kind: "booted"; gateway: GatewayHandle }
  | { kind: "peer-up"; url: string }
  | { kind: "failed"; message: string }

/**
 * Boot the gateway idempotently against a possibly-already-running peer.
 *
 * 1. Preflight `probe(healthUrl)`: a healthy incumbent means this launch is
 *    redundant (a hand-relaunch, a launchd respawn racing the incumbent) →
 *    `peer-up`, no bind attempted.
 * 2. Otherwise `boot()`. On success → `booted`.
 * 3. If `boot()` fails with `EADDRINUSE`, a serve raced us onto the port
 *    between our preflight and our listen. Re-probe: a healthy winner →
 *    `peer-up` (defer to it, exit 0); anything else → `failed` (exit 1).
 * 4. Any non-`EADDRINUSE` boot failure → `failed`.
 *
 * The `probe`/`boot` seams keep this unit testable without a real socket.
 */
export async function bootGatewayIdempotent(opts: {
  healthUrl: string
  probe: (healthUrl: string) => Promise<boolean>
  boot: () => Promise<GatewayHandle>
}): Promise<BootOutcome> {
  if (await opts.probe(opts.healthUrl)) {
    return { kind: "peer-up", url: opts.healthUrl }
  }
  try {
    const gateway = await opts.boot()
    return { kind: "booted", gateway }
  } catch (err) {
    if (isAddrInUse(err) && (await opts.probe(opts.healthUrl))) {
      return { kind: "peer-up", url: opts.healthUrl }
    }
    return {
      kind: "failed",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

/** True for a Node bind error whose `code` is `EADDRINUSE`. */
function isAddrInUse(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "EADDRINUSE"
  )
}

/**
 * Resolve the effective idle-reaper threshold (PR-6): `AGENTPROTO_IDLE_REAP_AFTER_MS`
 * env > the `daemon.idleReapAfterMs` config field > off. Returns a positive ms
 * value to arm the reaper, or 0 to leave it off (the default). A malformed /
 * non-positive value at either layer reads as off rather than throwing — the
 * reaper is opt-in, so "couldn't parse it" defaults to the safe, disabled path.
 */
function resolveIdleReapAfterMs(configured: number | undefined): number {
  const raw = process.env.AGENTPROTO_IDLE_REAP_AFTER_MS
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
    return 0
  }
  return typeof configured === "number" && configured > 0 ? configured : 0
}

/**
 * Resolve the effective crash-detect sweep interval (crash-detect PR-1):
 * `AGENTPROTO_CRASH_DETECT_INTERVAL_MS` env > the `daemon.crashDetectIntervalMs`
 * config field > `undefined` (letting `createGateway` apply its own DEFAULT-ON
 * fallback). Unlike `resolveIdleReapAfterMs`, an unset/malformed value here does
 * NOT mean "off" — it means "let the gateway pick its default", since detection
 * is non-destructive observability and opt-in-to-DISABLE, not opt-in-to-enable.
 * An explicit non-positive value at either layer DOES disable it.
 */
function resolveCrashDetectIntervalMs(configured: number | undefined): number | undefined {
  const raw = process.env.AGENTPROTO_CRASH_DETECT_INTERVAL_MS
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed)) return parsed > 0 ? parsed : 0
    return undefined
  }
  return configured
}

/**
 * Resolve the effective restart-sweep interval (restart-scheduler PR-2):
 * `AGENTPROTO_RESTART_SWEEP_INTERVAL_MS` env > the
 * `daemon.restartSweepIntervalMs` config field > off. Returns a positive ms
 * value to arm the sweep, or 0 to leave it off (the default) — same
 * off-by-default shape as `resolveIdleReapAfterMs` (unlike
 * `resolveCrashDetectIntervalMs`, which is default-ON).
 */
function resolveRestartSweepIntervalMs(configured: number | undefined): number {
  const raw = process.env.AGENTPROTO_RESTART_SWEEP_INTERVAL_MS
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
    return 0
  }
  return typeof configured === "number" && configured > 0 ? configured : 0
}

/**
 * Dial a rendezvous broker outbound (daemon side) and adapt the socket to a
 * `FrameSink`. Injected into the pairing registry. Honours the registry's abort
 * signal so shutdown tears down an in-flight dial promptly.
 */
async function daemonDialRendezvous(
  url: string,
  signal: AbortSignal,
): Promise<FrameSink> {
  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      ws.off("open", onOpen)
      ws.off("error", onError)
      signal.removeEventListener("abort", onAbort)
    }
    const onOpen = (): void => {
      cleanup()
      resolve()
    }
    const onError = (err: Error): void => {
      cleanup()
      reject(err)
    }
    const onAbort = (): void => {
      cleanup()
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      reject(new Error("dial aborted"))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    ws.once("open", onOpen)
    ws.once("error", onError)
    signal.addEventListener("abort", onAbort)
  })
  return wrapWebSocket(ws as unknown as Parameters<typeof wrapWebSocket>[0])
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
  authGated?: boolean
  e2e?: boolean
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
  const e2eTag =
    opts.connect && opts.e2e
      ? ` ${c.green}· e2e${c.reset} ${c.dim}(negotiated per-connect)${c.reset}`
      : ""
  const mode = opts.connect
    ? `${c.cyan}tunnel${c.reset} ${c.dim}→ ${opts.connect}${c.reset}${e2eTag}`
    : `${c.dim}local-only${c.reset}`
  const auth = opts.authGated
    ? `${c.amber}bearer${c.reset} ${c.dim}(daemon.authToken)${c.reset}`
    : `${c.dim}open (no token set)${c.reset}`
  const line = `${c.dim}─${c.reset}`
  process.stderr.write(
    `\n${line} ${c.bold}agentproto${c.reset} ${c.dim}·${c.reset} gateway up ${c.dim}·${c.reset} ${c.cyan}${opts.url}${c.reset} ${line}\n` +
      `  ${c.dim}workspace${c.reset}    ${workspace}\n` +
      `  ${c.dim}pty${c.reset}          ${ptyState}\n` +
      `  ${c.dim}origins${c.reset}      ${origins}\n` +
      `  ${c.dim}auth${c.reset}         ${auth}\n` +
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
