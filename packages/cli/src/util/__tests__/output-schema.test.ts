/**
 * Unit tests for the `--output-schema` helpers: arg resolution (inline vs
 * path vs invalid), fence-stripping / JSON extraction, and ajv validation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildRetryInstruction,
  buildSchemaInstruction,
  compileValidator,
  OutputSchemaError,
  parseFinalJson,
  resolveOutputSchema,
  stripCodeFences,
} from "../output-schema.js"

const SCHEMA = {
  type: "object",
  required: ["passed"],
  properties: { passed: { type: "boolean" } },
  additionalProperties: false,
}

describe("resolveOutputSchema", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "apc-schema-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("parses inline JSON (first non-space char `{`)", () => {
    expect(resolveOutputSchema('  {"type":"object"}  ')).toEqual({
      type: "object",
    })
  })

  it("reads a schema file when the arg is a path", async () => {
    const path = join(dir, "schema.json")
    await writeFile(path, JSON.stringify(SCHEMA), "utf8")
    expect(resolveOutputSchema(path)).toEqual(SCHEMA)
  })

  it("throws OutputSchemaError for a missing file", () => {
    expect(() => resolveOutputSchema(join(dir, "nope.json"))).toThrow(
      OutputSchemaError,
    )
  })

  it("throws OutputSchemaError for inline invalid JSON", () => {
    expect(() => resolveOutputSchema("{not json}")).toThrow(OutputSchemaError)
  })

  it("throws when a schema file's content is not a JSON object", async () => {
    const path = join(dir, "array.json")
    await writeFile(path, "[1,2,3]", "utf8")
    expect(() => resolveOutputSchema(path)).toThrow(/must be a JSON object/)
  })
})

describe("compileValidator", () => {
  it("accepts a value matching the schema", () => {
    const v = compileValidator(SCHEMA)
    expect(v.validate({ passed: true })).toEqual({ ok: true })
  })

  it("rejects a value violating the schema and reports the errors", () => {
    const v = compileValidator(SCHEMA)
    const result = v.validate({ passed: "yes" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toMatch(/passed/)
  })

  it("rejects extra properties when additionalProperties is false", () => {
    const v = compileValidator(SCHEMA)
    expect(v.validate({ passed: true, extra: 1 }).ok).toBe(false)
  })

  it("throws OutputSchemaError on an uncompilable schema", () => {
    expect(() => compileValidator({ type: 123 })).toThrow(OutputSchemaError)
  })
})

describe("stripCodeFences / parseFinalJson", () => {
  it("strips a ```json fence", () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it("strips a bare ``` fence", () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it("leaves unfenced text unchanged", () => {
    expect(stripCodeFences('  {"a":1}  ')).toBe('{"a":1}')
  })

  it("parses a fenced JSON object", () => {
    expect(parseFinalJson('```json\n{"passed":true}\n```')).toEqual({
      ok: true,
      value: { passed: true },
    })
  })

  it("extracts the outermost object when wrapped in prose", () => {
    expect(
      parseFinalJson('Sure! Here you go:\n{"passed":false}\nHope that helps.'),
    ).toEqual({ ok: true, value: { passed: false } })
  })

  it("fails cleanly when there is no JSON", () => {
    const parsed = parseFinalJson("no json here")
    expect(parsed.ok).toBe(false)
  })
})

describe("instruction builders", () => {
  it("embeds the schema in the initial instruction", () => {
    const text = buildSchemaInstruction(SCHEMA)
    expect(text).toContain(JSON.stringify(SCHEMA))
    expect(text).toContain("JSON object")
  })

  it("embeds the validation errors in the retry instruction", () => {
    expect(buildRetryInstruction("/passed must be boolean")).toContain(
      "/passed must be boolean",
    )
  })
})
