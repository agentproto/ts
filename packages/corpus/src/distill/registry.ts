/**
 * Distill registry — the catalog of distill kinds.
 *
 * Distill is four swappable slots: SOURCE (raw material) → IMPORTER (how to
 * render it) → DISTILLER (the LLM) → TARGET (where entries land). A
 * `DistillDescriptor` binds all four for one kind ("conversation", "web", …);
 * the registry holds them by id so the cron/worker can dispatch polymorphically
 * — adding a kind is registering a descriptor, with zero pipeline changes.
 *
 * Lightweight on purpose (mirrors the AIP-35 filesystem-provider registry):
 * descriptors are code-registered, so there is no `resolveConfig` / secrets /
 * UI-fields surface the way user-connected engine descriptors carry. Vendor-
 * neutral — the kit owns the contract + the generic runner; the per-kind
 * bindings live in each app's core package.
 */

import type { CorpusImporter } from "../importers/types.js"
import type { ClockPort } from "../ports/clock.port.js"
import type { FsPort } from "../ports/fs.port.js"
import type { DistillPort } from "./types.js"

/**
 * Who a distill runs for. `id` is the durable handle carried on the queued job
 * (`resolveScope` rehydrates it in the worker); `userId` feeds the job's owner.
 * Kinds extend this with their own scope fields (a guild id, a workspace id, …).
 */
export interface DistillScope {
  readonly id: string
  readonly userId: string
  readonly [key: string]: unknown
}

/** Where distilled entries land — the corpus filesystem for a scope. */
export interface DistillTarget {
  readonly fs: FsPort
  readonly clock: ClockPort
  /** Optional corpus root within the fs (defaults to the fs root, ""). */
  readonly root?: string
}

/**
 * SOURCE + IMPORTER bound to one scope. Co-constructed so both share a single
 * (cache-bearing) source instance: the importer resolves refs through it, and
 * `enumerate` lists the refs worth importing. Keeping them together is not just
 * convenience — it is what lets a windowed source load each thread once.
 */
export interface DistillBinding {
  /** The kit importer that resolves refs through this scope's source. */
  readonly importer: CorpusImporter
  /**
   * Refs to import this run — already filtered against `distilled` (the set of
   * provenance ids that already have ≥1 entry), so a re-run only sees fresh
   * material.
   */
  enumerate(distilled: ReadonlySet<string>): Promise<readonly string[]>
}

/**
 * One catalog entry: a distill kind, with its four slots bound to a scope.
 * Generic over the scope shape so each kind keeps its own typed scope while the
 * registry stores them uniformly.
 */
export interface DistillDescriptor<S extends DistillScope = DistillScope> {
  /** Stable kind id — "conversation" | "web" | … */
  readonly id: string
  /** Queue type the cron submits and the worker handles, e.g. "distill:conversation". */
  readonly jobType: string
  /** Human-readable label (diagnostics / surfaces). */
  readonly label: string
  /** Tags applied to every source distilled by this kind (e.g. ["personal"]). */
  readonly tags?: readonly string[]

  /** SOURCE + IMPORTER slots, bound to the scope. */
  bind(scope: S): DistillBinding
  /** DISTILLER slot: the LLM boundary for this scope. */
  distiller(scope: S): DistillPort
  /** TARGET slot: where entries land for this scope. */
  target(scope: S): Promise<DistillTarget>

  /**
   * Consent gate. Checked at fan-out (bulk filter) AND re-checked in the worker
   * (authoritative — it can flip between enqueue and execution). Absent ⇒ no gate.
   */
  consent?(scope: S): Promise<boolean>
  /** Who to run for. Implementations should stream/paginate at scale. */
  scopes(): Promise<readonly S[]>
  /** Rehydrate a scope from its `id` — the worker holds only the id post-enqueue. */
  resolveScope(scopeId: string): Promise<S>
}

export interface DistillRegistry {
  /** Register a kind. Throws on duplicate id. */
  register<S extends DistillScope>(descriptor: DistillDescriptor<S>): void
  has(id: string): boolean
  /** Resolve by id. Throws when the id was never registered. */
  resolve(id: string): DistillDescriptor
  /** All registered descriptors (for the cron fan-out + worker handler map). */
  list(): DistillDescriptor[]
}

export function createDistillRegistry(): DistillRegistry {
  const descriptors = new Map<string, DistillDescriptor>()

  return {
    register(descriptor) {
      if (descriptors.has(descriptor.id)) {
        throw new Error(`Distill descriptor "${descriptor.id}" is already registered`)
      }
      descriptors.set(descriptor.id, descriptor)
    },
    has(id) {
      return descriptors.has(id)
    },
    resolve(id) {
      const descriptor = descriptors.get(id)
      if (!descriptor) {
        throw new Error(
          `Distill descriptor "${id}" is not registered. Registered: ${[...descriptors.keys()].join(", ") || "(none)"}`
        )
      }
      return descriptor
    },
    list() {
      return [...descriptors.values()]
    },
  }
}
