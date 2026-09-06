/**
 * Print-arm derived-from-model guard (jcode).
 *
 * jcode's CLI silently falls back to its OWN default on an unknown
 * `--model` id — observed live (jcode v0.75.5): `--model totally-bogus-xyz`
 * → `{"type":"start","model":"gpt-5.6-sol","provider":"OpenAI"}` and the
 * turn proceeds on OpenAI. For a `routeSelection:"derived-from-model"`
 * adapter the model id is the route and the bill, so the arm must abort
 * the turn the moment the wire `start` event contradicts the requested
 * model — the print-protocol counterpart of the ACP-arm guard in
 * `define-agent-cli.ts`.
 */
import { describe, expect, it } from "vitest"

import { createPrintSession, printModelMismatch } from "../protocol/print-arm.js"
import type { StreamEvent } from "../types.js"

describe("printModelMismatch", () => {
  it("matches jcode's normalized echo of an @route-suffixed id", () => {
    // jcode reports `deepseek/deepseek-v4-pro` for a requested
    // `deepseek/deepseek-v4-pro@openrouter` — same model, no mismatch.
    expect(
      printModelMismatch("deepseek/deepseek-v4-pro@openrouter", "deepseek/deepseek-v4-pro"),
    ).toBe(false)
  })

  it("matches a provider-prefixed request against a bare reported id", () => {
    expect(printModelMismatch("openai/gpt-5", "gpt-5")).toBe(false)
  })

  it("is case-insensitive", () => {
    expect(printModelMismatch("Anthropic/Claude-Sonnet-4-5", "claude-sonnet-4-5")).toBe(false)
  })

  it("flags the observed silent default fallback", () => {
    expect(printModelMismatch("totally-bogus-xyz", "gpt-5.6-sol")).toBe(true)
  })

  it("has no substring leniency — a near-miss default is still a mismatch", () => {
    // Requested gpt-5, CLI falls back to gpt-5.6-sol: "gpt-5" is a
    // substring of the reported id, but they are different models.
    expect(printModelMismatch("gpt-5", "gpt-5.6-sol")).toBe(true)
  })
})

/**
 * Fake jcode: prints a `start` line naming MODEL (its own choice), then a
 * text reply and `done` — the shape a real silently-defaulted turn has.
 */
function fakeJcodeBinArgs(startedModel: string): string[] {
  const script = `
    const lines = [
      JSON.stringify({ type: "start", model: ${JSON.stringify(startedModel)}, provider: "OpenAI", session_id: "sess_fake_1" }),
      JSON.stringify({ type: "text_delta", text: "hi" }),
      JSON.stringify({ type: "done", text: "hi", session_id: "sess_fake_1" }),
    ]
    for (const l of lines) console.log(l)
  `
  return ["-e", script]
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const evt of events) out.push(evt)
  return out
}

describe("print-arm expectedModel guard (integration, fake jcode)", () => {
  const printConfig = {
    event_schema: "jcode-ndjson" as const,
    output_format: [],
    pre_prompt: [],
  }

  it("aborts the turn with a loud error when the started model contradicts the request", async () => {
    const session = createPrintSession({
      bin: process.execPath,
      baseArgs: fakeJcodeBinArgs("gpt-5.6-sol"),
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      printConfig,
      expectedModel: "totally-bogus-xyz",
    })

    const events = await collect(session.send("say hi"))
    const err = events.find(e => e.kind === "error")
    expect(err).toBeDefined()
    expect((err as { error: { message: string } }).error.message).toContain("model mismatch")
    expect((err as { error: { message: string } }).error.message).toContain("totally-bogus-xyz")
    expect((err as { error: { message: string } }).error.message).toContain("gpt-5.6-sol")
    // The turn is aborted — the silently-defaulted reply must not stream.
    expect(events.some(e => e.kind === "text-delta")).toBe(false)
    await session.close()
  })

  it("streams normally when the started model matches (normalized forms)", async () => {
    const session = createPrintSession({
      bin: process.execPath,
      baseArgs: fakeJcodeBinArgs("deepseek/deepseek-v4-pro"),
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      printConfig,
      expectedModel: "deepseek/deepseek-v4-pro@openrouter",
    })

    const events = await collect(session.send("say hi"))
    expect(events.some(e => e.kind === "error")).toBe(false)
    expect(events.some(e => e.kind === "text-delta")).toBe(true)
    expect(events.some(e => e.kind === "turn-end")).toBe(true)
    await session.close()
  })

  it("does not guard when no expectedModel was set (no explicit model request)", async () => {
    const session = createPrintSession({
      bin: process.execPath,
      baseArgs: fakeJcodeBinArgs("gpt-5.6-sol"),
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      printConfig,
    })

    const events = await collect(session.send("say hi"))
    expect(events.some(e => e.kind === "error")).toBe(false)
    expect(events.some(e => e.kind === "text-delta")).toBe(true)
    await session.close()
  })
})
