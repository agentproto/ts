import type { BrowserProvider } from "@agentproto/driver-browser"
import type { BrowserAdapterHandle, BrowserAdapterInstance, BrowserAdapterStartOptions } from "../types.js"
import type { FacadeLaunchOptions } from "./facade-options.js"
import type { FacadeProvider } from "./process-provider.js"

export interface AdapterHandleMeta {
  defaultPort: number
  healthPath: string
  /** Keep the legacy display strings stable for callers that print them. */
  name?: string
  description?: string
}

type AnyProvider = FacadeProvider | BrowserProvider

/**
 * Wrap a kit browser provider in the legacy `BrowserAdapterHandle` shape:
 * `ensure(opts)` is `provider.launch(...)` mapped back to a
 * `BrowserAdapterInstance`.
 */
export function toAdapterHandle(provider: AnyProvider, meta: AdapterHandleMeta): BrowserAdapterHandle {
  const launch = provider.launch as FacadeProvider["launch"]
  return {
    id: provider.id,
    name: meta.name ?? provider.name,
    description: meta.description ?? provider.description,
    defaultPort: meta.defaultPort,
    healthPath: meta.healthPath,
    location: provider.location === "remote" ? "cloud" : "local",
    install: provider.install.map((i) => ({ ...i })),
    config: provider.config.map((c) => ({
      ...c,
      ...(c.options ? { options: [...c.options] } : {}),
      ...(c.persist ? { persist: { ...c.persist } } : {}),
    })),
    requires: {
      ...(provider.requires.os ? { os: [...provider.requires.os] } : {}),
      ...(provider.requires.arch ? { arch: [...provider.requires.arch] } : {}),
      ...(provider.requires.nativeLaunchOs ? { nativeLaunchOs: [...provider.requires.nativeLaunchOs] } : {}),
    },
    async ensure(opts: BrowserAdapterStartOptions): Promise<BrowserAdapterInstance> {
      const port = opts.port ?? meta.defaultPort
      const launchOpts: FacadeLaunchOptions = {
        port,
        ...(opts.camofoxPort !== undefined ? { camofoxPort: opts.camofoxPort } : {}),
        ...(opts.launchCmd !== undefined ? { launchCmd: opts.launchCmd } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.location !== undefined ? { location: opts.location } : {}),
        ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
        ...(opts.binPath !== undefined ? { binPath: opts.binPath } : {}),
        ...(opts.initialWaitMs !== undefined ? { initialWaitMs: opts.initialWaitMs } : {}),
      }
      const instance = await launch.call(provider, launchOpts, opts.log ? { log: opts.log } : {})
      const baseUrl = (instance.endpoints.rest ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "")
      const healthy = (await instance.health()).ok
      return {
        id: provider.id,
        port: Number(new URL(baseUrl).port) || port,
        baseUrl,
        ...(instance.pid !== undefined ? { pid: instance.pid } : {}),
        wasAlreadyRunning: instance.wasAlreadyRunning,
        healthy,
        stop: () => instance.stop(),
      }
    },
  }
}
