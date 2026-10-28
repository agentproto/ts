import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryStore } from "@mastra/core/storage"
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock"
import { createTool } from "@mastra/core/tools"
import type { AgentCliClient, StreamEvent } from "@agentproto/harness"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"
import {
  createAgentCliClient,
  createAgentControllerHost,
  mastraController,
  parseControllerManifest,
  type PermissionRules,
} from "../index.js"

type Step = { toolCall: { name: string; input: unknown } } | { text: string }

/**
 * A model that plays `steps` in order, one per model call: a tool call
 * (finish reason `tool-calls`) or a text answer (finish reason `stop`).
 * Every call it received is kept in `prompts` so a test can read what the
 * model was told after a tool result.
 */
function scriptedModel(steps: Step[]) {
  let call = 0
  const prompts: unknown[] = []
  const model = new MastraLanguageModelV2Mock({
    doStream: async ({ prompt }) => {
      prompts.push(prompt)
      const step = steps[Math.min(call, steps.length - 1)]!
      const n = call++
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "stream-start", warnings: [] })
            if ("toolCall" in step) {
              c.enqueue({
                type: "tool-call",
                toolCallId: `call-${n}`,
                toolName: step.toolCall.name,
                input: JSON.stringify(step.toolCall.input),
              })
              c.enqueue({
                type: "finish",
                finishReason: "tool-calls",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              })
            } else {
              c.enqueue({ type: "text-start", id: `t${n}` })
              c.enqueue({ type: "text-delta", id: `t${n}`, delta: step.text })
              c.enqueue({ type: "text-end", id: `t${n}` })
              c.enqueue({
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              })
            }
            c.close()
          },
        }),
      }
    },
  })
  return { model, prompts }
}

const echoRuns: unknown[] = []
const echo = createTool({
  id: "echo",
  description: "Echo the text back.",
  inputSchema: z.object({ text: z.string() }),
  execute: async input => {
    echoRuns.push(input)
    return { echoed: (input as { text: string }).text }
  },
})

function manifestWith(permissions?: PermissionRules) {
  return parseControllerManifest({
    id: "approvals",
    name: "Approvals",
    version: "1.0.0",
    tools: { $resolver: "test/tools" },
    modes: [
      { id: "plan", name: "Plan", default: true, transitionsTo: "execute", defaultModelId: "stub" },
      { id: "execute", name: "Execute", defaultModelId: "stub" },
    ],
    ...(permissions ? { permissions } : {}),
  })
}

const clients: AgentCliClient[] = []
let cwd: string

async function connected(
  steps: Step[],
  opts: { permissions?: PermissionRules; permissionHold?: boolean } = {},
) {
  const { model, prompts } = scriptedModel(steps)
  const client = createAgentCliClient(mastraController, {
    manifest: manifestWith(opts.permissions),
    host: createAgentControllerHost({
      resolvers: { "test/tools": () => ({ echo }) },
      defaults: { storage: () => new InMemoryStore(), resolveModel: () => model as never },
    }),
  })
  clients.push(client)
  await client.connect({
    cwd,
    env: {},
    abortSignal: new AbortController().signal,
    permissionHold: opts.permissionHold ?? true,
  })
  return { client, prompts }
}

type Prompt = Extract<StreamEvent, { kind: "agent-prompt" }>

/**
 * Drain one turn, answering each `agent-prompt` with `answer` as it arrives
 * (the way the daemon's permission inbox calls `respondPermission`).
 */
async function runTurn(
  client: AgentCliClient,
  message: string,
  answer: (prompt: Prompt) => Parameters<NonNullable<AgentCliClient["respondPermission"]>>[1],
): Promise<StreamEvent[]> {
  await client.send("turn-1", message)
  const out: StreamEvent[] = []
  for await (const evt of client.events()) {
    out.push(evt)
    if (evt.kind === "agent-prompt") {
      expect(client.respondPermission!(evt.toolCallId, answer(evt))).toBe(true)
    }
  }
  return out
}

function textOf(events: StreamEvent[]): string {
  return events
    .filter((e): e is Extract<StreamEvent, { kind: "text-delta" }> => e.kind === "text-delta")
    .map(e => e.text)
    .join("")
}

function promptsIn(events: StreamEvent[]): Prompt[] {
  return events.filter((e): e is Prompt => e.kind === "agent-prompt")
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close()
  echoRuns.length = 0
})

describe("mastra-controller approvals (stub model, permission hold)", () => {
  cwd = mkdtempSync(join(tmpdir(), "mastra-controller-approvals-"))

  it("a tool approval surfaces as agent-prompt; allow runs the tool and the turn completes", async () => {
    const { client } = await connected([
      { toolCall: { name: "echo", input: { text: "hi" } } },
      { text: "done" },
    ])
    const events = await runTurn(client, "echo hi", p => {
      expect(p.options).toEqual([
        { optionId: "approve", name: "Allow", kind: "allow_once" },
        { optionId: "always_allow", name: "Always allow in this session", kind: "allow_always" },
        { optionId: "decline", name: "Deny", kind: "reject_once" },
      ])
      return { optionId: "approve" }
    })

    const [prompt] = promptsIn(events)
    expect(prompt).toMatchObject({
      kind: "agent-prompt",
      sessionId: client.sessionId,
      toolName: "echo",
      rawInput: { text: "hi" },
      text: 'Allow "echo"?',
    })
    expect(echoRuns).toEqual([{ text: "hi" }])
    expect(textOf(events)).toBe("done")
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "completed" })
  })

  it("always_allow grants the tool for the session: a second call is not asked", async () => {
    const { client } = await connected([
      { toolCall: { name: "echo", input: { text: "one" } } },
      { toolCall: { name: "echo", input: { text: "two" } } },
      { text: "done" },
    ])
    const events = await runTurn(client, "echo twice", () => ({ optionId: "always_allow" }))

    expect(promptsIn(events)).toHaveLength(1)
    expect(echoRuns).toEqual([{ text: "one" }, { text: "two" }])
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "completed" })
  })

  it("deny declines the tool: it never runs and the turn still completes", async () => {
    const { client } = await connected([
      { toolCall: { name: "echo", input: { text: "hi" } } },
      { text: "ok, not echoing" },
    ])
    const events = await runTurn(client, "echo hi", () => ({ optionId: "decline" }))

    expect(promptsIn(events)).toHaveLength(1)
    expect(echoRuns).toEqual([])
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "completed" })
  })

  it("a manifest permissions rule pre-answers: no agent-prompt is raised", async () => {
    const { client } = await connected(
      [{ toolCall: { name: "echo", input: { text: "hi" } } }, { text: "done" }],
      { permissions: { tools: { echo: "allow" } } },
    )
    const events = await runTurn(client, "echo hi", () => {
      throw new Error("a pre-answered tool must not prompt")
    })

    expect(promptsIn(events)).toEqual([])
    expect(echoRuns).toEqual([{ text: "hi" }])
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "completed" })
  })

  it("a manifest deny rule pre-answers: the tool never runs and nothing is asked", async () => {
    const { client } = await connected(
      [{ toolCall: { name: "echo", input: { text: "hi" } } }, { text: "denied" }],
      { permissions: { categories: { other: "allow" }, tools: { echo: "deny" } } },
    )
    const events = await runTurn(client, "echo hi", () => {
      throw new Error("a pre-answered tool must not prompt")
    })

    expect(promptsIn(events)).toEqual([])
    expect(echoRuns).toEqual([])
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "completed" })
  })

  it("ask_user surfaces its question and options; the answer resumes the turn", async () => {
    const { client, prompts } = await connected([
      {
        toolCall: {
          name: "ask_user",
          input: {
            question: "Which era?",
            options: [{ label: "Tang" }, { label: "Song" }],
          },
        },
      },
      { text: "Researching the Song dynasty." },
    ])
    const events = await runTurn(client, "research tea", p => {
      expect(p.text).toBe("Which era?")
      expect(p.toolName).toBe("ask_user")
      expect(p.options).toEqual([
        { optionId: "answer:0", name: "Tang", kind: "allow_once" },
        { optionId: "answer:1", name: "Song", kind: "allow_once" },
        { optionId: "decline", name: "Decline to answer", kind: "reject_once" },
      ])
      return { optionId: "answer:1" }
    })

    expect(promptsIn(events)).toHaveLength(1)
    expect(textOf(events)).toBe("Researching the Song dynasty.")
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "completed" })
    expect(JSON.stringify(prompts.at(-1))).toContain("User answered: Song")
  })

  it("a free-text ask_user answer rides on the resolution's feedback", async () => {
    const { client, prompts } = await connected([
      { toolCall: { name: "ask_user", input: { question: "Which tea?" } } },
      { text: "ok" },
    ])
    const events = await runTurn(client, "research tea", p => {
      expect(p.options).toEqual([
        { optionId: "answer", name: "Answer", kind: "allow_once" },
        { optionId: "decline", name: "Decline to answer", kind: "reject_once" },
      ])
      return { optionId: "answer", feedback: "Oolong" }
    })

    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "completed" })
    expect(JSON.stringify(prompts.at(-1))).toContain("User answered: Oolong")
  })

  it("submit_plan approved: the controller switches to transitionsTo with the notice", async () => {
    writeFileSync(join(cwd, "plan.md"), "# Plan\n\n1. Read sources.\n")
    const { client } = await connected([
      { toolCall: { name: "submit_plan", input: { path: "plan.md" } } },
      { text: "Executing." },
    ])
    expect(client.currentModeId).toBe("plan")
    const events = await runTurn(client, "plan it", p => {
      expect(p.toolName).toBe("submit_plan")
      expect(p.text).toBe("Approve the plan in plan.md and switch to mode 'execute'?")
      expect(p.options).toEqual([
        { optionId: "approve", name: "Approve plan", kind: "allow_once" },
        { optionId: "reject", name: "Reject plan", kind: "reject_once" },
      ])
      expect(p._meta).toMatchObject({
        "mastra-controller/request": "plan-approval",
        "mastra-controller/transitionsTo": "execute",
        "mastra-controller/plan": "# Plan\n\n1. Read sources.\n",
      })
      return { optionId: "approve" }
    })

    expect(client.currentModeId).toBe("execute")
    expect(events).toContainEqual({
      kind: "thought",
      sessionId: client.sessionId,
      text: "[mastra-controller] mode switched by the controller: plan -> execute",
    })
    expect(textOf(events)).toBe("Executing.")
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "completed" })
  })

  it("submit_plan rejected: stays in plan and the model gets the feedback", async () => {
    const { client, prompts } = await connected([
      { toolCall: { name: "submit_plan", input: { path: "plan.md" } } },
      { text: "Revising." },
    ])
    const events = await runTurn(client, "plan it", () => ({
      optionId: "reject",
      feedback: "Add a step on sources.",
    }))

    expect(client.currentModeId).toBe("plan")
    expect(events.some(e => e.kind === "thought")).toBe(false)
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "completed" })
    expect(JSON.stringify(prompts.at(-1))).toContain("User feedback: Add a step on sources.")
  })

  it("cancel while parked on a question ends the turn cancelled", async () => {
    const { client } = await connected([
      { toolCall: { name: "ask_user", input: { question: "Which era?" } } },
      { text: "never" },
    ])
    await client.send("turn-1", "research tea")
    const events: StreamEvent[] = []
    for await (const evt of client.events()) {
      events.push(evt)
      if (evt.kind === "agent-prompt") await client.cancel("turn-1")
    }
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "cancelled" })
    expect(client.respondPermission!(promptsIn(events)[0]!.toolCallId, { optionId: "answer" })).toBe(
      false,
    )
  })

  it("without permission hold, tool approvals are auto-allowed and nothing is surfaced", async () => {
    const { client } = await connected(
      [{ toolCall: { name: "echo", input: { text: "hi" } } }, { text: "done" }],
      { permissionHold: false },
    )
    const events = await runTurn(client, "echo hi", () => {
      throw new Error("no prompt expected without permission hold")
    })
    expect(promptsIn(events)).toEqual([])
    expect(echoRuns).toEqual([{ text: "hi" }])
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "completed" })
  })

  it("without permission hold, ask_user gets a no-user answer and the turn completes", async () => {
    const { client, prompts } = await connected(
      [{ toolCall: { name: "ask_user", input: { question: "Which era?" } } }, { text: "guessing" }],
      { permissionHold: false },
    )
    const events = await runTurn(client, "research tea", () => {
      throw new Error("no prompt expected without permission hold")
    })
    expect(promptsIn(events)).toEqual([])
    expect(textOf(events)).toBe("guessing")
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "completed" })
    expect(JSON.stringify(prompts.at(-1))).toContain("No user is attached to answer this question")
  })

  it("without permission hold, a plan is rejected and the session stays in plan", async () => {
    const { client } = await connected(
      [{ toolCall: { name: "submit_plan", input: { path: "plan.md" } } }, { text: "waiting" }],
      { permissionHold: false },
    )
    const events = await runTurn(client, "plan it", () => {
      throw new Error("no prompt expected without permission hold")
    })
    expect(client.currentModeId).toBe("plan")
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "thought",
        text: "[mastra-controller] no permission hold: answered submit_plan with reject",
      }),
    )
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "completed" })
  })
})
