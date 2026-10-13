/**
 * Zod shape of `SandboxCheckpointConfig` (`sandbox-delivery.ts`), shared by the
 * daemon config (`defaults.sandbox.checkpoint`, `config-schema.ts`) and the
 * per-spawn override (`agent_start.sandboxCheckpoint`). Kept free of the
 * delivery module's node imports so the light schema modules can use it.
 */

import { z } from "zod"

export const checkpointRefPrefixSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "must be plain ref characters (letters, digits, . _ - /)")
  .refine(value => !value.includes(".."), "must not contain '..'")

export const sandboxCheckpointOnSchema = z.array(z.enum(["turn-end", "teardown"]))

export const sandboxCheckpointConfigShape = {
  enabled: z.boolean().optional(),
  on: sandboxCheckpointOnSchema.optional(),
  refPrefix: checkpointRefPrefixSchema.optional(),
  minIntervalMs: z.number().int().min(0).optional(),
  timeoutMs: z.number().int().positive().optional(),
}

const sandboxCheckpointConfigObject = z.object(sandboxCheckpointConfigShape).strict()

/** `false | {…}`, validated at runtime but advertised as an opaque value so
 *  the always-on tools/list stays inside its byte budget. */
export const sandboxCheckpointOverrideSchema = z
  .any()
  .refine(
    (value): value is z.infer<typeof sandboxCheckpointConfigObject> | false =>
      value === false || sandboxCheckpointConfigObject.safeParse(value).success,
    "expected false or { enabled?, on?, refPrefix?, minIntervalMs?, timeoutMs? }"
  )
