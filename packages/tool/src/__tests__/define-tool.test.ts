import { describe, it, expect } from "vitest"
import { z } from "zod"
import {
  defineTool,
  validateInput,
  validateContext,
  validateOutput,
} from "../define-tool.js"
import { ToolError } from "../errors.js"
import type { ToolHandle } from "../types.js"

describe("defineTool — basic shape", () => {
  it("applies defaults and exposes immutable handle", () => {
    const tool = defineTool({
      id: "echo",
      description: "Returns its input.",
      inputSchema: z.object({ message: z.string() }),
      outputSchema: z.object({ echo: z.string() }),
    })

    expect(tool.id).toBe("echo")
    expect(tool.name).toBe("echo")
    expect(tool.approval).toBe("auto")
    expect(tool.riskLevel).toBe(0)
    expect(tool.costClass).toBe("trivial")
    expect(tool.timeoutMs).toBe(30_000)
    expect(tool.mutates).toEqual([])
    expect(tool.idempotent).toBe(false)
    expect(tool.driverConstraints.forbid).toEqual([])
    expect(tool.driverConstraints.requireKind).toEqual([])
  })

  it("defaults approval to 'on-mutate' when mutates is non-empty", () => {
    const tool = defineTool({
      id: "writer",
      description: "Writes a file.",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      mutates: ["fs:write"],
    })
    expect(tool.approval).toBe("on-mutate")
  })

  it("rejects invalid id", () => {
    expect(() =>
      defineTool({
        id: "Invalid Id",
        description: "x",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
      })
    ).toThrow(/invalid id/)
  })

  it("rejects empty description", () => {
    expect(() =>
      defineTool({
        id: "echo",
        description: "",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
      })
    ).toThrow(/description/)
  })

  it("rejects definitions carrying an `execute` field (AIP-30 migration guard)", () => {
    expect(() =>
      defineTool({
        id: "legacy",
        description: "Has a body — should be on PROVIDER, not TOOL.",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        // @ts-expect-error — we deliberately test the migration guard
        execute: () => ({}),
      })
    ).toThrow(/AIP-30/)
  })

  it("preserves provider routing hints", () => {
    const tool = defineTool({
      id: "pii.redact",
      description: "PII redaction. Self-hosted only.",
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({ redacted: z.string() }),
      defaultImplementation: "host-presidio-sdk",
      driverConstraints: { forbid: ["http", "mcp"], requireKind: ["sdk", "builtin"] },
    })
    expect(tool.defaultImplementation).toBe("host-presidio-sdk")
    expect(tool.driverConstraints.forbid).toEqual(["http", "mcp"])
    expect(tool.driverConstraints.requireKind).toEqual(["sdk", "builtin"])
  })
})

describe("validateInput / validateContext / validateOutput", () => {
  const tool = defineTool({
    id: "uppercase",
    description: "Uppercases a string.",
    inputSchema: z.object({ s: z.string() }),
    outputSchema: z.object({ result: z.string() }),
  })

  it("validateInput accepts conformant input", () => {
    const result = validateInput(tool, { s: "hi" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ s: "hi" })
  })

  it("validateInput rejects non-conformant input with input_invalid", () => {
    const result = validateInput(tool, { s: 42 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("input_invalid")
  })

  it("validateOutput throws ToolError on contract violation", () => {
    expect(() => validateOutput(tool, { result: 42 })).toThrow(ToolError)
    try {
      validateOutput(tool, { result: 42 })
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError)
      if (e instanceof ToolError) expect(e.code).toBe("output_invalid")
    }
  })

  it("validateOutput returns the typed value on success", () => {
    const value = validateOutput(tool, { result: "HI" })
    expect(value).toEqual({ result: "HI" })
  })
})

describe("validateContext — contextSchema", () => {
  const tool = defineTool({
    id: "config-bound",
    description: "Reads governanceConfig from context.",
    inputSchema: z.object({}),
    outputSchema: z.object({ workspace: z.string() }),
    contextSchema: z.object({
      governanceConfig: z.object({
        workspaceRoot: z.string(),
      }),
    }),
  })

  it("narrows context when valid", () => {
    const result = validateContext(tool, {
      governanceConfig: { workspaceRoot: "/w" },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.governanceConfig.workspaceRoot).toBe("/w")
    }
  })

  it("rejects missing required fields with input_invalid + field='context'", () => {
    const result = validateContext(tool, {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("input_invalid")
      expect(result.error.field).toBe("context")
    }
  })

  it("rejects wrong types with input_invalid", () => {
    const result = validateContext(tool, {
      governanceConfig: { workspaceRoot: 42 },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("input_invalid")
  })

  it("returns context unchanged when contract has no contextSchema", () => {
    const noCtx = defineTool({
      id: "no-ctx",
      description: "x",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
    })
    const result = validateContext(noCtx, { foo: "bar", signal: undefined })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ foo: "bar", signal: undefined })
  })
})

// ---------------------------------------------------------------------------
// v0.2 JSON Schema fallback — manifest-only handles (no zod schemas present)
// ---------------------------------------------------------------------------

/** Simulates a handle as loaded via toolSpec.parse → toolSpec.define from a TOOL.md */
function makeManifestHandle(
  inputs?: Record<string, unknown>,
  outputs?: Record<string, unknown>,
): Pick<ToolHandle, "id" | "inputSchema" | "inputs" | "outputSchema" | "outputs"> {
  // A manifest-only handle has no zod schema at runtime — `inputSchema`/
  // `outputSchema` are typed (non-optional) but absent here, which is exactly
  // the case `validateInput`/`validateOutput` guard against. Cast to model it.
  return {
    id: "manifest-tool",
    inputs,
    outputs,
  } as unknown as Pick<
    ToolHandle,
    "id" | "inputSchema" | "inputs" | "outputSchema" | "outputs"
  >
}

describe("validateInput — JSON Schema fallback (v0.2, no zod inputSchema)", () => {
  const inputs = {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string" },
      maxLen: { type: "integer" },
    },
    additionalProperties: false,
  }

  it("accepts a valid input conforming to the JSON Schema", () => {
    const handle = makeManifestHandle(inputs)
    const result = validateInput(handle, { url: "https://example.com" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ url: "https://example.com" })
  })

  it("rejects input missing a required field with code='input_invalid'", () => {
    const handle = makeManifestHandle(inputs)
    const result = validateInput(handle, {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("input_invalid")
  })

  it("rejects input with wrong type with code='input_invalid'", () => {
    const handle = makeManifestHandle(inputs)
    const result = validateInput(handle, { url: "https://example.com", maxLen: "not-a-number" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("input_invalid")
  })

  it("rejects input with additional properties when schema disallows them", () => {
    const handle = makeManifestHandle(inputs)
    const result = validateInput(handle, { url: "https://example.com", extra: true })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("input_invalid")
  })

  it("passes through any input when neither inputSchema nor inputs is defined", () => {
    const handle = makeManifestHandle(undefined, undefined)
    const result = validateInput(handle, { anything: 42 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ anything: 42 })
  })
})

describe("validateOutput — JSON Schema fallback (v0.2, no zod outputSchema)", () => {
  const outputs = {
    type: "object",
    required: ["summary"],
    properties: {
      summary: { type: "string" },
    },
    additionalProperties: false,
  }

  it("returns the value when output conforms to the JSON Schema", () => {
    const handle = makeManifestHandle(undefined, outputs)
    const value = validateOutput(handle, { summary: "All good." })
    expect(value).toEqual({ summary: "All good." })
  })

  it("throws ToolError(output_invalid) when output violates the JSON Schema", () => {
    const handle = makeManifestHandle(undefined, outputs)
    expect(() => validateOutput(handle, {})).toThrow(ToolError)
    try {
      validateOutput(handle, {})
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError)
      if (e instanceof ToolError) expect(e.code).toBe("output_invalid")
    }
  })
})

describe("validateOutput — passthrough when neither outputSchema nor outputs is defined", () => {
  it("returns any value unchanged when no output contract is present", () => {
    const handle = makeManifestHandle(undefined, undefined)
    const value = validateOutput(handle, { anything: 42 })
    expect(value).toEqual({ anything: 42 })
  })
})

describe("validateInput / validateOutput — zod present → v0.1 behaviour unchanged", () => {
  const tool = defineTool({
    id: "zod-wins",
    description: "Zod schemas present — v0.1 path must be used.",
    inputSchema: z.object({ n: z.number() }),
    outputSchema: z.object({ doubled: z.number() }),
    // inputs/outputs also provided — zod must take priority
    inputs: { type: "object", properties: { n: { type: "string" } } },
    outputs: { type: "object", properties: { doubled: { type: "string" } } },
  })

  it("validateInput uses zod when inputSchema is present (accepts conformant)", () => {
    const result = validateInput(tool, { n: 3 })
    expect(result.ok).toBe(true)
  })

  it("validateInput uses zod when inputSchema is present (rejects non-conformant)", () => {
    // zod rejects string; JSON Schema inputs would accept it — confirms zod wins
    const result = validateInput(tool, { n: "three" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("input_invalid")
  })

  it("validateOutput uses zod when outputSchema is present (accepts conformant)", () => {
    const value = validateOutput(tool, { doubled: 6 })
    expect(value).toEqual({ doubled: 6 })
  })

  it("validateOutput uses zod when outputSchema is present (rejects non-conformant)", () => {
    expect(() => validateOutput(tool, { doubled: "six" })).toThrow(ToolError)
  })
})
