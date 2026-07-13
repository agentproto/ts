import { spawn, type ChildProcess } from "node:child_process"
import type { NamedScript } from "../config.js"
import {
  hookEnv,
  peerEnv,
  ENV_VARS,
  type WorktreeEnvContext,
  type PeerService,
} from "../env.js"
import { allocatePort } from "./ports.js"
import { serviceHostname } from "./slug.js"
import type { ProxyTable } from "./proxy-table.js"

/** A declared service with its resolved port / hostname / proxy URL. */
export interface ServiceRuntime {
  name: string
  command: string
  hostname: string
  port: number
  url: string
}

/** The observable state of a service (v1: no restart — just track the exit). */
export interface ServiceStatus {
  name: string
  hostname: string
  port: number
  url: string
  pid: number | null
  status: "running" | "exited"
  exitCode: number | null
  startedAt: string | null
}

export interface SupervisorOptions {
  ctx: WorktreeEnvContext
  /** The `type: "service"` scripts from the repo's `agentproto.json`. */
  services: readonly NamedScript[]
  /** Repo label for the hostname (typically the repo dir basename). */
  repo: string
  /** Whether the worktree's branch is the repo default (drops the branch label). */
  isDefaultBranch: boolean
  /** Port the reverse proxy listens on — used to build each service's URL. */
  proxyPort: number
  /** When given, service hostnames are (de)registered here as they start/stop. */
  proxyTable?: ProxyTable
}

interface Tracked {
  runtime: ServiceRuntime
  child: ChildProcess | null
  status: "running" | "exited"
  exitCode: number | null
  startedAt: string | null
}

/**
 * Supervises the long-running services declared for one worktree. Ports are
 * allocated up front for every declared service so peer discovery is complete
 * (a service started later is visible to one started earlier only if its port
 * was reserved — which it is), and hostnames register with the proxy table as
 * services come up.
 *
 * v1 scope: no crash-restart loop. A service that exits is marked `exited`
 * with its code; callers decide what to do.
 */
export class ServiceSupervisor {
  private readonly opts: SupervisorOptions
  private readonly tracked = new Map<string, Tracked>()

  private constructor(opts: SupervisorOptions, tracked: Map<string, Tracked>) {
    this.opts = opts
    this.tracked = tracked
  }

  /**
   * Build a supervisor, allocating a port for every declared service (declared
   * port if free, else ephemeral) and resolving each one's hostname + URL.
   * Nothing is spawned yet.
   */
  static async create(opts: SupervisorOptions): Promise<ServiceSupervisor> {
    const tracked = new Map<string, Tracked>()
    const reserved = new Set<number>()
    for (const svc of opts.services) {
      const port = await allocatePort(svc.port, reserved)
      reserved.add(port)
      const hostname = serviceHostname({
        script: svc.name,
        branch: opts.ctx.branchName,
        repo: opts.repo,
        isDefaultBranch: opts.isDefaultBranch,
      })
      const runtime: ServiceRuntime = {
        name: svc.name,
        command: svc.command,
        hostname,
        port,
        url: `http://${hostname}:${opts.proxyPort}`,
      }
      tracked.set(svc.name, {
        runtime,
        child: null,
        status: "exited",
        exitCode: null,
        startedAt: null,
      })
    }
    return new ServiceSupervisor(opts, tracked)
  }

  /** Every declared service's resolved runtime (ports/urls), regardless of state. */
  runtimes(): ServiceRuntime[] {
    return [...this.tracked.values()].map((t) => t.runtime)
  }

  /** Peers of `name` — every other declared service, as `PeerService` records. */
  private peersOf(name: string): PeerService[] {
    return this.runtimes()
      .filter((r) => r.name !== name)
      .map((r) => ({ name: r.name, port: r.port, url: r.url }))
  }

  private toStatus(t: Tracked): ServiceStatus {
    return {
      name: t.runtime.name,
      hostname: t.runtime.hostname,
      port: t.runtime.port,
      url: t.runtime.url,
      pid: t.child?.pid ?? null,
      status: t.status,
      exitCode: t.exitCode,
      startedAt: t.startedAt,
    }
  }

  /**
   * Start a declared service. Idempotent: returns the current status if it's
   * already running. Injects `AGENTPROTO_PORT` / `AGENTPROTO_URL` for itself
   * plus `AGENTPROTO_SERVICE_<PEER>_PORT|URL` for every sibling.
   */
  start(name: string): ServiceStatus {
    const t = this.tracked.get(name)
    if (!t) throw new Error(`no service "${name}" declared in agentproto.json`)
    if (t.status === "running" && t.child) return this.toStatus(t)

    const env: Record<string, string> = {
      ...hookEnv(this.opts.ctx),
      [ENV_VARS.port]: String(t.runtime.port),
      [ENV_VARS.url]: t.runtime.url,
      ...peerEnv(this.peersOf(name)),
    }

    const child = spawn(t.runtime.command, {
      cwd: this.opts.ctx.worktreePath,
      shell: true,
      env: { ...process.env, ...env },
      stdio: "inherit",
    })
    t.child = child
    t.status = "running"
    t.exitCode = null
    t.startedAt = new Date().toISOString()

    child.on("exit", (code) => {
      t.status = "exited"
      t.exitCode = code
    })
    child.on("error", () => {
      t.status = "exited"
      if (t.exitCode === null) t.exitCode = -1
    })

    this.opts.proxyTable?.set(t.runtime.hostname, t.runtime.port)
    return this.toStatus(t)
  }

  /** Stop a running service (SIGTERM). Returns whether one was running. */
  async stop(name: string): Promise<boolean> {
    const t = this.tracked.get(name)
    if (!t) throw new Error(`no service "${name}" declared in agentproto.json`)
    this.opts.proxyTable?.delete(t.runtime.hostname)
    const child = t.child
    if (!child || t.status !== "running") return false
    return new Promise<boolean>((resolve) => {
      const done = (): void => {
        t.status = "exited"
        resolve(true)
      }
      child.once("exit", done)
      child.kill("SIGTERM")
    })
  }

  /** Stop every running service. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.tracked.keys()].map((name) => this.stop(name)))
  }

  /** Current status of a single service, or `undefined` if not declared. */
  get(name: string): ServiceStatus | undefined {
    const t = this.tracked.get(name)
    return t ? this.toStatus(t) : undefined
  }

  /** Current status of every declared service. */
  list(): ServiceStatus[] {
    return [...this.tracked.values()].map((t) => this.toStatus(t))
  }
}
