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
import { quickTunnelProvider } from "./remote-providers/quick.js"
import type { RemoteProvider } from "./remote-providers/types.js"

export type TunnelStatus = "starting" | "active" | "stopped" | "error"

export type TunnelProvider = "quick"

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
}

export interface TunnelRegistryOptions {
  /** Absolute path for persistence file. Defaults to ~/.agentproto/tunnels.json */
  persistPath?: string
  /** Absolute path to workspace — used as scratch dir for provider config files. */
  workspace?: string
  /** Hook for surfacing provider log lines. */
  onLog?: (line: string) => void
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
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: TunnelRegistryOptions = {}) {
    this.persistPath = opts.persistPath ?? TUNNELS_FILE_PATH()
    this.workspace = opts.workspace ?? homedir()
    this.onLog = opts.onLog

    this.loadFromDisk()
  }

  async create(input: CreateTunnelInput): Promise<TunnelDescriptor> {
    const id = randomUUID()
    const provider = input.provider ?? "quick"
    const targetHost = input.targetHost ?? "127.0.0.1"

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
    }

    const prov = this.pickProviderForTest(provider)
    const entry: TunnelEntry = { desc, provider: prov }
    this.tunnels.set(id, entry)
    this.schedulePersist()

    const workspaceDir = this.workspace
    await mkdir(join(workspaceDir, ".agentproto"), { recursive: true }).catch(() => {
      // ignore if already exists or not writable
    })

    let result: { publicUrl: string; pid: number | null }
    try {
      result = await prov.start({
        target: { host: targetHost, port: input.targetPort },
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
    this.schedulePersist()

    return { ...desc }
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected pickProviderForTest(_id: TunnelProvider): RemoteProvider {
    return pickProvider(_id)
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
      // Ghost entries need a stub provider so the entry shape is valid,
      // but its start/stop are never called (the entry is already stopped).
      const stubProvider = makeStubProvider()
      this.tunnels.set(desc.id, { desc: ghosted, provider: stubProvider })
    }
  }
}

// ── module-level helpers ───────────────────────────────────────────

function pickProvider(id: TunnelProvider): RemoteProvider {
  if (id === "quick") return quickTunnelProvider()
  const _exhaustive: never = id
  throw new Error(`unknown tunnel provider: ${String(_exhaustive)}`)
}

function makeStubProvider(): RemoteProvider {
  return {
    id: "quick",
    async start() {
      throw new Error("stub provider: cannot start a ghost tunnel entry")
    },
    async stop() {
      // no-op — nothing to kill
    },
  }
}
