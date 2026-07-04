import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { implementTool } from "@agentproto/driver"
import { scoreSchema } from "./score.js"
import { jsonValueSchema, type JsonObject, type JsonValue } from "./json.js"

export type { JsonValue } from "./json.js"

// ---------------------------------------------------------------------------
// eval.exact-match
// ---------------------------------------------------------------------------

export const exactMatchTool = defineTool({
  id: "eval.exact-match",
  description:
    "Deterministic scorer: value 1 when `actual` equals `expected` " +
    "(optionally after trimming whitespace on both sides), else 0.",
  version: "0.1.0",
  inputSchema: z.object({
    actual: z.string().describe("The produced string to score."),
    expected: z.string().describe("The reference string to compare against."),
    trim: z
      .boolean()
      .optional()
      .describe("Trim leading/trailing whitespace on both sides before comparing."),
  }),
  outputSchema: scoreSchema,
  mutates: [],
  approval: "auto",
  riskLevel: 0,
})

export const exactMatchImpl = implementTool(exactMatchTool, ({ input }) => {
  const a = input.trim ? input.actual.trim() : input.actual
  const b = input.trim ? input.expected.trim() : input.expected
  const equal = a === b
  return {
    value: equal ? 1 : 0,
    passed: equal,
    label: "exact-match",
    rationale: equal
      ? "actual equals expected"
      : "actual does not equal expected",
  }
})

// ---------------------------------------------------------------------------
// eval.regex-match
// ---------------------------------------------------------------------------

export const regexMatchTool = defineTool({
  id: "eval.regex-match",
  description:
    "Deterministic scorer: value 1 when `actual` matches the RegExp built " +
    "from `pattern`/`flags`, else 0. An invalid pattern yields a typed " +
    "failure Score rather than a thrown error.",
  version: "0.1.0",
  inputSchema: z.object({
    actual: z.string().describe("The produced string to test."),
    pattern: z.string().describe("RegExp source, compiled inside the body."),
    flags: z
      .string()
      .optional()
      .describe("RegExp flags, e.g. 'i', 'm', 'gimsuy'."),
  }),
  outputSchema: scoreSchema,
  mutates: [],
  approval: "auto",
  riskLevel: 0,
})

export const regexMatchImpl = implementTool(regexMatchTool, ({ input }) => {
  let regex: RegExp
  try {
    regex = new RegExp(input.pattern, input.flags)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      value: 0,
      passed: false,
      label: "regex-match",
      rationale: `invalid pattern: ${reason}`,
    }
  }
  const matched = regex.test(input.actual)
  return {
    value: matched ? 1 : 0,
    passed: matched,
    label: "regex-match",
    rationale: matched
      ? `actual matches /${input.pattern}/${input.flags ?? ""}`
      : `actual does not match /${input.pattern}/${input.flags ?? ""}`,
  }
})

// ---------------------------------------------------------------------------
// eval.json-schema-valid
// ---------------------------------------------------------------------------

/**
 * A deliberately minimal, dependency-free JSON-schema shape.
 *
 * LIMITATION: this scorer checks ONLY the two most common structural
 * constraints on a top-level object — that every name in `required` is
 * present, and that any name in `properties` declaring a `type` has a value
 * of that primitive type. It does NOT recurse into nested schemas, and does
 * not implement the rest of JSON Schema (enum, format, oneOf, items, …). A
 * full validator (e.g. ajv) is a later step; keeping this package light is
 * the point.
 */
export interface MinimalJsonSchema {
  readonly type?: string
  readonly required?: readonly string[]
  readonly properties?: {
    readonly [key: string]: { readonly type?: string }
  }
}

const minimalJsonSchemaSchema: z.ZodType<MinimalJsonSchema> = z.object({
  type: z.string().optional(),
  required: z.array(z.string()).optional(),
  properties: z
    .record(z.string(), z.object({ type: z.string().optional() }))
    .optional(),
})

/** Narrows a JSON value to a plain JSON object (not null, not an array). */
function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The JSON Schema primitive-type name for a runtime JSON value. */
function jsonTypeOf(value: JsonValue): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "number") return "number"
  if (typeof value === "boolean") return "boolean"
  if (typeof value === "string") return "string"
  return "object"
}

export const jsonSchemaValidTool = defineTool({
  id: "eval.json-schema-valid",
  description:
    "Deterministic scorer: minimal structural check of a JSON value against " +
    "a schema's top-level `required` and `properties` type constraints only. " +
    "Not a full JSON Schema validator (no recursion, enum, format, …).",
  version: "0.1.0",
  inputSchema: z.object({
    actual: jsonValueSchema.describe("The JSON value to validate."),
    schema: minimalJsonSchemaSchema.describe(
      "Minimal JSON schema: top-level `required` and `properties.type` only.",
    ),
  }),
  outputSchema: scoreSchema,
  mutates: [],
  approval: "auto",
  riskLevel: 0,
})

export const jsonSchemaValidImpl = implementTool(
  jsonSchemaValidTool,
  ({ input }) => {
    const { actual, schema } = input
    const violation = firstSchemaViolation(actual, schema)
    const valid = violation === undefined
    return {
      value: valid ? 1 : 0,
      passed: valid,
      label: "json-schema-valid",
      rationale: valid ? "value satisfies the schema" : violation,
    }
  },
)

/** Returns the first violation message, or undefined when the value is valid. */
function firstSchemaViolation(
  actual: JsonValue,
  schema: MinimalJsonSchema,
): string | undefined {
  const declaredType = schema.type ?? "object"
  const actualType = jsonTypeOf(actual)
  if (declaredType !== actualType) {
    return `expected top-level type '${declaredType}' but got '${actualType}'`
  }

  // Only object payloads carry required/properties semantics here.
  if (!isJsonObject(actual)) {
    return undefined
  }

  for (const key of schema.required ?? []) {
    if (!(key in actual)) {
      return `missing required property '${key}'`
    }
  }

  for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
    if (propSchema.type === undefined) continue
    const propValue = actual[key]
    if (propValue === undefined) continue
    const propType = jsonTypeOf(propValue)
    if (propType !== propSchema.type) {
      return `property '${key}' expected type '${propSchema.type}' but got '${propType}'`
    }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// eval.latency-budget
// ---------------------------------------------------------------------------

export const latencyBudgetTool = defineTool({
  id: "eval.latency-budget",
  description:
    "Deterministic scorer: passes when `durationMs` is within `budgetMs`. " +
    "value is 1 when within budget, else linearly decays toward 0 as the " +
    "overrun approaches one full budget.",
  version: "0.1.0",
  inputSchema: z.object({
    durationMs: z
      .number()
      .min(0)
      .describe("Observed duration in milliseconds."),
    budgetMs: z
      .number()
      .positive()
      .describe("Allowed budget in milliseconds (must be > 0)."),
  }),
  outputSchema: scoreSchema,
  mutates: [],
  approval: "auto",
  riskLevel: 0,
})

export const latencyBudgetImpl = implementTool(latencyBudgetTool, ({ input }) => {
  const { durationMs, budgetMs } = input
  const passed = durationMs <= budgetMs
  const value = passed
    ? 1
    : Math.max(0, 1 - (durationMs - budgetMs) / budgetMs)
  return {
    value,
    passed,
    label: "latency-budget",
    rationale: `durationMs=${durationMs}, budgetMs=${budgetMs}`,
  }
})
