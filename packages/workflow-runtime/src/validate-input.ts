/**
 * AIP-58 §3 Outcome rule — "invalid or missing required input is checked
 * before any step runs". AIP-16 declares a workflow's `inputs` block as
 * JSON Schema, but most existing WORKFLOW.md authors write a shorthand flat
 * map instead (`inputs: { url: { type, description, default } }` — see
 * `youtube-transcriber`'s `transcribe/WORKFLOW.md`). This module normalizes
 * that shorthand into real JSON Schema, then validates a run's input
 * against it with the same ajv machinery `@agentproto/tool` already uses for
 * TOOL contracts (`define-tool.ts`'s `validateJsonSchema`).
 */

import Ajv from "ajv"
import type { ErrorObject, ValidateFunction } from "ajv"
import addFormats from "ajv-formats"

/** One shorthand-form input property, e.g. `{ type: "string", default: "en" }`. */
interface ShorthandInputSpec {
  type?: string
  description?: string
  default?: unknown
  /** Non-standard: shorthand-only marker promoted to the schema's top-level
   *  `required[]` — see {@link normalizeWorkflowInputsSchema}. */
  required?: boolean
  [k: string]: unknown
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** True when `inputs` is already an AIP-16 canonical JSON Schema object
 *  (`{ type: "object", properties: {...} }`) rather than the shorthand flat
 *  map many existing manifests use. */
function isJsonSchemaObject(inputs: Record<string, unknown>): boolean {
  return inputs["type"] === "object" && isPlainObject(inputs["properties"])
}

/**
 * Normalize a WORKFLOW.md `inputs` field to a JSON Schema object.
 *
 * Already-canonical JSON Schema (`{ type: "object", properties, required?
 * }`) passes through unchanged — its own `required[]`, if any, is honored
 * as-is (this is the shape AIP-58's V1 vector authors directly).
 *
 * The shorthand flat map (`{ <name>: { type, description?, default?,
 * required? } }`) is lifted: each key becomes a `properties` entry (minus
 * its shorthand-only `required` marker); a property gets added to the
 * schema's `required[]` ONLY when its shorthand spec sets `required: true`
 * AND declares no `default` — a `default` always makes a field optional to
 * omit, regardless of `required`. A shorthand property with no `required`
 * marker at all stays optional, so normalizing an existing manifest that
 * never used the marker (e.g. `youtube-transcriber`'s `transcribe/
 * WORKFLOW.md`) never newly fails validation for it.
 */
export function normalizeWorkflowInputsSchema(inputs: unknown): Record<string, unknown> {
  if (!isPlainObject(inputs)) return { type: "object", properties: {} }
  if (isJsonSchemaObject(inputs)) return inputs

  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, rawSpec] of Object.entries(inputs)) {
    const spec: ShorthandInputSpec = isPlainObject(rawSpec) ? rawSpec : {}
    const { required: isRequired, ...schemaFields } = spec
    properties[key] = schemaFields
    if (isRequired === true && spec["default"] === undefined) required.push(key)
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

// Shared Ajv instance + per-schema validator cache — same pattern as
// `@agentproto/tool`'s `define-tool.ts` (`_ajv` / `_validatorCache`), plus
// `ajv-formats` so a manifest's `format: "uri"` (as AIP-58's V1 vector
// declares) actually validates instead of Ajv's strict mode rejecting the
// unrecognized format keyword outright.
const _ajv = addFormats(new Ajv({ allErrors: true }))
const _validatorCache = new WeakMap<object, ValidateFunction>()

function compile(schema: Record<string, unknown>): ValidateFunction {
  let validate = _validatorCache.get(schema)
  if (!validate) {
    validate = _ajv.compile(schema)
    _validatorCache.set(schema, validate)
  }
  return validate
}

function fieldFor(err: ErrorObject): string {
  if (err.keyword === "required") {
    return String((err.params as { missingProperty?: string }).missingProperty ?? "")
  }
  return err.instancePath.replace(/^\//, "") || "(root)"
}

export type WorkflowInputValidation =
  | { valid: true; schema: Record<string, unknown> }
  | {
      valid: false
      schema: Record<string, unknown>
      /** AIP-58 §10 error code — this validator only ever produces one. */
      code: "invalid-input"
      /** Missing/invalid field names (deduped), for a caller that wants to
       *  point at exactly what's wrong without re-parsing `message`. */
      fields: readonly string[]
      /** Human-readable message naming the missing/invalid fields. */
      message: string
    }

/**
 * AIP-58 §9 `run.requestInput`/`run.resume`: `true` when `schema` is a
 * usable JSON Schema (ajv can compile it) — a plain object is necessary but
 * not sufficient (e.g. `{ type: "not-a-type" }` compiles-fails). Used to
 * reject a malformed `schema` argument before it's ever recorded as a
 * step's `StepRecord.suspend.schema`.
 */
export function isCompilableJsonSchema(schema: unknown): schema is Record<string, unknown> {
  if (!isPlainObject(schema)) return false
  try {
    compile(schema)
    return true
  } catch {
    return false
  }
}

/** One structural (zod-`ZodIssue`-shaped) validation failure — the common
 *  currency between ajv's `ErrorObject[]` and zod's `ZodError.issues`, see
 *  {@link OutputSchemaLikeIssue}. */
export interface SchemaValidationIssue {
  path: readonly (string | number)[]
  message: string
}

function toIssue(err: ErrorObject): SchemaValidationIssue {
  const path = err.instancePath.replace(/^\//, "").split("/").filter((seg) => seg.length > 0)
  if (err.keyword === "required") {
    const missing = (err.params as { missingProperty?: string }).missingProperty
    if (missing) path.push(missing)
  }
  return { path, message: err.message ?? "invalid" }
}

/**
 * Generic JSON Schema validation, used both by AIP-58 §3/§9 (validate a
 * `run.resume` payload against the suspended step's `StepRecord.suspend
 * .schema` BEFORE the resume transition happens — an invalid payload MUST
 * leave the run suspended, never transition it) and by `compileAgentStep`
 * (adapt a WORKFLOW.md-authored JSON Schema `outputSchema` into the
 * {@link OutputSchemaLike} shape `execAgentStep` consumes). `issues` mirrors
 * zod's `ZodError.issues` shape so both call sites format errors the same
 * way regardless of which schema language declared the contract.
 */
export function validateAgainstJsonSchema(
  schema: Record<string, unknown>,
  value: unknown,
): { valid: true } | { valid: false; message: string; issues: readonly SchemaValidationIssue[] } {
  const validate = compile(schema)
  if (validate(value)) return { valid: true }
  const errors = validate.errors ?? []
  const issues = errors.map(toIssue)
  const detail = errors.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ")
  return { valid: false, message: `does not match schema: ${detail}`, issues }
}

/**
 * Validate a run's `input` against a WORKFLOW.md's declared `inputs`
 * (shorthand or canonical JSON Schema — see
 * {@link normalizeWorkflowInputsSchema}). The caller is responsible for
 * calling this BEFORE dispatching any step and BEFORE spawning any session
 * on an invalid result — this function only judges the input, it doesn't
 * gate execution itself.
 */
export function validateWorkflowInput(inputsField: unknown, input: unknown): WorkflowInputValidation {
  const schema = normalizeWorkflowInputsSchema(inputsField)
  const validate = compile(schema)
  if (validate(input ?? {})) return { valid: true, schema }

  const errors = validate.errors ?? []
  const fields = [...new Set(errors.map(fieldFor).filter((f) => f.length > 0))]
  const detail = errors.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ")
  return {
    valid: false,
    schema,
    code: "invalid-input",
    fields,
    message: `invalid input${fields.length > 0 ? ` (${fields.join(", ")})` : ""}: ${detail}`,
  }
}
