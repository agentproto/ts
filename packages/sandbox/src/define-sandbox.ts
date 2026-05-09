import { createDoctype } from "@agentproto/define-doctype"
import { sandboxFrontmatterSchema } from "./schema.js"
import type {
  SandboxRuntimeHandle,
  SandboxRuntimeInput,
} from "./types.js"

/**
 * AIP-36 reference implementation of `defineSandbox`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineSandbox (AIP-36): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the manifest portion of the input. The
 * AIP-43 runtime slots (`factory`, `capabilities`) are HOST-OPAQUE
 * TS-runtime metadata stripped before validation and re-attached in
 * `build` — same pattern as `@agentproto/storage`'s `defineStorage`.
 *
 * Generic params:
 *   TFactory      — host-typed factory (e.g. `(input) => WorkspaceSandbox`
 *                   for the Guilde host). Defaults to `unknown`.
 *   TCapabilities — opaque metadata the registry queries on. Per
 *                   AIP-43 § Capability metadata namespace.
 */
const defineSandboxInner = createDoctype<
  SandboxRuntimeInput,
  SandboxRuntimeHandle
>({
  aip: 36,
  name: "sandbox",
  readDescription: false,
  // AIP-36 makes `id` standalone-only — inline sandbox blocks fall
  // back to `provider` for the cross-AIP id-pattern check (mirrors
  // AIP-43 § Identity).
  readIdentity: def => {
    if (typeof def.id === "string" && def.id.length > 0) return def.id
    return def.provider
  },
  validate(def) {
    const { factory: _factory, capabilities: _capabilities, ...manifest } = def
    const result = sandboxFrontmatterSchema.safeParse(manifest)
    if (!result.success) {
      throw new Error(
        `defineSandbox (AIP-36): ${result.error.issues
          .map(i => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
    // TODO: spec-36-specific cross-field rules (if/then/allOf in
    // the JSON Schema) — those don't translate to zod cleanly and
    // belong here. See @agentproto/operator's autonomy=gated rule.
  },
  build(def) {
    const { factory, capabilities, ...manifest } = def
    return {
      ...manifest,
      ...(factory !== undefined ? { factory } : {}),
      ...(capabilities !== undefined
        ? { capabilities: Object.freeze({ ...capabilities }) }
        : {}),
    } as SandboxRuntimeHandle
  },
})

/**
 * Type-aware wrapper preserving `TFactory` / `TCapabilities` generics
 * across the call.
 */
export function defineSandbox<
  TFactory = unknown,
  TCapabilities extends Record<string, unknown> = Record<string, unknown>,
>(
  definition: SandboxRuntimeInput<TFactory, TCapabilities>,
): SandboxRuntimeHandle<TFactory, TCapabilities> {
  return defineSandboxInner(
    definition as SandboxRuntimeInput,
  ) as SandboxRuntimeHandle<TFactory, TCapabilities>
}
