import { createDoctype } from "@agentproto/define-doctype"
import type {
  ExecuteFn,
  ImplementsEntry,
  DriverDefinition,
  DriverHandle,
} from "./types.js"

/**
 * AIP-30 reference implementation of `defineDriver`.
 *
 * Returns a {@link DriverHandle} with defaults applied. The resolver
 * (`resolveDriver`) and runners (`runTool`) consume this shape and
 * dispatch contract calls to the per-tool execute bodies.
 *
 * Built on `createDoctype` from `@agentproto/define-doctype`: the
 * id-pattern + description-length validation and the top-level
 * `Object.freeze` are shared with every other AIP defineX. The
 * spec-30-specific parts (implements vs execute consistency, merging
 * `implementations[]` into the execute map, freezing nested arrays
 * and objects) live in `validate` and `build` below.
 *
 * Conformance highlights ([§ Conformance rules](https://agentproto.sh/docs/aip-30)):
 *  - Frontmatter is the source of truth — entries warn on mismatch and prefer frontmatter.
 *  - `execute[<toolId>]` MUST exist for every `implements[]` entry.
 *  - No I/O at module load — `defineDriver(...)` is pure construction.
 *
 * Two body-binding paths are accepted:
 *
 *  1. **Legacy bag** — `execute: { [toolId]: ExecuteFn }`. Used by
 *     `.md`-driven dynamic loading where the contract handle isn't
 *     in scope. Bodies receive `unknown`-typed inputs and must cast.
 *  2. **Typed implementations** — `implementations: ToolImplementation[]`.
 *     Each impl carries its contract handle so the body's `input`,
 *     `context`, and return are checked against the contract's
 *     generics at compile time. Authors get IERC20-style type safety.
 *
 * Both can coexist on the same provider. On the same tool id, the
 * typed `implementations[]` form wins over the legacy bag.
 */
export const defineDriver = createDoctype<DriverDefinition, DriverHandle>({
  aip: 30,
  name: "driver",
  validate(def) {
    if (def.implements.length === 0) {
      throw new Error(
        `defineDriver: id='${def.id}' must declare ≥1 implements[] entry`,
      )
    }
    // The execute-map vs implements[] consistency check needs the merged
    // map; building it once and validating in `build` is fine — but we
    // also want a precise error on per-tool missing bodies before we
    // commit to the build path. Run that check here against a previewed
    // merged map so the thrown message matches the historical wording
    // ("implements 'X' but no execute['X'] body provided").
    const previewMap = mergeExecuteMap(def)
    const declaredToolIds = new Set(
      def.implements.map((e) => normalizeToolId(e.tool)),
    )
    const executeKeys = new Set(Object.keys(previewMap))
    for (const toolId of declaredToolIds) {
      if (!executeKeys.has(toolId)) {
        throw new Error(
          `defineDriver: id='${def.id}' implements '${toolId}' but no execute['${toolId}'] body provided`,
        )
      }
    }
    for (const key of executeKeys) {
      if (!declaredToolIds.has(key)) {
        throw new Error(
          `defineDriver: id='${def.id}' has execute['${key}'] but '${key}' is not in implements[]`,
        )
      }
    }
  },
  build(def) {
    const executeMap = mergeExecuteMap(def)
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      version: def.version,
      kind: def.kind,
      implements: Object.freeze(def.implements.map(freezeImplements)),
      execute: Object.freeze(executeMap),
      install: Object.freeze([...(def.install ?? [])]),
      versionCheck: def.versionCheck,
      auth: def.auth,
      network: Object.freeze({
        egress: Object.freeze([...(def.network?.egress ?? [])]),
        ingress: Object.freeze([...(def.network?.ingress ?? [])]),
      }),
      region: Object.freeze([...(def.region ?? ["global"])]),
      policyTags: Object.freeze([...(def.policyTags ?? [])]),
      costOverride: def.costOverride,
      timeoutOverrideMs: def.timeoutOverrideMs,
      retryOverride: def.retryOverride,
      healthCheck: def.healthCheck,
      tags: Object.freeze([...(def.tags ?? [])]),
      metadata: Object.freeze({ ...(def.metadata ?? {}) }),
      login: def.login,
      refresh: def.refresh,
      parseOutput: def.parseOutput,
      detectExpiry: def.detectExpiry,
    }
  },
})

/**
 * Merge typed `implementations[]` into the runtime execute map. Each
 * ToolImplementation carries its contract handle, so we read
 * `impl.tool.id` to derive the binding key — authors don't restate
 * the id as a string. Typed bindings beat legacy bag on collision; a
 * collision with a *different* body raises an error so there's never
 * ambiguity about which body the resolver dispatched.
 */
function mergeExecuteMap(def: DriverDefinition): Record<string, ExecuteFn> {
  const executeMap: Record<string, ExecuteFn> = { ...(def.execute ?? {}) }
  for (const impl of def.implementations ?? []) {
    const id = impl.tool.id
    const typedBody = impl.body as ExecuteFn
    if (executeMap[id] && executeMap[id] !== typedBody) {
      throw new Error(
        `defineDriver: id='${def.id}' has duplicate body for '${id}' — ` +
          `present in both 'execute' and 'implementations'. Pick one.`,
      )
    }
    executeMap[id] = typedBody
  }
  return executeMap
}

function freezeImplements(entry: ImplementsEntry): ImplementsEntry {
  return Object.freeze({
    ...entry,
    schemaNarrowing: entry.schemaNarrowing
      ? Object.freeze({
          dropInputs: Object.freeze([
            ...(entry.schemaNarrowing.dropInputs ?? []),
          ]),
          dropOutputs: Object.freeze([
            ...(entry.schemaNarrowing.dropOutputs ?? []),
          ]),
        })
      : undefined,
    mapping: entry.mapping ? Object.freeze({ ...entry.mapping }) : undefined,
    metadata: entry.metadata ? Object.freeze({ ...entry.metadata }) : undefined,
  })
}

/**
 * Normalise a tool ref (`./tools/foo/TOOL.md`, `tools/foo`,
 * `foo`) to its canonical id used as the `execute` map key.
 *
 * v1: strip leading `./`, strip `/TOOL.md` suffix, strip `tools/`
 * prefix, take the last path segment when no other normalisation
 * applies. Matches the convention in EXAMPLES.md.
 */
export function normalizeToolId(ref: string): string {
  let s = ref.trim()
  if (s.startsWith("./")) s = s.slice(2)
  if (s.endsWith("/TOOL.md")) s = s.slice(0, -"/TOOL.md".length)
  if (s.startsWith("tools/")) s = s.slice("tools/".length)
  // Last segment when path-shaped; otherwise the whole string.
  const lastSlash = s.lastIndexOf("/")
  return lastSlash === -1 ? s : s.slice(lastSlash + 1)
}
