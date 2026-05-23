/**
 * MultiAgentRuntime adapter registry — the seam third-party packages
 * use to plug substrates, dispatchers, participant executors, and
 * state stores into `agentproto run-swarm` without forking the CLI.
 *
 * A plugin module exports nothing required by name — it just imports
 * `register*` helpers from `@agentproto/cli/registry/runtime` and
 * calls them at module load. The CLI discovers plugins via:
 *
 *   1. `--plugin <module-id>` flags on `run-swarm`
 *   2. The `plugins[]` array in `~/.agentproto/config.json`
 *   3. Auto-registered built-ins (file substrate, mention dispatcher,
 *      fs state, agent-cli participant) — registered by
 *      `registerBuiltins()` at startup.
 *
 * Manifest `kind` strings are resolved through the registry: the kind
 * is the lookup key; the factory builds the concrete adapter from the
 * (loose) manifest config + shared context.
 */

import type {
  Dispatcher,
  ParticipantExecutor,
  StateStore,
  Substrate,
} from "@agentproto/agent-runtime"

// ── Context passed to every factory ──

/**
 * Shared context every factory receives. Carries the manifest's base
 * directory (for resolving relative paths declared in adapter configs)
 * and a `cleanup` collector so adapters that hold disposable resources
 * (MCP clients, sockets, child processes) can register teardown callbacks
 * that the CLI runs on shutdown.
 */
export interface AdapterContext {
  /** Absolute directory of the manifest file. */
  readonly baseDir: string
  /** Register a teardown callback to run when the swarm shuts down. */
  registerCleanup(fn: () => Promise<void> | void): void
}

// ── Loose config shape ──

/**
 * Manifest adapter blocks are loose: `{ kind: string, ...host-extension }`.
 * Each factory pulls its own typed fields off the config and validates
 * them inline.
 */
export interface AdapterConfig {
  readonly kind: string
  readonly [extension: string]: unknown
}

// ── Factory signatures ──

export type SubstrateFactory = (
  config: AdapterConfig,
  ctx: AdapterContext
) => Promise<Substrate> | Substrate

export type DispatcherFactory = (
  config: AdapterConfig,
  ctx: AdapterContext
) => Promise<Dispatcher> | Dispatcher

export type ExecutorFactory = (
  config: AdapterConfig,
  ctx: AdapterContext
) => Promise<ParticipantExecutor> | ParticipantExecutor

export type StateStoreFactory = (
  config: AdapterConfig,
  ctx: AdapterContext
) => Promise<StateStore> | StateStore

// ── Registry state ──

const substrates = new Map<string, SubstrateFactory>()
const dispatchers = new Map<string, DispatcherFactory>()
const executors = new Map<string, ExecutorFactory>()
const stateStores = new Map<string, StateStoreFactory>()

// ── Public registration API ──

export function registerSubstrate(kind: string, factory: SubstrateFactory): void {
  substrates.set(kind, factory)
}

export function registerDispatcher(
  kind: string,
  factory: DispatcherFactory
): void {
  dispatchers.set(kind, factory)
}

export function registerExecutor(kind: string, factory: ExecutorFactory): void {
  executors.set(kind, factory)
}

export function registerStateStore(
  kind: string,
  factory: StateStoreFactory
): void {
  stateStores.set(kind, factory)
}

// ── Lookup API (used by run-swarm wiring) ──

export function getSubstrateFactory(kind: string): SubstrateFactory | undefined {
  return substrates.get(kind)
}

export function getDispatcherFactory(
  kind: string
): DispatcherFactory | undefined {
  return dispatchers.get(kind)
}

export function getExecutorFactory(kind: string): ExecutorFactory | undefined {
  return executors.get(kind)
}

export function getStateStoreFactory(
  kind: string
): StateStoreFactory | undefined {
  return stateStores.get(kind)
}

export function listRegisteredKinds(): {
  substrates: readonly string[]
  dispatchers: readonly string[]
  executors: readonly string[]
  stateStores: readonly string[]
} {
  return {
    substrates: [...substrates.keys()],
    dispatchers: [...dispatchers.keys()],
    executors: [...executors.keys()],
    stateStores: [...stateStores.keys()],
  }
}

/**
 * Test-only: drop every registration. Plugin registrations persist for
 * the lifetime of the process, so tests that load + unload plugins use
 * this to start from a clean slate.
 */
export function _resetRegistryForTests(): void {
  substrates.clear()
  dispatchers.clear()
  executors.clear()
  stateStores.clear()
}
