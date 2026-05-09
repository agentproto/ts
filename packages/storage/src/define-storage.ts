import { createDoctype } from "@agentproto/define-doctype"
import { storageFrontmatterSchema } from "./schema.js"
import type {
  StorageRuntimeHandle,
  StorageRuntimeInput,
} from "./types.js"

/**
 * AIP-35 reference implementation of `defineStorage`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineStorage (AIP-35): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the manifest portion of the input. The
 * AIP-43 runtime slots (`factory`, `capabilities`) are HOST-OPAQUE
 * TS-runtime metadata — they don't exist in the AIP-35 frontmatter
 * schema, so we strip them before validation and re-attach them in
 * `build`. The zod schema stays `.strict()` (typo-catching for MD
 * authors); runtime callers get the extra slots via the input type.
 *
 * Generic params:
 *   TFactory      — host-typed factory function shape (e.g. a Mastra
 *                   `(input) => MastraFilesystem` for the Guilde host).
 *                   Defaults to `unknown`.
 *   TCapabilities — opaque metadata the registry queries on. Per
 *                   AIP-43 § Capability metadata namespace, hosts
 *                   SHOULD agree on conventional keys
 *                   (bridgeable / transport / pairsWith / serverReachable).
 */
const defineStorageInner = createDoctype<
  StorageRuntimeInput,
  StorageRuntimeHandle
>({
  aip: 35,
  name: "storage",
  readDescription: false,
  // AIP-35 makes `id` standalone-only — inline storage blocks (every
  // host registration we care about) carry only `provider` + `config`.
  // Fall back to `provider` for the cross-AIP id-pattern check; the
  // resolution order mirrors AIP-43 § Identity (id → provider → slug).
  readIdentity: def => {
    if (typeof def.id === "string" && def.id.length > 0) return def.id
    return def.provider
  },
  validate(def) {
    // Strip runtime-only slots before AIP-35 schema validation —
    // they're not part of the manifest spec, can't round-trip
    // through YAML, and adding them to the strict schema would mean
    // every STORAGE.md author has to know about TS internals.
    const { factory: _factory, capabilities: _capabilities, ...manifest } = def
    const result = storageFrontmatterSchema.safeParse(manifest)
    if (!result.success) {
      throw new Error(
        `defineStorage (AIP-35): ${result.error.issues
          .map(i => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
    // TODO: spec-35-specific cross-field rules (if/then/allOf in
    // the JSON Schema) — those don't translate to zod cleanly and
    // belong here. See @agentproto/operator's autonomy=gated rule.
  },
  build(def) {
    // Re-attach the runtime slots after validation. Capabilities are
    // shallow-frozen here so registry consumers can rely on
    // immutability; factory is left as-is (it's a function ref).
    const { factory, capabilities, ...manifest } = def
    return {
      ...manifest,
      ...(factory !== undefined ? { factory } : {}),
      ...(capabilities !== undefined
        ? { capabilities: Object.freeze({ ...capabilities }) }
        : {}),
    } as StorageRuntimeHandle
  },
})

/**
 * Type-aware wrapper preserving `TFactory` / `TCapabilities` generics
 * across the call (the underlying `createDoctype` factory is invariant
 * over its TDef/THandle pair, so we expose the parametric face here).
 */
export function defineStorage<
  TFactory = unknown,
  TCapabilities extends Record<string, unknown> = Record<string, unknown>,
>(
  definition: StorageRuntimeInput<TFactory, TCapabilities>,
): StorageRuntimeHandle<TFactory, TCapabilities> {
  return defineStorageInner(
    definition as StorageRuntimeInput,
  ) as StorageRuntimeHandle<TFactory, TCapabilities>
}
