import { fork } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { CatalogModelsQuery, CatalogModelsResponse } from "@agentproto/runtime"
import type { AdapterListing, listHarnessCapabilities } from "./resolve.js"

export type DiscoveryRequest =
  | { kind: "adapters" }
  | { kind: "capabilities"; adapter?: string }
  | { kind: "models"; query: CatalogModelsQuery }

/** Only discovery metadata crosses IPC; adapter implementations stay in the worker. */
export function runDiscoveryWorker(request: DiscoveryRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // serve.ts is bundled into dist/cli.mjs; the worker is a sibling build entry.
    const child = fork(fileURLToPath(new URL("./adapter-discovery-worker.mjs", import.meta.url)), [], {
      execArgv: [],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    })
    let reply: { ok: boolean; result?: unknown; error?: string } | undefined
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("Adapter discovery timed out after 30 seconds"))
    }, 30_000)
    child.once("error", error => { clearTimeout(timer); reject(error) })
    child.once("message", message => {
      if (message && typeof message === "object" && "ok" in message) {
        reply = message as typeof reply
      }
    })
    child.once("exit", code => {
      clearTimeout(timer)
      if (code === 0 && reply?.ok) resolve(reply.result)
      else reject(new Error(reply?.error ?? `Adapter discovery exited with code ${code}`))
    })
    child.send(request, error => {
      if (error) { child.kill(); clearTimeout(timer); reject(error) }
    })
  })
}

/** Bound retention and coalesce UI polling; a failed probe is never cached. */
export function createIsolatedDiscovery(
  run: (request: DiscoveryRequest) => Promise<unknown> = runDiscoveryWorker,
  now: () => number = Date.now,
) {
  const cache = new Map<string, { expires: number; value: unknown }>()
  const pending = new Map<string, Promise<unknown>>()
  let generation = 0
  let outstanding = 0
  let lane: Promise<unknown> = Promise.resolve()
  const query = (request: DiscoveryRequest): Promise<unknown> => {
    const key = JSON.stringify(request)
    const found = cache.get(key)
    if (found && found.expires > now()) return Promise.resolve(found.value)
    const inFlight = pending.get(key)
    if (inFlight) return inFlight
    if (outstanding >= 32) return Promise.reject(new Error("Adapter discovery queue is full"))
    outstanding++
    const startedGeneration = generation
    // One cold importer at a time, even when several panels ask different
    // questions. A UI refresh must not create a native-library spawn storm.
    const probe = lane.then(() => run(request))
    lane = probe.then(() => undefined, () => undefined)
    const result = probe.then(value => {
      if (generation === startedGeneration) {
        cache.delete(key)
        cache.set(key, { expires: now() + (request.kind === "adapters" ? 60_000 : 5_000), value })
        while (cache.size > 32) cache.delete(cache.keys().next().value!)
      }
      return value
    }).finally(() => {
      outstanding--
      if (pending.get(key) === result) pending.delete(key)
    })
    pending.set(key, result)
    return result
  }
  return {
    adapters: () => query({ kind: "adapters" }) as Promise<AdapterListing[]>,
    capabilities: (opts?: { adapter?: string }) =>
      query({ kind: "capabilities", ...(opts?.adapter ? { adapter: opts.adapter } : {}) }) as ReturnType<typeof listHarnessCapabilities>,
    models: (queryInput: CatalogModelsQuery) => query({ kind: "models", query: queryInput }) as Promise<CatalogModelsResponse>,
    invalidate() { generation++; cache.clear(); pending.clear() },
  }
}
