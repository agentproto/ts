import type {
  ExecuteFn,
  ImplementsEntry,
  DriverDefinition,
  DriverHandle,
} from "./types.js"

const ID_RE = /^[a-z0-9][a-z0-9.\-]{1,79}$/

/**
 * AIP-30 reference implementation of `defineDriver`.
 *
 * Returns a {@link DriverHandle} with defaults applied. The resolver
 * (`resolveDriver`) and runners (`runTool`) consume this shape and
 * dispatch contract calls to the per-tool execute bodies.
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
export function defineDriver(
  definition: DriverDefinition
): DriverHandle {
  if (!ID_RE.test(definition.id)) {
    throw new Error(
      `defineDriver: invalid id '${definition.id}' — must match ${ID_RE}`
    )
  }
  if (!definition.description || definition.description.length > 2000) {
    throw new Error(
      `defineDriver: id='${definition.id}' description must be 1–2000 chars`
    )
  }
  if (definition.implements.length === 0) {
    throw new Error(
      `defineDriver: id='${definition.id}' must declare ≥1 implements[] entry`
    )
  }

  // Merge typed `implementations[]` into the runtime execute map.
  // Each ToolImplementation carries its contract handle, so we read
  // `impl.tool.id` to derive the binding key — authors don't restate
  // the id as a string. Typed bindings beat legacy bag on collision.
  const executeMap: Record<string, ExecuteFn> = { ...(definition.execute ?? {}) }
  for (const impl of definition.implementations ?? []) {
    const id = impl.tool.id
    const typedBody = impl.body as ExecuteFn
    if (executeMap[id] && executeMap[id] !== typedBody) {
      // Detect deliberate ambiguity. Single-source the binding so
      // there's never a question of which body the resolver dispatched.
      throw new Error(
        `defineDriver: id='${definition.id}' has duplicate body for '${id}' — ` +
          `present in both 'execute' and 'implementations'. Pick one.`
      )
    }
    executeMap[id] = typedBody
  }

  // No global "must declare bodies" check — the per-tool validation
  // below already raises a precise "implements X but no execute[X]"
  // error when a declared tool has no body. The `implements.length`
  // gate upstream already catches the all-empty case.

  // Validate execute map matches implements[].
  const declaredToolIds = new Set(
    definition.implements.map(e => normalizeToolId(e.tool))
  )
  const executeKeys = new Set(Object.keys(executeMap))

  for (const toolId of declaredToolIds) {
    if (!executeKeys.has(toolId)) {
      throw new Error(
        `defineDriver: id='${definition.id}' implements '${toolId}' but no execute['${toolId}'] body provided`
      )
    }
  }
  for (const key of executeKeys) {
    if (!declaredToolIds.has(key)) {
      throw new Error(
        `defineDriver: id='${definition.id}' has execute['${key}'] but '${key}' is not in implements[]`
      )
    }
  }

  const handle: DriverHandle = Object.freeze({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    version: definition.version,
    kind: definition.kind,
    implements: Object.freeze(definition.implements.map(freezeImplements)),
    execute: Object.freeze(executeMap),
    install: Object.freeze([...(definition.install ?? [])]),
    versionCheck: definition.versionCheck,
    auth: definition.auth,
    network: Object.freeze({
      egress: Object.freeze([...(definition.network?.egress ?? [])]),
      ingress: Object.freeze([...(definition.network?.ingress ?? [])]),
    }),
    region: Object.freeze([...(definition.region ?? ["global"])]),
    policyTags: Object.freeze([...(definition.policyTags ?? [])]),
    costOverride: definition.costOverride,
    timeoutOverrideMs: definition.timeoutOverrideMs,
    retryOverride: definition.retryOverride,
    healthCheck: definition.healthCheck,
    tags: Object.freeze([...(definition.tags ?? [])]),
    metadata: Object.freeze({ ...(definition.metadata ?? {}) }),
    login: definition.login,
    refresh: definition.refresh,
    parseOutput: definition.parseOutput,
    detectExpiry: definition.detectExpiry,
  })

  return handle
}

function freezeImplements(entry: ImplementsEntry): ImplementsEntry {
  return Object.freeze({
    ...entry,
    schemaNarrowing: entry.schemaNarrowing
      ? Object.freeze({
          dropInputs: Object.freeze([...(entry.schemaNarrowing.dropInputs ?? [])]),
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
