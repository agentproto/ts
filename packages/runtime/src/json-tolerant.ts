/**
 * `jsonTolerant` — wrap a zod schema so it also accepts a JSON-stringified
 * form of its value.
 *
 * Why: some MCP clients (notably the cowork client) stringify parameters
 * whose declared type is a UNION or an OBJECT/ARRAY before sending them
 * over the wire. A field declared `z.union([z.boolean(), z.object({…})])`
 * then receives the literal string `"true"` or `"{\"tools\":[…]}"`, and the
 * daemon's strict zod rejects it (`invalid_union: … received string`).
 * Plain scalars (a bare `onlyAlive: true`) survive because the client
 * doesn't stringify them; only composite types break.
 *
 * What: `jsonTolerant(schema)` returns `z.preprocess(…, schema)` that, when
 * it sees a string, tries `JSON.parse` and feeds the parsed result to the
 * inner schema. If the string is NOT valid JSON, it is passed through
 * untouched so the inner schema produces its normal, readable validation
 * error (we never swallow the failure into a crash or a silent default).
 *
 * Semantics are unchanged for well-behaved clients: a value that already
 * has the right type is never a string, so `tryParse` is never invoked and
 * the inner schema sees it verbatim.
 */

import { z } from "zod"

/**
 * Attempt to JSON-parse a string. Returns the parsed value on success, or
 * the original string on failure (so the inner schema reports the real
 * type error instead of us masking it). Only objects/arrays/primitives
 * that JSON can express are produced — exactly the shapes a client would
 * have stringified.
 */
export function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/**
 * Wrap `schema` so a JSON-stringified value is coerced back to its parsed
 * form before validation. Non-string inputs flow straight through.
 */
export function jsonTolerant<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    v => (typeof v === "string" ? tryParseJson(v) : v),
    schema,
  )
}
