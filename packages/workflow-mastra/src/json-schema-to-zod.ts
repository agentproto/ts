/**
 * A small, deliberately partial JSON Schema to zod converter for projecting a
 * workflow's (or a manifest-only tool's) declared AIP-16 IO schema onto a
 * Mastra step/workflow inputSchema/outputSchema. Not a general JSON Schema
 * compiler -- object (with properties/required), string, number/integer,
 * boolean, array, and a string-only top-level enum are converted; anything
 * else (oneOf/anyOf/$ref/tuple items/etc.) falls back to z.any() rather than
 * guessing at a shape it can't represent faithfully. The repo's
 * json-schema-to-zod devDependency emits a STRING of zod source for codegen
 * (scripts/scaffold-aip.mjs) -- no use here, where a live ZodType is needed
 * for a schema only known at projection time.
 *
 * Object conversion is deliberately LOOSE (z.looseObject, not z.object):
 * Mastra's workflow-level inputSchema doesn't just validate run.start()'s
 * inputData, it re-parses it, and a plain z.object() strips any key not
 * listed in properties -- silently dropping workflow input fields the
 * manifest's inputs block never declared, before a single step ever reads
 * them via $input.*. A strict schema here would be actively destructive.
 */

import { z, type ZodTypeAny } from "zod"

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Convert one JSON Schema node to a zod type. Unsupported shapes fall back to `z.any()`. */
export function jsonSchemaToZod(schema: unknown): ZodTypeAny {
  if (!isPlainObject(schema)) return z.any()

  if (Array.isArray(schema["enum"])) {
    const values = schema["enum"]
    if (values.length > 0 && values.every((v): v is string => typeof v === "string")) {
      return z.enum(values as [string, ...string[]])
    }
    return z.any()
  }

  switch (schema["type"]) {
    case "object": {
      const properties = isPlainObject(schema["properties"]) ? schema["properties"] : {}
      const required = new Set(Array.isArray(schema["required"]) ? (schema["required"] as unknown[]) : [])
      const shape: Record<string, ZodTypeAny> = {}
      for (const [key, propSchema] of Object.entries(properties)) {
        const propType = jsonSchemaToZod(propSchema)
        shape[key] = required.has(key) ? propType : propType.optional()
      }
      return z.looseObject(shape)
    }
    case "string":
      return z.string()
    case "number":
    case "integer":
      return z.number()
    case "boolean":
      return z.boolean()
    case "array":
      return z.array(schema["items"] !== undefined ? jsonSchemaToZod(schema["items"]) : z.any())
    default:
      return z.any()
  }
}
