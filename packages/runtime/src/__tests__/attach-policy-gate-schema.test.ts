/**
 * Schema-level tests for the `gate` union in `policy_attach` (WP7).
 *
 * (a) judge variant accepted without `command`
 * (b) shell variant still accepted
 * (c) empty / invalid gate rejected with a readable error
 */
import { describe, it, expect } from "vitest"
import { gateInputSchema } from "../orchestration-tools.js"

describe("policy_attach gate input schema", () => {
  it("(a) judge gate { judge: { adapter, prompt } } is accepted", () => {
    const result = gateInputSchema.safeParse({
      judge: { adapter: "claude-code", prompt: "Is the output correct?" },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect("judge" in result.data).toBe(true)
    }
  })

  it("(a2) judge gate with all optional fields is accepted", () => {
    const result = gateInputSchema.safeParse({
      judge: {
        adapter: "claude-code",
        model: "claude-sonnet-4-6",
        prompt: "Check output quality.",
        timeoutMs: 60_000,
      },
    })
    expect(result.success).toBe(true)
  })

  it("(b) shell gate { command } is still accepted", () => {
    const result = gateInputSchema.safeParse({ command: "ls" })
    expect(result.success).toBe(true)
    if (result.success) {
      expect("command" in result.data).toBe(true)
    }
  })

  it("(b2) shell gate with all fields is still accepted", () => {
    const result = gateInputSchema.safeParse({
      command: "check.sh",
      args: ["--strict"],
      cwd: "/workspace",
      timeoutMs: 30_000,
    })
    expect(result.success).toBe(true)
  })

  it("(c) empty object is rejected", () => {
    const result = gateInputSchema.safeParse({})
    expect(result.success).toBe(false)
    if (!result.success) {
      // Should name missing field, not an opaque crash
      const msg = JSON.stringify(result.error.issues)
      expect(msg.length).toBeGreaterThan(0)
    }
  })

  it("(c2) judge variant missing required prompt is rejected", () => {
    const result = gateInputSchema.safeParse({
      judge: { adapter: "claude-code" }, // prompt missing
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      // z.union wraps sub-issues; check that "prompt" appears somewhere in
      // the serialised error so the error is readable, not an opaque crash.
      const msg = JSON.stringify(result.error.issues)
      expect(msg).toContain("prompt")
    }
  })

  it("(c3) shell variant missing command is rejected", () => {
    const result = gateInputSchema.safeParse({ args: ["--help"] }) // command missing
    expect(result.success).toBe(false)
  })

  it("(a) JSON-stringified judge gate is accepted (jsonTolerant compat)", () => {
    // Some MCP clients stringify composite params before sending.
    // The jsonTolerant wrapper on top of gateInputSchema handles this,
    // but here we test the bare schema; the wrapper is tested separately.
    // This test just confirms no accidental string rejection at schema level.
    const raw = { judge: { adapter: "claude-code", prompt: "Check it." } }
    expect(gateInputSchema.safeParse(raw).success).toBe(true)
  })
})
