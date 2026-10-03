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
  makeWorktreeAutoReclaimer,
  makeOpenPrResolver,
  makePrStateResolver,
} from "./worktree.js"
import { makeBranchGcRunner, makeBranchGcVerdictReader, makeBranchGcVerdictRecorder } from "./branch.js"
import { loadConfig } from "@agentproto/runtime/config"
import {
  loadWorkspacesConfig,
  findWorkspaceByPath,
} from "@agentproto/runtime/workspaces-config"
import {
  createTunnelServer,
  wrapWebSocket,
  connectSinkE2E,
  clientHandshakeOverSink,
  type FrameSink,
  type E2eFrameSink,
} from "@agentproto/acp/tunnel"
import {
  startTunnelHandshake,
  encodeTunnelMessage,
  decodeTunnelAccept,
  startClientHandshake,
  encodePairingMessage,
  decodePairingReply,
  parseOfferUrl,
  deriveOfferTokens,
} from "@agentproto/secrets/pairing"
import {
  createGateway,
  createPairingRegistry,
  createHostRegistry,
  createJoinTokenRegistry,
  createReconnectLogGate,
  sweepStaleRuntimeMetas,
  sweepStaleDaemonRegistry,
  resolveBucketSlug,
  unlinkRuntimeMeta,
  injectProviderKeysIntoEnv,
  setMcpCredentialDeps,
  resolveDeferredToolsGatewayOption,
  reconcileSandboxLedger,
  makeSandboxResolver,
  makeSandboxCredsStore,
  defaultBrowserAdapterResolution,
  resolveEffectiveLlmEndpointFlag,
  type AgentAdapterResolver,
  type AdapterAuthDescriptor,
  type GatewayHandle,
  type PairingRegistry,
  type PairingChannelContext,
  type PairingChannelHandle,
  type HostRegistry,
  type JoinTokenRegistry,
} from "@agentproto/runtime"
import { CatalogProviderSchema, type CatalogProvider } from "@agentproto/model-catalog"
import { loadOrCreateIdentity } from "@agentproto/secrets/identity"
import { buildDaemonTunnelServerOptions } from "../util/tunnel-serve.js"
import { dialRendezvous } from "@agentproto/pairing-host"
import { resolveProxyDialOptions } from "../util/proxy-dial.js"
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
import { agentCliSupportsHostContextIsolation, createAgentCliRuntime } from "@agentproto/driver-agent-cli"
import { readHermesUsage } from "@agentproto/adapter-hermes"
import { readOpenCodeUsage } from "@agentproto/adapter-opencode"
import { readClaudeCodeUsage } from "@agentproto/adapter-claude-code"
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
import { cliInstallSource, resolveCliEntry } from "../registry/install-source.js"
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
  const cfgFeatures = { ...(cfg.features ?? {}), ...(profile?.features ?? {}) }

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
      // The adapter's OWN declared per-model billing provider
      // (`models.allowed[].provider`) — authoritative for a model-derived-
      // api-key adapter (no fixed `provider` above) whose declared model
      // otherwise falls through to the GLOBAL catalog's (possibly
      // different) routing for the same id (D3: pi bills
      // `moonshotai/kimi-k2.7-code` via `moonshot`; the catalog routes that
      // id to `openrouter`). Same catalog-enum validation as `provider`
      // above — an unrecognized string is dropped, never guessed.
      const modelProviders: Record<string, CatalogProvider> = {}
      for (const entry of adapter.handle.models?.allowed ?? []) {
        if (typeof entry === "string" || !entry.provider) continue
        const parsed = CatalogProviderSchema.safeParse(entry.provider)
        if (parsed.success) modelProviders[entry.id] = parsed.data
      }
      const authDescriptor: AdapterAuthDescriptor = {
        ...(providerParse?.success ? { provider: providerParse.data } : {}),
        ...(adapter.handle.authEnforce ? { authEnforce: adapter.handle.authEnforce } : {}),
        ...(adapter.handle.authSubscription
          ? { authSubscription: adapter.handle.authSubscription }
          : {}),
        ...(adapter.handle.modelDerivedApiKey
          ? { modelDerivedApiKey: adapter.handle.modelDerivedApiKey }
          : {}),
        ...(adapter.handle.gatewayAuth ? { gatewayAuth: adapter.handle.gatewayAuth } : {}),
        ...(Object.keys(modelProviders).length > 0 ? { modelProviders } : {}),
      }
      return {
        async startSession({ cwd, resumeSessionId, configDir, mode, options, model, effort, posture, contextProfile, mcpServers, onActivity, permissionHold, auth, commandSandbox, additionalReadPaths, env, fsZones, isolateHostContext }) {
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
            ...(configDir ? { configDir } : {}),
            ...(Object.keys(config).length > 0 ? { config } : {}),
            ...(mcpServers ? { mcpServers } : {}),
            ...(onActivity ? { onActivity } : {}),
            ...(permissionHold ? { permissionHold: true } : {}),
            ...(auth ? { auth } : {}),
            ...(typeof posture === "string" ? { posture } : {}),
            ...(contextProfile ? { contextProfile } : {}),
            ...(commandSandbox ? { commandSandbox } : {}),
            // Read grants for a confined adapter tree (the AGENTS.md pointer
            // file, the headless browser's install + Chrome bundle).
            ...(additionalReadPaths?.length ? { additionalReadPaths } : {}),
            ...(env ? { env } : {}),
            // App-boundary fs zones + isolated host context (the runtime only
            // passes these to adapters that advertise support below).
            ...(fsZones ? { fsZones } : {}),
            ...(isolateHostContext ? { isolateHostContext: true } : {}),
          })
        },
        // Every agent-cli arm except `proprietary` (which owns its own
        // process) wraps its spawn through the OS sandbox, where zones apply.
        supportsFsZones: adapter.handle.protocol !== "proprietary",
        supportsHostContextIsolation: agentCliSupportsHostContextIsolation(slug),
        commandPreview:
          `${adapter.handle.bin} ${(adapter.handle.bin_args ?? []).join(" ")}`.trim(),
        ...(slug === "hermes" ? { readUsage: (sid: string) => readHermesUsage(sid) } : {}),
        ...(slug === "opencode" ? { readUsage: (sid: string) => readOpenCodeUsage(sid) } : {}),
        // claude-agent-acp's usage_update carries no input/output/cache
        // split — Claude Code's own transcript JSONL does.
        ...(slug === "claude-code"
          ? {
              readUsage: (sid: string, ctx?: { cwd?: string; configDir?: string }) =>
                readClaudeCodeUsage(sid, ctx),
            }
          : {}),
        declaredOptions: (adapter.handle.options ?? []).map(o => ({
          id: o.id,
          type: o.type,
        })),
        authDescriptor,
        ...(adapter.handle.routeSelection
          ? { routeSelection: adapter.handle.routeSelection }
          : {}),
        ...(adapter.handle.models?.default
          ? { defaultModel: adapter.handle.models.default }
          : {}),
        ...(adapter.handle.capabilities?.resumable !== undefined
          ? { resumable: adapter.handle.capabilities.resumable }
          : {}),
        ...(adapter.handle.capabilities?.nativeTerminalResume === true
          ? { nativeTerminalResume: true }
          : {}),
        ...(adapter.handle.capabilities?.nativeToolSearch === true
          ? { nativeToolSearch: true }
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
  const { resolveBrowserAdapter, listBrowserAdapters } = defaultBrowserAdapterResolution()

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
  // Imported-MCP secret seam (P1: used by import + resolveImportConnection + migrate-secrets). ref =
  // `<keychain path>#<account>`, e.g. `agentproto/mcp-import/<id>#header:Authorization`.
  const mcpSecretStore = new KeychainStore()
  const splitMcpSecretRef = (ref: string): { path: string; account: string } => {
    const i = ref.lastIndexOf("#")
    return i < 0 ? { path: ref, account: ref } : { path: ref.slice(0, i), account: ref.slice(i + 1) }
  }
  setMcpCredentialDeps({
    resolveMcpSecret: async (ref) =>
      (await mcpSecretStore.read(splitMcpSecretRef(ref)))?.value,
    storeMcpSecret: async (ref, value) => {
      await mcpSecretStore.write(splitMcpSecretRef(ref), { value, kind: "pat" })
    },
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
  const servePairedChannel = (sink: E2eFrameSink, ctx: PairingChannelContext): PairingChannelHandle => {
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
        // This channel's own recorded scope (device-inference gate) — never
        // anything the far end's hello claims, only what THIS pairing was
        // actually granted (see PairingChannelContext.scope's doc comment).
        ...(ctx.scope ? { pairingScope: ctx.scope } : {}),
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

  // ── HOST registry (reverse pairing, DEVICES-PLAN PR-C) ──
  // The "client" half of pair/v2, living daemon-side: `devices add` registers
  // another daemon as a driveable host, `devices status`/`exec` dial it on
  // demand. Unlike pairingRegistry this keeps no standing connections — reuses
  // the same `daemonDialRendezvous` dialer, but there's no `serve`/identity to
  // inject (a host registration carries no persistent identity of its own on
  // this side; `clientName` is just a self-reported label, same as `pair
  // accept`).
  const hostRegistry: HostRegistry = createHostRegistry({
    hostsPath: joinPath(agentprotoHome, "hosts.json"),
    dial: daemonDialRendezvous,
    log: line => process.stderr.write(`${color.dim}${line}${color.reset}\n`),
    ...envMs("AGENTPROTO_HOST_ENDED_TTL_MS", "endedTtlMs"),
    ...envMs("AGENTPROTO_HOST_ENDED_RETENTION_MS", "endedRetentionMs"),
  })
  // Resume polling joined hosts that survived a restart (bounded, staggered),
  // then mark/delete ended joined hosts on a slow cadence (one in-memory pass).
  void hostRegistry.start().catch(() => undefined)
  setInterval(() => void hostRegistry.sweep().catch(() => undefined), HOST_SWEEP_INTERVAL_MS).unref()

  // ── JOIN TOKEN registry (SANDBOX-VISIBILITY-JOIN) ──
  // Mints long-lived, revocable, reusable credentials for `AGENTPROTO_JOIN`;
  // a box daemon holding one dials in and this daemon adds it to
  // `hostRegistry` automatically — see join-token-registry.ts's module doc
  // for why this needs no protocol changes (two ordinary pair/v2 handshakes
  // back to back). Same `daemonDialRendezvous`/identity/rendezvous wiring as
  // `pairingRegistry` above.
  const joinTokenRegistry: JoinTokenRegistry = createJoinTokenRegistry({
    loadIdentity: () => loadOrCreateIdentity(joinPath(agentprotoHome, "identity.json")),
    joinTokensPath: joinPath(agentprotoHome, "join-tokens.json"),
    ...(cfgPairing.rendezvous !== undefined
      ? { defaultRendezvousUrl: cfgPairing.rendezvous }
      : {}),
    dial: daemonDialRendezvous,
    addHost: (offerUrl, name, meta) => hostRegistry.add(offerUrl, name, meta),
    flushHost: fingerprint => hostRegistry.snapshotNow(fingerprint),
    endHost: fingerprint => hostRegistry.markEnded(fingerprint, "goodbye"),
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
  // Smart default (daemon-managed-gateway): an explicit config/profile value
  // always wins; unset defaults ON the first time the operator already
  // configured a named endpoint, an upstream link, or an explicit
  // `llm-endpoint` route — see the resolver's docblock.
  const effectiveLlmEndpoint = await resolveEffectiveLlmEndpointFlag(cfgFeatures.llmEndpoint)
  const bootOutcome = await bootGatewayIdempotent({
    healthUrl,
    probe: probeHealthyDaemon,
    boot: () =>
      createGateway({
        pairingRegistry,
        hostRegistry,
        joinTokens: joinTokenRegistry,
        workspace: opts.workspace,
        port: opts.port,
        bind: opts.bind,
        specs: [driverSpec],
        name: "agentproto-serve",
        // Surfaced over MCP and `/health` — what is actually running.
        version: __CLI_VERSION__,
        // Build identity: sha + builtAt were stamped into this bundle at
        // build time; `source` is judged here from where the entry actually
        // lives, because the version string alone cannot distinguish a
        // workspace dist from the published tarball of the same release.
        build: {
          sha: __CLI_BUILD_SHA__,
          builtAt: __CLI_BUILT_AT__,
          source: cliInstallSource(resolveCliEntry(process.argv[1])),
        },
        // BOOT.md is silly for a tunnel daemon — skip it.
        boot: false,
        // Opt-in eager resume-on-boot (§5, PR-4). Resolved from
        // daemon.resumeSessionsOnBoot (profile-overlaid). Off ⇒ the handle
        // method short-circuits and only lazy resume-on-prompt applies.
        resumeSessionsOnBoot: cfgDaemon.resumeSessionsOnBoot === true,
        // Opt-in continue-on-boot: after the eager pass, prompt the sessions
        // the last restart cut off mid-turn to continue. Off ⇒ no-op.
        continueInterruptedOnBoot: cfgDaemon.continueInterruptedOnBoot === true,
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
        // Turn-liveness watchdog (turn-liveness-watchdog chantier). DEFAULT
        // ON: resolution order mirrors crashDetectIntervalMs's comment above
        // — an unset value here passes `undefined` through so createGateway
        // applies its own sane default rather than reading "unset" as off.
        turnStallAfterMs: resolveTurnStallAfterMs(cfgDaemon.turnStallAfterMs),
        // Deferred/lazy MCP tool loading (harness-parity item 3). Read ONCE
        // at boot from `defaults.mcp.deferredTools` — this is the gateway-
        // wide default a connection with no per-mount `?deferred=` override
        // and no per-spawn/role override falls through to. Default OFF
        // (undefined ⇒ `createGateway` never wraps `withDeferredTools` —
        // today's fully-eager behaviour, unchanged for existing clients).
        deferredTools: resolveDeferredToolsGatewayOption(cfg.defaults?.mcp?.deferredTools),
        llmEndpoint: effectiveLlmEndpoint,
        // Opt-in, no smart-default (unlike `llmEndpoint` above) — exposing
        // this daemon's local inference to a paired host-scoped controller
        // is a deliberate operator decision (`agentproto devices
        // share-inference on`), never inferred from existing config.
        deviceInferenceShare: cfgFeatures.deviceInferenceShare === true,
        // Same opt-in shape as deviceInferenceShare above (DEVICES-PLAN
        // PR-D) — `agentproto devices allow-spawn on` is the deliberate
        // operator decision that lets a paired HOST-scoped controller spawn
        // agent sessions on THIS daemon.
        deviceSpawnAllow: cfgFeatures.deviceSpawnAllow === true,
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
        // Injected ports behind `branch_gc` / `branch_gc_verdict` (+ `POST
        // /branches/gc[/verdict]`): the branch-gc engine over
        // @agentproto/worktree (defaults to a dry run), same dep reasoning.
        runBranchGc: makeBranchGcRunner(),
        recordBranchGcVerdict: makeBranchGcVerdictRecorder(),
        readBranchGcVerdict: makeBranchGcVerdictReader(),
        // Injected port behind `sessions.ts`'s exit-time worktree auto-reclaim
        // (`SessionDescriptor.worktreeAutoProvisioned`): a policy-provisioned
        // (implicit) session's own worktree is reclaimed the moment it exits,
        // if — and only if — it classifies clean/idle/merged-or-fresh. Same
        // dep reasoning as above; a worktree the caller explicitly requested
        // is never routed through this port at all.
        runWorktreeAutoReclaim: makeWorktreeAutoReclaimer(),
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
    // Continue-on-boot (opt-in, daemon.continueInterruptedOnBoot). Strictly
    // AFTER the eager pass above, so a row whose eager resume failed carries
    // its failed attempt and is skipped instead of lazily retried — and, like
    // it, after the supervisor was re-armed, so a re-armed policy sees the
    // continue turn end. Same cross-process gate.
    const cont = await gateway.continueInterruptedOnBoot({
      isServed: desc =>
        resolveBucketSlug(desc.workspaceSlug, registeredSlugs) === servedBucket,
    })
    if (cont.enabled && cont.eligible > 0) {
      process.stderr.write(
        `${color.dim}continued ${cont.sent}/${cont.eligible} interrupted session(s)` +
          `${cont.failed > 0 ? ` (${cont.failed} failed)` : ""}` +
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

  // ── per-session index backfill ──
  // Create the compact `index.json` sidecar for every session dir that lacks
  // one, so `agentproto sessions find`/`recap` answer instantly (and without a
  // running daemon) even for sessions that predate the sidecar. Synchronous
  // and best-effort: one readdir plus one bounded tail read per missing index;
  // a failure here must never gate the daemon being up.
  try {
    const backfilled = gateway.backfillSessionIndexes()
    if (backfilled.created > 0) {
      process.stderr.write(
        `${color.dim}indexed ${backfilled.created} session(s)` +
          `${color.reset}\n`,
      )
    }
  } catch (err) {
    process.stderr.write(
      `${color.dim}session index backfill skipped — ${
        err instanceof Error ? err.message : String(err)
      }${color.reset}\n`,
    )
  }

  // ── sandbox ledger reconcile ──
  // The ledger (~/.agentproto/sandboxes.json) can drift from what a
  // provider actually still has running — a failed teardown, a daemon that
  // crashed mid-close, a provider-side idle-reap the daemon never heard
  // about. Probing every row still claiming to be booted/connected/paused
  // catches that drift at boot, same primitive `agentproto sandbox list`
  // and `GET /sandboxes/:id/alive` already use per-row. Read-only against
  // the provider and never tears a box down — a row it confirms gone is
  // only ever marked "gone" in the ledger. Best-effort: a broken provider
  // credential must never gate the daemon being up.
  try {
    const reconciled = await reconcileSandboxLedger({
      resolveProvider: makeSandboxResolver(makeSandboxCredsStore()),
    })
    if (reconciled.checked > 0) {
      process.stderr.write(
        `${color.dim}sandbox ledger reconciled: ${reconciled.checked} checked, ` +
          `${reconciled.gone} gone, ${reconciled.alive} alive` +
          `${reconciled.unknown > 0 ? `, ${reconciled.unknown} unknown` : ""}` +
          `${color.reset}\n`,
      )
    }
  } catch (err) {
    process.stderr.write(
      `${color.dim}sandbox ledger reconcile skipped — ${
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
    void joinTokenRegistry.startAutoconnect().catch(err =>
      process.stderr.write(
        `agentproto serve: join-token autoconnect failed — ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      ),
    )
  }

  // ── AGENTPROTO_JOIN (SANDBOX-VISIBILITY-JOIN, box side) ──
  // A box daemon (e.g. a CI reviewer sandbox) started with this env var set
  // auto-registers as a host on whichever daemon minted the token — no offer
  // URL to relay by hand. Best-effort + non-blocking: a bad/expired/revoked
  // token, or a broker being down, must never gate boot; failures just log.
  const agentprotoJoin = process.env.AGENTPROTO_JOIN
  let joinHandle: JoinHandle | undefined
  if (agentprotoJoin) {
    void joinAsBox(agentprotoJoin, pairingRegistry)
      .then(handle => {
        joinHandle = handle
      })
      .catch(err =>
        process.stderr.write(
          `agentproto serve: AGENTPROTO_JOIN failed — ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        ),
      )
  }

  // ── shutdown wiring (covers both local-only and tunnel modes) ──
  const aborter = new AbortController()
  const bootedAt = Date.now()
  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    process.stderr.write(
      `\n${color.dim}── shutting down (${signal}) · v${__CLI_VERSION__} · up ${formatDuration(Date.now() - bootedAt)} ──${color.reset}\n`,
    )
    // Tell the daemon we joined that we're leaving, so it captures our final
    // session output while we can still answer (bounded — never blocks exit).
    if (joinHandle) {
      await Promise.race([
        joinHandle.goodbye().catch(() => undefined),
        new Promise<void>(resolve => setTimeout(resolve, JOIN_GOODBYE_TOTAL_MS).unref?.()),
      ])
    }
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
  // Aborting a CONNECTING socket makes `ws` emit an async 'error' after the dial
  // listeners are gone; unhandled it crashes the daemon.
  ws.on("error", () => {})

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
      ws.terminate()
      reject(new Error("Aborted before WS opened."))
    }
    signal.addEventListener("abort", () => {
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate()
      else ws.close()
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
    const started = await startTunnelHandshake(opts.token)
    const wrapped = await connectSinkE2E(
      rawSink,
      encodeTunnelMessage(started.offer),
      async reply => {
        const session = await started.complete(decodeTunnelAccept(reply))
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
 * Resolve the effective turn-liveness watchdog threshold (turn-liveness-
 * watchdog chantier): `AGENTPROTO_TURN_STALL_AFTER_MS` env > the
 * `daemon.turnStallAfterMs` config field > `undefined` (letting
 * `createGateway` apply its own DEFAULT-ON fallback). Same shape as
 * `resolveCrashDetectIntervalMs`: an unset/malformed value does NOT mean
 * "off" — detection is non-destructive observability, opt-in-to-DISABLE
 * rather than opt-in-to-enable. An explicit non-positive value at either
 * layer DOES disable it.
 */
function resolveTurnStallAfterMs(configured: number | undefined): number | undefined {
  const raw = process.env.AGENTPROTO_TURN_STALL_AFTER_MS
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed)) return parsed > 0 ? parsed : 0
    return undefined
  }
  return configured
}

const JOIN_DIAL_TIMEOUT_MS = 15_000
const JOIN_HANDSHAKE_TIMEOUT_MS = 15_000
/** How long a leaving box waits for its join daemon to finish the final capture. */
const JOIN_GOODBYE_WAIT_MS = 20_000
/** Cadence of the joined-host ended/retention sweep. */
const HOST_SWEEP_INTERVAL_MS = 60_000

/** `{ [key]: n }` from a non-negative-integer env var (0 disables), else `{}`. */
function envMs<K extends string>(name: string, key: K): { [P in K]?: number } {
  const raw = process.env[name]
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw)
  return Number.isInteger(n) && n >= 0 ? ({ [key]: n } as { [P in K]?: number }) : {}
}

/** Hard ceiling on the whole goodbye (dial + handshake + wait) at shutdown. */
const JOIN_GOODBYE_TOTAL_MS = 30_000
/** How long the box's own self-offer needs to live — long enough for the
 *  home daemon's join-token accept loop to finish THIS join's own handshake,
 *  process it, and dial back — not a standing credential. 3 minutes, not
 *  "a moment later": the dial-back is a full second pair/v2 round trip
 *  through the same broker, queued behind the accept loop's own handling of
 *  the join hello, and under real broker latency (or a busy accept loop
 *  mid-`handleJoined` for a prior box) a tight TTL here is exactly how a
 *  legitimate join silently fails to become a device — see
 *  `join-token-registry.ts`'s `JoinTokenRecord.lastJoinError` doc. */
const JOIN_SELF_OFFER_TTL_MS = 180_000

/** Broker upgrade URL for the box's outbound join dial (`side=client`) —
 *  mirrors `pair-transport.ts`'s `rvUrl` / `host-registry.ts`'s `rvUrl`. */
function joinDialUrl(rendezvousUrl: string, route: string): string {
  const sep = rendezvousUrl.includes("?") ? "&" : "?"
  return `${rendezvousUrl}${sep}side=client&t=${encodeURIComponent(route)}`
}

/** Parse `AGENTPROTO_JOIN_LABELS` (`key=value,key2=value2`) into a plain
 *  string record; malformed/empty entries are dropped rather than failing
 *  the whole join. Absent/empty env → `undefined` (no `labels` sent). */
function parseJoinLabels(raw: string | undefined): Record<string, string> | undefined {
  if (!raw || !raw.trim()) return undefined
  const labels: Record<string, string> = {}
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=")
    if (eq <= 0) continue
    const key = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (key && value) labels[key] = value
  }
  return Object.keys(labels).length > 0 ? labels : undefined
}

/**
 * `AGENTPROTO_JOIN` boot wiring (SANDBOX-VISIBILITY-JOIN, box side). `token`
 * is a join-token URL minted by some other daemon's `join_token_create` /
 * `agentproto devices join-token create`. This:
 *
 *   1. Mints THIS box's own local, short-TTL, host-scoped offer via the
 *      already-running `pairingRegistry` — exactly what `agentproto pair
 *      offer --host` does, just called in-process instead of from a human's
 *      terminal. `pairingRegistry`'s own (unmodified) offer-park loop starts
 *      immediately and will serve whichever daemon dials it.
 *   2. Dials the join token's route as the CLIENT — the role a browser/CLI
 *      plays consuming a normal offer, NOT `HostRegistry.add`'s role — and
 *      hands the minting daemon a JSON envelope (via the ordinary
 *      `clientName` hello field, no wire changes) carrying THIS box's
 *      self-offer URL plus optional self-reported name/provider/sandboxId/
 *      labels (from `AGENTPROTO_JOIN_NAME`/`_PROVIDER`/`_SANDBOX_ID`/
 *      `_LABELS`, all optional).
 *   3. Closes — this dial is bootstrap-only, a single string handed over.
 *      The minting daemon takes it from there (`join-token-registry.ts`
 *      calls its own `HostRegistry.add` against the offer this just handed
 *      it), which is what actually dials back and completes the host
 *      registration. This box then just answers that second dial through
 *      `pairingRegistry`'s already-started offer/reconnect loop, same as any
 *      other paired daemon — no further box-side code needed.
 *
 * Errors (expired/revoked/malformed token, broker unreachable) are the
 * caller's to log; they must never fail daemon boot.
 */
async function joinAsBox(token: string, pairingRegistry: PairingRegistry): Promise<JoinHandle> {
  const offer = await parseOfferUrl(token, { now: Date.now() })
  if (offer.scope !== "host") {
    throw new Error("AGENTPROTO_JOIN does not carry a host-scoped join token")
  }

  const selfOffer = await pairingRegistry.createOffer({ scope: "host", ttlMs: JOIN_SELF_OFFER_TTL_MS })
  const selfFingerprint = (await parseOfferUrl(selfOffer.url, { now: Date.now() })).fingerprint

  const labels = parseJoinLabels(process.env.AGENTPROTO_JOIN_LABELS)
  const wrapped = await dialJoinChannel(
    offer,
    JSON.stringify({
      offerUrl: selfOffer.url,
      ...(process.env.AGENTPROTO_JOIN_NAME ? { name: process.env.AGENTPROTO_JOIN_NAME } : {}),
      ...(process.env.AGENTPROTO_JOIN_PROVIDER ? { provider: process.env.AGENTPROTO_JOIN_PROVIDER } : {}),
      ...(process.env.AGENTPROTO_JOIN_SANDBOX_ID ? { sandboxId: process.env.AGENTPROTO_JOIN_SANDBOX_ID } : {}),
      ...(labels ? { labels } : {}),
    }),
  )
  wrapped.close("join complete")
  process.stderr.write(
    `${color.dim}[join] registered with daemon ${offer.fingerprint} via AGENTPROTO_JOIN${color.reset}\n`,
  )

  let saidGoodbye = false
  return {
    async goodbye(): Promise<void> {
      if (saidGoodbye) return
      saidGoodbye = true
      const ch = await dialJoinChannel(offer, JSON.stringify({ goodbye: true, fingerprint: selfFingerprint }))
      // The minting daemon closes once it has captured our final session
      // output; wait for that (bounded), since we're about to exit.
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, JOIN_GOODBYE_WAIT_MS)
        if (typeof timer.unref === "function") timer.unref()
        ch.onClose(() => {
          clearTimeout(timer)
          resolve()
        })
      })
      ch.close("goodbye complete")
      process.stderr.write(`${color.dim}[join] said goodbye to daemon ${offer.fingerprint}${color.reset}\n`)
    },
  }
}

/** Handle for a completed `AGENTPROTO_JOIN` registration. */
interface JoinHandle {
  /** Ask the daemon we joined to capture our final session output; call once,
   *  just before exiting. Rejects if it can't be reached in time. */
  goodbye(): Promise<void>
}

/** Dial a join token's route as the CLIENT and complete the pair/v2
 *  handshake, carrying `clientName` (the JSON envelope) in the hello. The
 *  caller owns the returned, open channel. */
async function dialJoinChannel(
  offer: Awaited<ReturnType<typeof parseOfferUrl>>,
  clientName: string,
): Promise<E2eFrameSink> {
  const { route, auth } = await deriveOfferTokens(offer.secret)
  const ac = new AbortController()
  const timer = setTimeout(
    () => ac.abort(new Error(`AGENTPROTO_JOIN dial timed out after ${JOIN_DIAL_TIMEOUT_MS}ms`)),
    JOIN_DIAL_TIMEOUT_MS,
  )
  if (typeof timer.unref === "function") timer.unref()
  let raw: FrameSink
  try {
    raw = await daemonDialRendezvous(joinDialUrl(offer.rendezvousUrl, route), ac.signal)
  } finally {
    clearTimeout(timer)
  }

  const started = await startClientHandshake({
    daemonX25519Pub: offer.daemonX25519Pub,
    daemonEd25519Pub: offer.daemonEd25519Pub,
    authToken: auth,
    clientName,
  })
  let peerFingerprint: string | undefined
  const wrapped = await clientHandshakeOverSink(
    raw,
    encodePairingMessage(started.hello),
    async replyBytes => {
      const session = await started.complete(decodePairingReply(replyBytes))
      peerFingerprint = session.peerFingerprint
      return session
    },
    { timeoutMs: JOIN_HANDSHAKE_TIMEOUT_MS },
  )
  if (peerFingerprint !== offer.fingerprint) {
    wrapped.close("fingerprint mismatch")
    throw new Error(
      `AGENTPROTO_JOIN: daemon fingerprint ${peerFingerprint ?? "(none)"} does not match the token's ${offer.fingerprint}`,
    )
  }
  return wrapped
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
 *
 * Routes through `HTTPS_PROXY`/`HTTP_PROXY` (respecting `NO_PROXY`) when
 * configured — see `../util/proxy-dial.js` — so a corporate-proxied,
 * outbound-HTTPS-only network still reaches the broker.
 */
async function daemonDialRendezvous(
  url: string,
  signal: AbortSignal,
): Promise<FrameSink> {
  const { agent } = resolveProxyDialOptions(url)
  return dialRendezvous(url, signal, agent ? { agent } : {})
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
  const entry = process.argv[1] ?? "?"
  const bin =
    home && entry.startsWith(home) ? "~" + entry.slice(home.length) : entry
  process.stderr.write(
    `\n${line} ${c.bold}agentproto${c.reset} ${c.dim}·${c.reset} gateway up ${c.dim}·${c.reset} ${c.cyan}${opts.url}${c.reset} ${line}\n` +
      `  ${c.dim}version${c.reset}      ${__CLI_VERSION__} ${c.dim}· pid ${process.pid} · node ${process.version}${c.reset}\n` +
      `  ${c.dim}bin${c.reset}          ${bin}\n` +
      `  ${c.dim}workspace${c.reset}    ${workspace}\n` +
      `  ${c.dim}pty${c.reset}          ${ptyState}\n` +
      `  ${c.dim}origins${c.reset}      ${origins}\n` +
      `  ${c.dim}auth${c.reset}         ${auth}\n` +
      `  ${c.dim}endpoints${c.reset}    /mcp · /sessions · /events · /sessions/:id/pty ${c.dim}(WS)${c.reset}\n` +
      `  ${c.dim}mode${c.reset}         ${mode}\n` +
      `\n`,
  )
}

/** `3h12m`, `47m`, `12s` — compact elapsed-time tag for the lifecycle lines. */
function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ""}`
  const d = Math.floor(h / 24)
  return `${d}d${h % 24 ? `${h % 24}h` : ""}`
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
