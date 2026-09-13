/**
 * A hand-rolled `LanguageModelV2` (the `@ai-sdk/provider` v2 spec @mastra/core
 * 1.57.0 speaks) that plays back a fixed script of turns instead of calling a
 * real provider — lets WP-3's mode tests drive a real `AgentController` +
 * `Session` through an actual tool-calling run (submit_plan suspend/resume)
 * with no network access or API key.
 *
 * Not from an ai-sdk/mastra test-utils package: `@mastra/core`'s own mock
 * model lives at `agent-controller/test-utils.js`, which its package.json
 * `exports` map doesn't expose outside the package (no `"./*"` wildcard), and
 * `ai/test` isn't a dependency of this adapter. The `LanguageModelV2`
 * interface itself is small and stable, so implementing it directly here is
 * cheaper than adding a dependency for it.
 */

export type ScriptedTurn =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }

/** A minimal object satisfying `LanguageModelV2` well enough for Mastra's Agent loop. */
export interface ScriptedModel {
  specificationVersion: "v2"
  provider: string
  modelId: string
  supportedUrls: () => Promise<Record<string, RegExp[]>>
  doGenerate: (options: unknown) => Promise<unknown>
  doStream: (options: unknown) => Promise<unknown>
  /** Number of `doStream`/`doGenerate` calls made so far. */
  callCount: () => number
}

function contentFor(turn: ScriptedTurn): unknown[] {
  if (turn.type === "text") return [{ type: "text", text: turn.text }]
  return [
    {
      type: "tool-call",
      toolCallId: turn.toolCallId,
      toolName: turn.toolName,
      input: JSON.stringify(turn.input),
    },
  ]
}

function streamPartsFor(turn: ScriptedTurn, callIndex: number): unknown[] {
  const preamble = [
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: `id-${callIndex}`, modelId: "mock-model", timestamp: new Date(0) },
  ]
  if (turn.type === "text") {
    return [
      ...preamble,
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: turn.text },
      { type: "text-end", id: "t1" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ]
  }
  return [
    ...preamble,
    {
      type: "tool-call",
      toolCallId: turn.toolCallId,
      toolName: turn.toolName,
      input: JSON.stringify(turn.input),
    },
    {
      type: "finish",
      finishReason: "tool-calls",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  ]
}

/**
 * Build a scripted model: each `doStream`/`doGenerate` call consumes the next
 * turn in `turns`, in order. Once exhausted, the last turn repeats — so a
 * trailing `{ type: "text" }` turn safely absorbs any extra steps the agent
 * loop takes (e.g. a final acknowledgement after a tool result) without the
 * test needing to predict the exact call count.
 */
export function createScriptedModel(turns: ScriptedTurn[]): ScriptedModel {
  if (turns.length === 0) throw new Error("createScriptedModel: turns must be non-empty")
  let calls = 0
  const nextTurn = () => turns[Math.min(calls, turns.length - 1)]!

  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId: "mock-model",
    supportedUrls: async () => ({}),
    callCount: () => calls,
    doGenerate: async () => {
      const turn = nextTurn()
      calls++
      return {
        content: contentFor(turn),
        finishReason: turn.type === "tool-call" ? "tool-calls" : "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }
    },
    doStream: async () => {
      const turn = nextTurn()
      const parts = streamPartsFor(turn, calls)
      calls++
      return {
        warnings: [],
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          },
        }),
      }
    },
  }
}
