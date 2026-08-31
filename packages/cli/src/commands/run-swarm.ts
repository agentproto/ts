/**
 * `agentproto run-swarm --manifest <path>`
 *
 * Loads a MultiAgentRuntime manifest and runs cycles in a loop. One
 * cycle = read substrate → dispatch → execute selected participants →
 * append → fire lifecycle.
 *
 * Adapter wiring goes through the runtime registry — built-in adapters
 * (file substrate, mention dispatcher, fs state, agent-cli participant)
 * are pre-registered; transport-specific adapters ship as separate
 * packages and register themselves when loaded via `--adapter <id>` or
 * the `adapters[]` array in `~/.agentproto/config.json`.
 */

import { parseArgs } from "node:util"
import { resolve as resolvePath } from "node:path"
import { parseDuration } from "../util/duration.js"
import {
  loadManifest,
  runTurn,
  type LoadedManifest,
  type MultiAgentRuntimeManifest,
  type ParticipantDescriptor,
  type ParticipantExecutor,
  type RuntimePorts,
  type StateStore,
  type Substrate,
  type Telemetry,
} from "@agentproto/agent-runtime"
import { stderrTelemetry } from "@agentproto/agent-runtime/adapters/telemetry"
import {
  getDispatcherFactory,
  getExecutorFactory,
  getStateStoreFactory,
  getSubstrateFactory,
  listRegisteredKinds,
  type AdapterConfig,
  type AdapterContext,
} from "../registry/runtime.js"
import { registerBuiltins } from "../registry/builtins.js"
import {
  loadAdapters,
  loadAdaptersFromConfig,
} from "../registry/adapters.js"

export async function runRunSwarm(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      manifest: { type: "string", short: "m" },
      once: { type: "boolean" },
      interval: { type: "string" },
      verbose: { type: "boolean", short: "v" },
      adapter: { type: "string", multiple: true },
    },
  })

  if (!values.manifest) {
    process.stderr.write(
      "agentproto run-swarm: --manifest <path> is required.\n"
    )
    return 2
  }

  let intervalMs = 2000
  if (values.interval) {
    const parsed = parseDuration(values.interval, "--interval")
    if (!parsed.ok) {
      process.stderr.write(`agentproto run-swarm: ${parsed.error}\n`)
      return 2
    }
    intervalMs = parsed.ms
  }

  registerBuiltins()
  const cliAdapters = values.adapter ?? []
  const configAdapters = await loadAdaptersFromConfig()
  await loadAdapters([...configAdapters, ...cliAdapters])

  const loaded = await loadManifest(resolvePath(values.manifest))
  const verbose = values.verbose === true

  const cleanups: Array<() => Promise<void> | void> = []
  const ctx: AdapterContext = {
    baseDir: loaded.baseDir,
    registerCleanup: (fn) => cleanups.push(fn),
  }

  const telemetry: Telemetry | undefined = verbose
    ? stderrTelemetry({ prefix: "agentproto run-swarm: " })
    : undefined

  let ports: RuntimePorts
  try {
    ports = await buildPorts(loaded, ctx, telemetry)
  } catch (err) {
    process.stderr.write(
      `agentproto run-swarm: ${err instanceof Error ? err.message : String(err)}\n`
    )
    await runCleanups(cleanups)
    return 1
  }

  const onceMode = values.once === true

  if (verbose) {
    logVerbose(`loaded manifest "${loaded.manifest.id}" from ${loaded.path}`)
    logVerbose(
      `participants: ${ports.participants.map((p) => p.displayName).join(", ")}`
    )
    logVerbose(
      `substrate=${ports.substrate.kind} dispatcher=${ports.dispatcher.kind} state=${ports.state.kind}`
    )
    const registered = listRegisteredKinds()
    logVerbose(
      `registered: substrates=[${registered.substrates.join(",")}] dispatchers=[${registered.dispatchers.join(",")}] executors=[${registered.executors.join(",")}] stateStores=[${registered.stateStores.join(",")}]`
    )
  }

  const controller = new AbortController()
  process.once("SIGINT", () => {
    if (verbose) logVerbose("SIGINT received, draining current cycle…")
    controller.abort()
  })

  try {
    do {
      if (controller.signal.aborted) break
      try {
        // Per-cycle progress is now emitted via the Telemetry port
        // (see stderrTelemetry above). The return value is still
        // useful for error context.
        await runTurn(ports, { signal: controller.signal })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`agentproto run-swarm: cycle failed — ${msg}\n`)
      }
      if (onceMode) break
      await sleep(intervalMs, controller.signal)
    } while (!controller.signal.aborted)
  } finally {
    await runCleanups(cleanups)
  }

  return 0
}

async function buildPorts(
  loaded: LoadedManifest,
  ctx: AdapterContext,
  telemetry: Telemetry | undefined
): Promise<RuntimePorts> {
  const manifest = loaded.manifest

  const substrate = await buildSubstrate(manifest, ctx)
  const dispatcher = await buildDispatcher(manifest, ctx)
  const state = await buildState(manifest, ctx)
  const participants = buildParticipants(manifest)
  const executors = await buildExecutors(manifest, ctx)

  return {
    substrate,
    dispatcher,
    state,
    participants,
    executors,
    ...(telemetry ? { telemetry } : {}),
  }
}

async function buildSubstrate(
  manifest: MultiAgentRuntimeManifest,
  ctx: AdapterContext
): Promise<Substrate> {
  const cfg = manifest.substrate as AdapterConfig
  const factory = getSubstrateFactory(cfg.kind)
  if (!factory) {
    throw new Error(
      `unknown substrate kind '${cfg.kind}'. Registered kinds: [${listRegisteredKinds().substrates.join(", ") || "(none)"}]. Pass --adapter <module-id> or add it to ~/.agentproto/config.json adapters[] to register a third-party substrate.`
    )
  }
  return factory(cfg, ctx)
}

async function buildDispatcher(
  manifest: MultiAgentRuntimeManifest,
  ctx: AdapterContext
) {
  const cfg = manifest.dispatcher as AdapterConfig
  const factory = getDispatcherFactory(cfg.kind)
  if (!factory) {
    throw new Error(
      `unknown dispatcher kind '${cfg.kind}'. Registered kinds: [${listRegisteredKinds().dispatchers.join(", ") || "(none)"}].`
    )
  }
  return factory(cfg, ctx)
}

async function buildState(
  manifest: MultiAgentRuntimeManifest,
  ctx: AdapterContext
): Promise<StateStore> {
  const cfg = (manifest.state ?? { kind: "fs" }) as AdapterConfig
  const factory = getStateStoreFactory(cfg.kind)
  if (!factory) {
    throw new Error(
      `unknown state-store kind '${cfg.kind}'. Registered kinds: [${listRegisteredKinds().stateStores.join(", ") || "(none)"}].`
    )
  }
  return factory(cfg, ctx)
}

function buildParticipants(
  manifest: MultiAgentRuntimeManifest
): readonly ParticipantDescriptor[] {
  return manifest.participants.map((p) => ({
    id: p.id,
    displayName: p.displayName ?? p.id,
    executor: p.executor,
    role: p.role,
    config: p.config,
    meta: p.meta,
  }))
}

async function buildExecutors(
  manifest: MultiAgentRuntimeManifest,
  ctx: AdapterContext
): Promise<ReadonlyMap<string, ParticipantExecutor>> {
  const map = new Map<string, ParticipantExecutor>()
  for (const p of manifest.participants) {
    const factory = getExecutorFactory(p.executor)
    if (!factory) {
      throw new Error(
        `unknown executor kind '${p.executor}'. Registered kinds: [${listRegisteredKinds().executors.join(", ") || "(none)"}]. Pass --adapter <module-id> or add the executor's package to ~/.agentproto/config.json adapters[].`
      )
    }
    const config: AdapterConfig = {
      kind: p.executor,
      ...(p.config ?? {}),
    }
    map.set(p.id, await factory(config, ctx))
  }
  return map
}

async function runCleanups(
  cleanups: ReadonlyArray<() => Promise<void> | void>
): Promise<void> {
  for (const fn of cleanups) {
    try {
      await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`agentproto run-swarm: cleanup failed — ${msg}\n`)
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveP) => {
    if (signal.aborted) {
      resolveP()
      return
    }
    const t = setTimeout(() => resolveP(), ms)
    signal.addEventListener("abort", () => {
      clearTimeout(t)
      resolveP()
    })
  })
}

function logVerbose(msg: string): void {
  process.stderr.write(`agentproto run-swarm: ${msg}\n`)
}
