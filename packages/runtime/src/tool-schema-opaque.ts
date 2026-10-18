/**
 * Advertise a structured schema field as an opaque value in `tools/list`
 * while keeping its real zod validation AND its parsed output. The wrapper
 * renders in JSON Schema as `{description}` rather than enumerating every
 * sub-field, so a rarely-used nested option costs the caller almost nothing
 * until they fetch its `tool_help` topic.
 *
 * The transform returns `real`'s parsed output (not the raw input), so
 * transforms/preprocess/defaults and unknown-key stripping all survive:
 * `agent_start.browser: true` still becomes `"headless"`, and an opaque
 * object field still drops keys its schema does not declare. On failure the
 * REAL schema's issues (message AND path) are forwarded, so a validation
 * error still reports e.g. `access.profileRef: ...`.
 *
 * Same mechanism `sandbox-checkpoint-schema.ts` uses for the
 * `sandboxCheckpoint` override.
 */

import { z, type ZodTypeAny } from "zod"

export function opaqueSchema<T extends ZodTypeAny>(
  real: T,
): z.ZodType<z.output<T>, unknown> {
  return z.any().transform((value, ctx): z.output<T> => {
    const parsed = real.safeParse(value)
    if (parsed.success) return parsed.data
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ ...issue })
    }
    return z.NEVER
  })
}
