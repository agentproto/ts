/**
 * Advertise a structured schema field as an opaque value in `tools/list`
 * while keeping its real zod validation. `z.any().superRefine(real.safeParse)`
 * renders in JSON Schema as `{description}` rather than enumerating every
 * sub-field, so a rarely-used nested option costs the caller almost nothing
 * until they fetch its `tool_help` topic. The refine forwards the REAL
 * schema's issues (message AND path), so a validation failure still reports
 * e.g. `access.profileRef: String must contain at least 1 character(s)`.
 *
 * Same mechanism `sandbox-checkpoint-schema.ts` uses for the
 * `sandboxCheckpoint` override.
 */

import { z, type ZodTypeAny } from "zod"

export function opaqueSchema<T extends ZodTypeAny>(
  real: T,
  opts: { tool: string; field: string },
) {
  const schema = z.any().superRefine((value, ctx) => {
    const parsed = real.safeParse(value)
    if (parsed.success) return
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ ...issue })
    }
  })
  return schema as unknown as z.ZodType<z.infer<T>, unknown>
}
