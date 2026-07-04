import { z } from "zod"

/**
 * Recursive JSON value union. Modelling the JSON payload explicitly (rather
 * than reaching for `any` / `unknown`) lets consumers inspect values with
 * proper narrowing and no casts. This is the ONE canonical `JsonValue` for the
 * package — scorers, the eval harness, and the vitest bridge all import it from
 * here so there is no divergent redeclaration.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** A plain JSON object (not `null`, not an array). */
export type JsonObject = { [key: string]: JsonValue }

/** Zod schema mirroring {@link JsonValue}. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)
