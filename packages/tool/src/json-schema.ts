/**
 * Minimal well-formedness check for the AIP-16 `inputs`/`outputs` JSON
 * Schema blocks declared in a TOOL.md frontmatter.
 *
 * This is deliberately NOT a full JSON Schema validator — invocation-time
 * validation against the payload still happens in `define-tool.ts` via
 * `validateJsonSchema` (ajv). This check runs at MANIFEST PARSE time and
 * only catches structurally malformed schemas that no validator could
 * meaningfully compile (e.g. `properties: "..."` or `required: "name"` —
 * a typo that would otherwise surface as a confusing ajv error deep in a
 * tool invocation, or not at all).
 *
 * Checked keys and their minimal shapes (JSON Schema draft 2020-12):
 *   type       — string, or non-empty array of strings
 *   properties — object
 *   required   — array of strings
 *   items      — object, or array of objects (tuple form)
 *   $ref       — string
 *   enum       — non-empty array
 */

export interface MinimalJsonSchemaIssue {
  /** Dotted path of the offending key inside the schema block. */
  path: string
  message: string
}

/**
 * Check one IO schema block. Returns a list of issues (empty = well-formed
 * enough to hand to ajv later). Values are only checked when the key is
 * PRESENT; an absent key imposes no constraint.
 */
export function checkMinimalJsonSchema(
  value: unknown,
): MinimalJsonSchemaIssue[] {
  const issues: MinimalJsonSchemaIssue[] = []
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return [{ path: "", message: "schema must be an object" }]
  }
  const schema = value as Record<string, unknown>

  if (schema.type !== undefined) {
    const ok =
      typeof schema.type === "string" ||
      (Array.isArray(schema.type) &&
        schema.type.length > 0 &&
        schema.type.every(t => typeof t === "string"))
    if (!ok) {
      issues.push({
        path: "type",
        message: "type must be a string or array of strings",
      })
    }
  }

  if (schema.properties !== undefined) {
    if (
      schema.properties === null ||
      typeof schema.properties !== "object" ||
      Array.isArray(schema.properties)
    ) {
      issues.push({ path: "properties", message: "properties must be an object" })
    }
  }

  if (schema.required !== undefined) {
    const ok =
      Array.isArray(schema.required) &&
      schema.required.every(r => typeof r === "string")
    if (!ok) {
      issues.push({ path: "required", message: "required must be an array of strings" })
    }
  }

  if (schema.items !== undefined) {
    const isSchemaObject = (v: unknown) =>
      v !== null && typeof v === "object" && !Array.isArray(v)
    const ok =
      isSchemaObject(schema.items) ||
      (Array.isArray(schema.items) && schema.items.every(isSchemaObject))
    if (!ok) {
      issues.push({ path: "items", message: "items must be an object or array of objects" })
    }
  }

  if (schema.$ref !== undefined && typeof schema.$ref !== "string") {
    issues.push({ path: "$ref", message: "$ref must be a string" })
  }

  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      issues.push({ path: "enum", message: "enum must be a non-empty array" })
    }
  }

  return issues
}

/**
 * Validate the `inputs`/`outputs` blocks of a parsed manifest. Throws with
 * a message naming the tool id and the offending block, e.g.
 * `invalid inputs block for tool echo: properties must be an object`.
 */
export function validateManifestIOBlocks(
  toolId: string,
  blocks: { inputs?: unknown; outputs?: unknown },
): void {
  for (const key of ["inputs", "outputs"] as const) {
    const value = blocks[key]
    if (value === undefined) continue
    const issues = checkMinimalJsonSchema(value)
    if (issues.length > 0) {
      // Each message already names the offending key (e.g. "properties must
    // be an object"); the empty-path top-level message reads on its own.
    const detail = issues.map(i => i.message).join("; ")
      throw new Error(
        `invalid ${key} block for tool ${toolId}: ${detail}`
      )
    }
  }
}
