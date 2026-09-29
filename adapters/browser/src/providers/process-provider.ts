import {
  defineBrowser,
  type BrowserConfigStep,
  type BrowserHealth,
  type BrowserHostContext,
  type BrowserInstall,
  type BrowserInstance,
  type BrowserProvider,
  type BrowserRequires,
} from "@agentproto/driver-browser"
import { resolveLaunch, type ResolveLaunchConfig } from "../lib/resolve-launch.js"
import type { BrowserAdapterStartOptions } from "../types.js"
import type { FacadeLaunchOptions } from "./facade-options.js"

/** A `BrowserProvider` whose `launch` also takes the legacy start knobs. */
export type FacadeProvider = Omit<BrowserProvider, "launch"> & {
  launch(opts: FacadeLaunchOptions, ctx: BrowserHostContext): Promise<BrowserInstance>
}

export interface ProcessProviderSpec {
  id: string
  name: string
  description: string
  defaultPort: number
  healthPath: string
  install?: BrowserInstall[]
  config?: BrowserConfigStep[]
  requires?: BrowserRequires
  resolveLocalCmd: (opts: FacadeLaunchOptions) => ReturnType<ResolveLaunchConfig["resolveLocalCmd"]>
  /**
   * Runs before the spawn (bureau starts camofox here). `env` supplies extra env for the
   * child; `stop` releases whatever `prepare` started — called immediately if the spawn
   * that follows fails, and wired into the returned instance's `stop()` on success, so a
   * dependency `prepare` launches is never orphaned.
   */
  prepare?: (
    opts: FacadeLaunchOptions,
    ctx: BrowserHostContext,
  ) => Promise<{ env: (port: number) => Record<string, string>; stop: () => Promise<void> }>
  killProcessGroup?: boolean
}

function toStartOptions(opts: FacadeLaunchOptions, ctx: BrowserHostContext): BrowserAdapterStartOptions {
  return {
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.camofoxPort !== undefined ? { camofoxPort: opts.camofoxPort } : {}),
    ...(opts.launchCmd !== undefined ? { launchCmd: opts.launchCmd } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(ctx.log !== undefined ? { log: ctx.log } : {}),
    ...(opts.location !== undefined ? { location: opts.location } : {}),
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.binPath !== undefined ? { binPath: opts.binPath } : {}),
    ...(opts.initialWaitMs !== undefined ? { initialWaitMs: opts.initialWaitMs } : {}),
  }
}

async function probe(url: string): Promise<BrowserHealth> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 3000)
  try {
    const res = await fetch(url, { signal: ac.signal })
    return res.ok ? { ok: true } : { ok: false, reason: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, reason: `unreachable: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A kit provider for a plain HTTP service the adapter spawns and health-polls
 * (bureau, chromium). It has no page-control driver of its own: `attach`
 * throws, and callers use the service's own endpoint.
 */
export function createProcessProvider(spec: ProcessProviderSpec): FacadeProvider {
  const provider = defineBrowser({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    version: "1.0.0",
    transport: "http",
    location: "local",
    install: spec.install ?? [],
    config: spec.config ?? [],
    requires: spec.requires ?? {},
    async launch(rawOpts, ctx) {
      const opts: FacadeLaunchOptions = rawOpts
      const prepared = spec.prepare ? await spec.prepare(opts, ctx) : undefined
      let instance: Awaited<ReturnType<typeof resolveLaunch>>
      try {
        instance = await resolveLaunch({
          handle: {
            id: spec.id,
            defaultPort: spec.defaultPort,
            healthPath: spec.healthPath,
            location: "local",
            ...(spec.requires ? { requires: spec.requires } : {}),
          },
          opts: toStartOptions(opts, ctx),
          label: spec.id,
          resolveLocalCmd: () => spec.resolveLocalCmd(opts),
          ...(prepared ? { extraEnv: prepared.env } : {}),
          ...(spec.killProcessGroup ? { killProcessGroup: true } : {}),
        })
      } catch (err) {
        // The spawn that `prepare` started (e.g. bureau's camofox) must not outlive this failure.
        await prepared?.stop().catch(() => {})
        throw err
      }
      let stopped = false
      return {
        id: `${spec.id}:${opts.label ?? "default"}@${new URL(instance.baseUrl).host}`,
        endpoints: { rest: instance.baseUrl },
        ...(instance.pid !== undefined ? { pid: instance.pid } : {}),
        wasAlreadyRunning: instance.wasAlreadyRunning,
        async health() {
          if (stopped) return { ok: false, reason: "stopped" }
          return probe(instance.baseUrl + spec.healthPath)
        },
        async attach() {
          throw new Error(
            `[${spec.id}] this provider manages the service process only; use its endpoint ${instance.baseUrl} directly`,
          )
        },
        async stop() {
          if (stopped) return
          stopped = true
          if (!instance.wasAlreadyRunning) await instance.stop()
          await prepared?.stop().catch(() => {})
        },
      }
    },
  })
  return provider as FacadeProvider
}
