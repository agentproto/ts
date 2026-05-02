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
 * Minimum shape every AIP definition must satisfy. AIPs are free to
 * widen this — `id` and `description` are universal because every
 * doctype carries identity + LLM-facing prose.
 */
export interface DoctypeDefinitionBase {
  id: string
  description: string
}

export interface DoctypeOptions<
  TDef extends DoctypeDefinitionBase,
  THandle,
> {
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
   * Override the default id pattern. Default:
   * `/^[a-z0-9][a-z0-9._-]{1,79}$/` — kebab/snake/dot separated, 2-80
   * chars, leading alphanumeric. Most AIPs should keep the default.
   */
  idPattern?: RegExp
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
export function createDoctype<
  TDef extends DoctypeDefinitionBase,
  THandle,
>(opts: DoctypeOptions<TDef, THandle>): (def: TDef) => THandle {
  const idPattern = opts.idPattern ?? DEFAULT_ID_PATTERN
  const prefix = `define${capitalize(opts.name)}`
  const aipTag = `(AIP-${opts.aip})`

  return function constructDoctype(def: TDef): THandle {
    if (!idPattern.test(def.id)) {
      throw new Error(
        `${prefix} ${aipTag}: invalid id '${def.id}' — must match ${idPattern}`,
      )
    }
    if (
      typeof def.description !== "string" ||
      def.description.length === 0 ||
      def.description.length > MAX_DESCRIPTION_LEN
    ) {
      throw new Error(
        `${prefix} ${aipTag}: id='${def.id}' description must be 1–${MAX_DESCRIPTION_LEN} chars`,
      )
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
