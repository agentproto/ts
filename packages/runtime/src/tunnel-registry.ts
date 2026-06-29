/**
 * TunnelRegistry — multi-tunnel public-URL manager.
 *
 * Manages a named set of cloudflared (or future provider) tunnels,
 * each forwarding a local port to a public URL. Independent from
 * RemoteController which handles the single "expose this gateway"
 * use-case with bearer-token gating. This registry is for the general
 * "create a public endpoint for any local port" surface.
 *
 * Lifecycle:
 *   create(input) → spawns provider, waits for URL, stores descriptor
 *   list()        → TunnelDescriptor[]
 *   get(id)       → TunnelDescriptor | undefined
 *   stop(id)      → SIGTERM provider, mark stopped
 *   shutdown()    → stop all active tunnels (called on daemon exit)
 *
 * Persistence: `~/.agentproto/tunnels.json` — descriptors survive
 * daemon restarts; active entries are marked "stopped" on next boot
 * since their child processes are gone (same GHOST pattern as
 * sessions.ts).
 */

import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { CLOUDFLARE_NAMED_SLUG } from "./remote-providers/named.js"
import {
  resolveTunnelProvider,
  normalizeProviderSlug,
  builtinProviderCapabilities,
  type TunnelCreds,
} from "./remote-providers/registry.js"
import type { RemoteProvider } from "./remote-providers/types.js"

export type TunnelStatus = "starting" | "active" | "stopped" | "error"

/**
 * Provider identifier — an open set of slugs (built-in `cloudflare-quick` /
 * `cloudflare-named` / `ngrok`, legacy short names `quick` / `named`, or any
 * third-party `@scope/agentproto-adapter-<slug>`). Normalized to a canonical
 * slug only at resolve time, so persisted descriptors keep their original
 * value and need no migration.
 */
export type TunnelProvider = string

export interface TunnelDescriptor {
  id: string
  /** Optional user-friendly slug. Accepts id-or-name in stop/status calls. */
  name?: string
  /** Free-text label surfaced in list / CLI table. */
  label?: string
  provider: TunnelProvider
  targetHost: string
  targetPort: number
  publicUrl: string
  status: TunnelStatus
  pid: number | null
  createdAt: string
  stoppedAt?: string
  lastError?: string
  /**
   * When true, the tunnel is relaunched on daemon boot (see
   * `restoreOnBoot`). Only meaningful for `named` tunnels — a relaunched
   * `quick` tunnel gets a fresh random URL, so autostart for it merely
   * keeps *a* tunnel up, not a stable URL.
   */
  autostart?: boolean
  // ── named-provider fields (unset for quick) ──────────────────────
  /** Stable public hostname routed to this tunnel. */
  hostname?: string
  /** Cloudflare tunnel id or name (the `run` target). */
  tunnelId?: string
  /** Path to the tunnel credentials JSON (defaults under ~/.cloudflared). */
  credentialsFile?: string
}

interface TunnelEntry {
  desc: TunnelDescriptor
  provider: RemoteProvider
}

export interface CreateTunnelInput {
  targetPort: number
  provider?: TunnelProvider
  name?: string
  label?: string
  targetHost?: string
  /** Relaunch this tunnel on daemon boot. See `TunnelDescriptor.autostart`. */
  autostart?: boolean
  // ── required when provider === "named" ───────────────────────────
  /** Stable public hostname (e.g. app.example.com). */
  hostname?: string
  /** Cloudflare tunnel id or name to `run`. */
  tunnelId?: string
  /** Path to the credentials JSON (defaults to ~/.cloudflared/<tunnelId>.json). */
  credentialsFile?: string
}

export interface TunnelRegistryOptions {
  /** Absolute path for persistence file. Defaults to ~/.agentproto/tunnels.json */
  persistPath?: string
  /** Absolute path to workspace — used as scratch dir for provider config files. */
  workspace?: string
  /** Hook for surfacing provider log lines. */
  onLog?: (line: string) => void
  /**
   * Read stored credentials for a provider slug. Lets the lifecycle build a
   * provider that keeps its secrets in the creds store (e.g. ngrok's authtoken,
   * or any third-party provider) rather than on the descriptor. Injected by the
   * daemon (index.ts); descriptor-carried config (named's hostname/tunnelId)
   * still takes precedence.
   */
  readCreds?: (slug: string) => Promise<TunnelCreds | null>
}

const TUNNELS_FILE_PATH = (): string =>
  resolve(homedir(), ".agentproto", "tunnels.json")

const HISTORY_CAP = 50

interface PersistedTunnels {
  savedAt: string
  tunnels: TunnelDescriptor[]
}

export class TunnelRegistry {
  private readonly tunnels = new Map<string, TunnelEntry>()
  private readonly persistPath: string
  private readonly workspace: string
  private readonly onLog: ((line: string) => void) | undefined
  private readonly readCreds:
    | ((slug: string) => Promise<TunnelCreds | null>)
    | undefined
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: TunnelRegistryOptions = {}) {
    this.persistPath = opts.persistPath ?? TUNNELS_FILE_PATH()
    this.workspace = opts.workspace ?? homedir()
    this.onLog = opts.onLog
    this.readCreds = opts.readCreds

    this.loadFromDisk()
  }

  async create(input: CreateTunnelInput): Promise<TunnelDescriptor> {
    const id = randomUUID()
    const provider = input.provider ?? "quick"
    const targetHost = input.targetHost ?? "127.0.0.1"

    // Named tunnels need a stable hostname + a tunnel id to `run`. Fail
    // fast here rather than letting cloudflared error out cryptically.
    if (normalizeProviderSlug(provider) === CLOUDFLARE_NAMED_SLUG) {
      if (!input.hostname || !input.tunnelId) {
        throw new Error(
          'named tunnel requires both "hostname" and "tunnelId" ' +
            "(the cloudflared tunnel you provisioned with `cloudflared tunnel create`).",
        )
      }
    }

    if (input.name) {
      const conflict = this.findByIdOrName(input.name)
      if (conflict && (conflict.status === "starting" || conflict.status === "active")) {
        throw new Error(
          `tunnel name "${input.name}" already in use by active tunnel ${conflict.id}`,
        )
      }
    }

    const desc: TunnelDescriptor = {
      id,
      provider,
      targetHost,
      targetPort: input.targetPort,
      publicUrl: "",
      status: "starting",
      pid: null,
      createdAt: new Date().toISOString(),
      ...(input.name ? { name: input.name } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(input.autostart ? { autostart: true } : {}),
      ...(input.hostname ? { hostname: input.hostname } : {}),
      ...(input.tunnelId ? { tunnelId: input.tunnelId } : {}),
      ...(input.credentialsFile ? { credentialsFile: input.credentialsFile } : {}),
    }

    const prov = await this.pickProviderForTest(provider, desc)
    const entry: TunnelEntry = { desc, provider: prov }
    this.tunnels.set(id, entry)
    this.schedulePersist()

    await this.startEntry(entry)
    return { ...desc }
  }

  /**
   * Drive an entry's provider through start and fold the result back into
   * its descriptor. On failure the descriptor is marked `error` and the
   * error re-thrown (callers that want best-effort — e.g. boot restore —
   * catch it). Shared by `create` and `restoreOnBoot`.
   */
  private async startEntry(entry: TunnelEntry): Promise<void> {
    const { desc, provider } = entry
    desc.status = "starting"
    delete desc.lastError
    this.schedulePersist()

    const workspaceDir = this.workspace
    await mkdir(join(workspaceDir, ".agentproto"), { recursive: true }).catch(() => {
      // ignore if already exists or not writable
    })

    let result: { publicUrl: string; pid: number | null }
    try {
      result = await provider.start({
        target: { host: desc.targetHost, port: desc.targetPort },
        workspace: workspaceDir,
        onLog: line => this.onLog?.(line),
      })
    } catch (err) {
      desc.status = "error"
      desc.lastError = err instanceof Error ? err.message : String(err)
      this.schedulePersist()
      throw err
    }

    desc.publicUrl = result.publicUrl
    desc.pid = result.pid
    desc.status = "active"
    delete desc.stoppedAt
    this.schedulePersist()
  }

  /**
   * Relaunch every `autostart` tunnel that isn't currently running. Called
   * once on daemon boot — `loadFromDisk` has already ghosted formerly-live
   * entries to `stopped` and given autostart ones a real provider. Quick
   * tunnels are skipped (a relaunch yields a fresh random URL, defeating
   * the point); named tunnels come back on their stable hostname.
   *
   * Best-effort: a provider that fails to start leaves its descriptor in
   * `error` and the others still come up.
   */
  async restoreOnBoot(): Promise<void> {
    const toStart = Array.from(this.tunnels.values()).filter(
      e => e.desc.autostart === true && e.desc.status === "stopped",
    )
    for (const entry of toStart) {
      // Autostart eligibility is data-driven: a provider whose public URL is
      // NOT stable across restarts (e.g. cloudflare-quick) gets a fresh URL on
      // relaunch, defeating the point — skip it. Read by slug so it holds even
      // for a test-injected mock that carries no capabilities. Third-party
      // providers (caps unknown here) are attempted.
      const caps = builtinProviderCapabilities(entry.desc.provider)
      if (caps && caps.stableUrl === false) {
        this.onLog?.(
          `[tunnel] skipping autostart for ephemeral-URL tunnel ${entry.desc.name ?? entry.desc.id} ` +
            `(URL would change on relaunch — use a stable-URL provider)`,
        )
        continue
      }
      this.onLog?.(
        `[tunnel] autostart: relaunching ${entry.desc.name ?? entry.desc.id} → ${entry.desc.hostname ?? "?"}`,
      )
      try {
        // loadFromDisk left a stub here; build the real provider now (async —
        // may dynamic-import a third-party package or read creds).
        entry.provider = await this.pickProviderForTest(entry.desc.provider, entry.desc)
        await this.startEntry(entry)
      } catch (err) {
        this.onLog?.(
          `[tunnel] autostart failed for ${entry.desc.name ?? entry.desc.id}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  list(): TunnelDescriptor[] {
    return Array.from(this.tunnels.values()).map(e => ({ ...e.desc }))
  }

  get(id: string): TunnelDescriptor | undefined {
    const entry = this.tunnels.get(id)
    return entry ? { ...entry.desc } : undefined
  }

  findByIdOrName(idOrName: string): TunnelDescriptor | undefined {
    const byId = this.tunnels.get(idOrName)
    if (byId) return { ...byId.desc }
    for (const entry of this.tunnels.values()) {
      if (entry.desc.name === idOrName) return { ...entry.desc }
    }
    return undefined
  }

  async stop(idOrName: string): Promise<boolean> {
    const entry = this.findEntryByIdOrName(idOrName)
    if (!entry) return false
    if (entry.desc.status === "stopped") return true

    try {
      await entry.provider.stop()
    } catch {
      // swallow — provider may already be dead
    }

    entry.desc.status = "stopped"
    entry.desc.stoppedAt = new Date().toISOString()
    this.schedulePersist()
    return true
  }

  async shutdown(): Promise<void> {
    const active = Array.from(this.tunnels.values()).filter(
      e => e.desc.status === "starting" || e.desc.status === "active",
    )
    await Promise.allSettled(
      active.map(async e => {
        try {
          await e.provider.stop()
        } catch {
          // swallow
        }
        e.desc.status = "stopped"
        e.desc.stoppedAt = new Date().toISOString()
      }),
    )
    // Flush persist timer if scheduled
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
      this.persistNow()
    }
  }

  // ── test seam ─────────────────────────────────────────────────────
  // Subclasses (tests) override this to inject a mock provider. The
  // descriptor is passed so a real provider can be built with its
  // hostname / tunnelId / credentials. Async because the default path may
  // dynamic-import a third-party provider package.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async pickProviderForTest(
    _provider: TunnelProvider,
    desc: TunnelDescriptor,
  ): Promise<RemoteProvider> {
    const slug = normalizeProviderSlug(desc.provider)
    const creds = await this.credsForDescriptor(desc)
    const provider = await resolveTunnelProvider(slug, { creds })
    if (!provider) {
      throw new Error(`unknown tunnel provider: ${desc.provider}`)
    }
    return provider
  }

  /**
   * Build the creds passed to a provider: stored creds (ngrok authtoken,
   * third-party secrets) merged with descriptor-carried config (named's
   * hostname/tunnelId/credentialsFile), descriptor taking precedence.
   */
  private async credsForDescriptor(
    desc: TunnelDescriptor,
  ): Promise<TunnelCreds> {
    const slug = normalizeProviderSlug(desc.provider)
    const stored = this.readCreds ? (await this.readCreds(slug)) ?? {} : {}
    const creds: TunnelCreds = { ...stored }
    if (desc.hostname) creds.hostname = desc.hostname
    if (desc.tunnelId) creds.tunnelId = desc.tunnelId
    if (desc.credentialsFile) creds.credentialsFile = desc.credentialsFile
    return creds
  }

  // ── private ──────────────────────────────────────────────────────

  private findEntryByIdOrName(idOrName: string): TunnelEntry | undefined {
    const byId = this.tunnels.get(idOrName)
    if (byId) return byId
    for (const entry of this.tunnels.values()) {
      if (entry.desc.name === idOrName) return entry
    }
    return undefined
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistNow()
    }, 1_500)
    // Don't keep the process alive just for a persist flush.
    if (this.persistTimer.unref) this.persistTimer.unref()
  }

  private persistNow(): void {
    try {
      const all = Array.from(this.tunnels.values()).map(e => e.desc)
      // Newest first, capped to HISTORY_CAP.
      const sliced = all.slice(-HISTORY_CAP)
      const payload: PersistedTunnels = {
        savedAt: new Date().toISOString(),
        tunnels: sliced,
      }
      mkdirSync(dirname(this.persistPath), { recursive: true })
      writeFileSync(this.persistPath, JSON.stringify(payload, null, 2) + "\n", "utf8")
    } catch {
      // Best-effort persistence — a write failure must not crash the daemon.
    }
  }

  private loadFromDisk(): void {
    if (!existsSync(this.persistPath)) return
    let raw: string
    try {
      raw = readFileSync(this.persistPath, "utf8")
    } catch {
      return
    }
    let parsed: PersistedTunnels
    try {
      parsed = JSON.parse(raw) as PersistedTunnels
    } catch {
      return
    }
    if (!Array.isArray(parsed.tunnels)) return

    for (const desc of parsed.tunnels) {
      if (!desc.id) continue
      // Tunnels that were "starting" or "active" at last save are dead
      // now — the child process is gone. Mark them stopped (GHOST pattern).
      const ghosted: TunnelDescriptor = {
        ...desc,
        status:
          desc.status === "starting" || desc.status === "active"
            ? "stopped"
            : desc.status,
        pid: null,
        ...((desc.status === "starting" || desc.status === "active")
          ? { stoppedAt: new Date().toISOString() }
          : {}),
      }
      // Every loaded entry starts stubbed — its child process is gone. The
      // real provider is built lazily (async) by `restoreOnBoot` for autostart
      // entries; non-autostart entries are kept only for history and never
      // start, so the stub (which throws on start) is correct for them.
      this.tunnels.set(desc.id, { desc: ghosted, provider: makeStubProvider() })
    }
  }
}

// ── module-level helpers ───────────────────────────────────────────

function makeStubProvider(): RemoteProvider {
  return {
    id: "stub",
    async start() {
      throw new Error("stub provider: cannot start a ghost tunnel entry")
    },
    async stop() {
      // no-op — nothing to kill
    },
  }
}
