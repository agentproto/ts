/**
 * @agentproto/define-doctype — meta-factory for AIP `defineX` constructors.
 *
 * Every AIP that defines a markdown-with-frontmatter doctype ships a
 * `defineX(definition)` constructor (`defineTool` for AIP-14, `defineDriver`
 * for AIP-30, future `defineSkill` / `defineKnowledge` / …). Those
 * constructors share a small invariant prologue: validate the `id`
 * against a regex, validate `description` length, throw with a canonical
 * error prefix, freeze the returned handle.
 *
 * `createDoctype` lifts that prologue to one place. Each per-AIP
 * package supplies the spec-specific bits via `validate(def)` and
 * `build(def)`; the factory wires them together with the shared rules.
 *
 * Recommended scaffold for new AIPs (referenced from AIP-1).
 */

/**
 * Default shape every AIP definition is assumed to satisfy when no
 * custom `readIdentity` / `readDescription` extractors are passed.
 *
 * Most AIPs (AIP-14 TOOL, AIP-30 DRIVER, AIP-3 SKILL, …) carry
 * `id` + `description`. AIPs that depart from this convention (e.g.
 * AIP-7 POLICY uses `slug` + `name`, with `description` optional)
 * supply their own extractors via `DoctypeOptions`.
 */
export interface DoctypeDefinitionBase {
  id: string
  description: string
}

export interface DoctypeOptions<TDef, THandle> {
  /**
   * AIP number — surfaces in error messages so a thrown stack frame
   * inside a framework adapter still tells you which spec rejected
   * the definition.
   */
  aip: number
  /**
   * Doctype name (lower-case singular). Used to build the error
   * prefix: `name = "tool"` → "defineTool: …".
   */
  name: string
  /**
   * Extract the identity string (kebab-id, slug, …) to validate against
   * `idPattern`. Default: `(def) => (def as { id: string }).id` —
   * works for any AIP whose definition has an `id` field. AIPs whose
   * identity field has a different name (e.g. AIP-7 POLICY's `slug`)
   * supply their own reader.
   */
  readIdentity?: (def: TDef) => string
  /**
   * Override the default identity pattern. Default:
   * `/^[a-z0-9][a-z0-9._-]{1,79}$/` — kebab/snake/dot separated,
   * 2-80 chars, leading alphanumeric. AIPs with stricter rules
   * (AIP-7 POLICY uses `^[a-z0-9][a-z0-9-]*$`, no dots) override.
   */
  idPattern?: RegExp
  /**
   * Extract the LLM-facing prose used by the length check. Default:
   * `(def) => (def as { description: string }).description`. Pass
   * `false` to skip the length validation (e.g. AIPs where
   * description is optional, or where the human-readable string lives
   * in a different field).
   */
  readDescription?: ((def: TDef) => string | undefined) | false
  /**
   * Override the maximum prose length. Default 2000. AIPs whose
   * doctypes carry longer normative text on the doctype itself can
   * raise this; most should keep the default for prompt-injection
   * resistance.
   */
  maxDescriptionLen?: number
  /**
   * Spec-specific validations that run AFTER the default id and
   * description checks. Throw on failure. Stays out of `build()` so
   * the build path can assume a validated definition.
   */
  validate?: (def: TDef) => void
  /**
   * Build the immutable handle from a validated definition. Apply
   * defaults, freeze nested arrays/objects per the spec's freezing
   * rules, return the handle. The factory takes care of the
   * top-level `Object.freeze`.
   */
  build: (def: TDef) => THandle
}

const DEFAULT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,79}$/
const MAX_DESCRIPTION_LEN = 2000

/**
 * Build a `defineX(definition)` constructor that enforces the
 * cross-AIP invariants and delegates spec-specific behaviour to
 * `validate` / `build`.
 *
 * Usage (from `@agentproto/tool/src/define-tool.ts`):
 *
 *     export const defineTool = createDoctype<ToolDefinition, ToolHandle>({
 *       aip: 14,
 *       name: "tool",
 *       validate(def) { ...spec-14 checks... },
 *       build(def) { ...defaulting + nested freezing... },
 *     })
 */
export function createDoctype<TDef, THandle>(
  opts: DoctypeOptions<TDef, THandle>,
): (def: TDef) => THandle {
  const idPattern = opts.idPattern ?? DEFAULT_ID_PATTERN
  const readIdentity =
    opts.readIdentity ?? ((def: TDef) => (def as { id: string }).id)
  const readDescription =
    opts.readDescription === false
      ? null
      : (opts.readDescription ??
        ((def: TDef) => (def as { description: string }).description))
  const maxLen = opts.maxDescriptionLen ?? MAX_DESCRIPTION_LEN
  const prefix = `define${capitalize(opts.name)}`
  const aipTag = `(AIP-${opts.aip})`

  return function constructDoctype(def: TDef): THandle {
    const identity = readIdentity(def)
    if (typeof identity !== "string" || !idPattern.test(identity)) {
      throw new Error(
        `${prefix} ${aipTag}: invalid id '${String(
          identity,
        )}' — must match ${idPattern}`,
      )
    }
    if (readDescription) {
      const description = readDescription(def)
      if (
        typeof description !== "string" ||
        description.length === 0 ||
        description.length > maxLen
      ) {
        throw new Error(
          `${prefix} ${aipTag}: id='${identity}' description must be 1–${maxLen} chars`,
        )
      }
    }
    opts.validate?.(def)
    return Object.freeze(opts.build(def)) as THandle
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)
}

export const DOCTYPE_DEFAULT_ID_PATTERN = DEFAULT_ID_PATTERN
export const DOCTYPE_MAX_DESCRIPTION_LEN = MAX_DESCRIPTION_LEN

/**
 * Filter a value to its YAML-serialisable subset:
 *  - functions removed (e.g. driver `execute[id]: ExecuteFn`)
 *  - zod schemas removed (e.g. tool `inputSchema`, `outputSchema`,
 *    `contextSchema` — they live in TS, not in frontmatter)
 *  - `undefined` values dropped from objects (so the YAML output
 *    doesn't carry empty keys; `null` is preserved as a real value)
 *
 * Used by per-AIP `createX(params, opts)` to project a validated
 * definition into a manifest-shaped object before writing to disk.
 * Pure function; no I/O.
 */
export function filterSerializable(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === "function") return undefined
  if (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, "_def") &&
    "parse" in value &&
    typeof (value as { parse?: unknown }).parse === "function"
  ) {
    return undefined
  }
  if (Array.isArray(value)) {
    return value.map(filterSerializable).filter((v) => v !== undefined)
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const filtered = filterSerializable(v)
      if (filtered !== undefined) out[k] = filtered
    }
    return out
  }
  return value
}
