/**
 * `--output-schema` helpers for `agentproto run`.
 *
 * When an agent scripts another agent, free-text replies force the caller to
 * parse prose. `--output-schema <path-or-inline-json>` makes the final answer
 * a single JSON object validated against a caller-supplied JSON Schema, so the
 * pipeline stays `... | jq -e '.criteria_met'`.
 *
 * Validation reuses `ajv` (already a repo dependency — see
 * `packages/tool/src/define-tool.ts`) so the FULL JSON Schema draft is
 * supported, not a hand-rolled subset.
 */

import { readFileSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import Ajv, { type ErrorObject } from "ajv"

/** A JSON Schema is an object; we don't narrow it further than the parser. */
export type OutputSchema = Record<string, unknown>

/**
 * Raised for every caller-facing failure in this module (bad path, bad JSON,
 * uncompilable schema). `runRun` turns these into a clean stderr line + exit 2
 * rather than a raw stack.
 */
export class OutputSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OutputSchemaError"
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Resolve the `--output-schema` argument into a parsed schema object.
 *
 * Detection mirrors the plan: the first non-whitespace character `{` means the
 * argument IS the schema (inline JSON); anything else is treated as a path to
 * a `.json` file.
 */
export function resolveOutputSchema(arg: string): OutputSchema {
  const trimmed = arg.trim()
  let raw: string
  if (trimmed.startsWith("{")) {
    raw = trimmed
  } else {
    try {
      raw = readFileSync(resolvePath(arg), "utf8")
    } catch (err) {
      throw new OutputSchemaError(
        `could not read schema file '${arg}': ${errMessage(err)}`,
      )
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new OutputSchemaError(`schema is not valid JSON: ${errMessage(err)}`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OutputSchemaError("schema must be a JSON object")
  }
  return parsed as OutputSchema
}

export interface SchemaValidator {
  /** `{ ok: true }` when the value validates; else the joined ajv errors. */
  validate(value: unknown): { ok: true } | { ok: false; errors: string }
}

function formatAjvError(e: ErrorObject): string {
  return `${e.instancePath || "/"} ${e.message ?? "is invalid"}`
}

/**
 * Compile a schema into a reusable validator. Throws {@link OutputSchemaError}
 * if the schema itself is not a valid JSON Schema (ajv rejects it at compile).
 */
export function compileValidator(schema: OutputSchema): SchemaValidator {
  // allErrors so a mismatch report lists every violation, not just the first —
  // gives the retry prompt maximum signal. Mirrors packages/tool's Ajv setup.
  const ajv = new Ajv({ allErrors: true })
  let validate: ReturnType<typeof ajv.compile>
  try {
    validate = ajv.compile(schema)
  } catch (err) {
    throw new OutputSchemaError(`invalid JSON Schema: ${errMessage(err)}`)
  }
  return {
    validate(value: unknown) {
      if (validate(value)) return { ok: true }
      const errors = (validate.errors ?? []).map(formatAjvError).join("; ")
      return { ok: false, errors: errors || "value did not match the schema" }
    },
  }
}

/**
 * Strip a single ```-fenced block (```json … ```) if the text is exactly one,
 * returning the inner body. Otherwise returns the trimmed text unchanged.
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json|jsonc)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(
    trimmed,
  )
  return (fenced?.[1] ?? trimmed).trim()
}

/**
 * Extract a JSON value from an agent's final answer. Tries the fence-stripped
 * text first, then falls back to the outermost `{…}` span in case the agent
 * wrapped the object in prose despite the instruction.
 */
export function parseFinalJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const stripped = stripCodeFences(text)
  const candidates = [stripped]
  const first = stripped.indexOf("{")
  const last = stripped.lastIndexOf("}")
  if (first !== -1 && last > first) {
    candidates.push(stripped.slice(first, last + 1))
  }
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      return { ok: true, value: JSON.parse(candidate) }
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, error: "final answer was not valid JSON" }
}

/**
 * The instruction appended to the caller's prompt so the agent knows to emit a
 * single schema-matching JSON object as its final answer.
 */
export function buildSchemaInstruction(schema: OutputSchema): string {
  return [
    "",
    "---",
    "IMPORTANT — structured output required. Your FINAL answer MUST be a single",
    "JSON object that validates against the JSON Schema below. Output ONLY that",
    "JSON object: no prose, no explanation, no markdown, no code fences, nothing",
    "before or after it.",
    "",
    "JSON Schema:",
    JSON.stringify(schema),
  ].join("\n")
}

/** The re-prompt sent after a mismatch, embedding the validation errors. */
export function buildRetryInstruction(errors: string): string {
  return [
    `Your previous output did not match the required schema: ${errors}.`,
    "Reply with ONLY the corrected JSON object — no prose, no code fences.",
  ].join("\n")
}
