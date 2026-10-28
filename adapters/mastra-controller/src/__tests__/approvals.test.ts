import { execFileSync } from "node:child_process"
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { InMemoryStore } from "@mastra/core/storage"
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock"
import { createTool } from "@mastra/core/tools"
import type { Session } from "@mastra/core/agent-controller"
import type { AgentCliClient, StreamEvent } from "@agentproto/harness"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"
import {
  createAgentCliClient,
  createAgentControllerHost,
  mastraController,
  META_PLAN,
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

const deployRuns: unknown[] = []
/** A tool that parks on `suspend()` until resumed, then reports the resume data. */
const deploy = createTool({
  id: "deploy",
  description: "Deploy after a confirmation.",
  inputSchema: z.object({ target: z.string() }),
  execute: async (input, context) => {
    const resumeData = context?.agent?.resumeData as { approved?: boolean } | undefined
    if (resumeData === undefined) {
      await context?.agent?.suspend({ reason: "confirm the deploy" })
      return { deployed: false }
    }
    deployRuns.push({ input, resumeData })
    return { deployed: resumeData.approved === true }
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
  const host = createAgentControllerHost({
    resolvers: { "test/tools": () => ({ echo, deploy }) },
    defaults: { storage: () => new InMemoryStore(), resolveModel: () => model as never },
  })
  // Keep the controller's session so a test can emit controller events on it.
  const session: { current?: Session } = {}
  const client = createAgentCliClient(mastraController, {
    manifest: manifestWith(opts.permissions),
    host: {
      ...host,
      async createController(manifest, ctx) {
        const controller = await host.createController(manifest, ctx)
        const createSession = controller.createSession.bind(controller)
        controller.createSession = (async (o: Parameters<typeof createSession>[0]) =>
          (session.current = await createSession(o))) as typeof createSession
        return controller
      },
    },
  })
  clients.push(client)
  await client.connect({
    cwd,
    env: {},
    abortSignal: new AbortController().signal,
    permissionHold: opts.permissionHold ?? true,
  })
  return { client, prompts, session: session.current! }
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
  deployRuns.length = 0
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

  it("a generic suspend() surfaces as a suspension; approve resumes it with { approved: true }", async () => {
    const { client } = await connected(
      [{ toolCall: { name: "deploy", input: { target: "prod" } } }, { text: "deployed" }],
      { permissions: { tools: { deploy: "allow" } } },
    )
    const events = await runTurn(client, "deploy prod", p => {
      expect(p.toolName).toBe("deploy")
      expect(p.text).toBe('Continue "deploy"?')
      expect(p.options).toEqual([
        { optionId: "approve", name: "Continue", kind: "allow_once" },
        { optionId: "decline", name: "Cancel", kind: "reject_once" },
      ])
      expect(p._meta).toEqual({
        "mastra-controller/request": "suspension",
        "mastra-controller/suspendPayload": { reason: "confirm the deploy" },
      })
      return { optionId: "approve" }
    })

    expect(promptsIn(events)).toHaveLength(1)
    expect(deployRuns).toEqual([{ input: { target: "prod" }, resumeData: { approved: true } }])
    expect(textOf(events)).toBe("deployed")
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "completed" })
  })

  it("a generic suspend() declined resumes with { approved: false, feedback }", async () => {
    const { client } = await connected(
      [{ toolCall: { name: "deploy", input: { target: "prod" } } }, { text: "not deployed" }],
      { permissions: { tools: { deploy: "allow" } } },
    )
    const events = await runTurn(client, "deploy prod", () => ({
      optionId: "decline",
      feedback: "not today",
    }))

    expect(deployRuns).toEqual([
      { input: { target: "prod" }, resumeData: { approved: false, feedback: "not today" } },
    ])
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "completed" })
  })

  it("tool_suspension_cancelled drops the open request: its prompt can no longer be answered", async () => {
    const { client, session } = await connected(
      [{ toolCall: { name: "deploy", input: { target: "prod" } } }, { text: "never" }],
      { permissions: { tools: { deploy: "allow" } } },
    )
    await client.send("turn-1", "deploy prod")
    const events: StreamEvent[] = []
    let answered: boolean | undefined
    for await (const evt of client.events()) {
      events.push(evt)
      if (evt.kind !== "agent-prompt") continue
      const toolCallId = evt.toolCallId.slice(0, evt.toolCallId.lastIndexOf("#"))
      session.emit({ type: "tool_suspension_cancelled", toolCallId, toolName: "deploy", reason: "gone" })
      answered = client.respondPermission!(evt.toolCallId, { optionId: "approve" })
      await client.cancel("turn-1")
    }

    expect(answered).toBe(false)
    expect(deployRuns).toEqual([])
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "cancelled" })
  })

  it("tool_suspension_cancelled before the prompt is raised: no stale prompt is surfaced", async () => {
    const { client, session } = await connected(
      [{ toolCall: { name: "deploy", input: { target: "prod" } } }, { text: "never" }],
      { permissions: { tools: { deploy: "allow" } } },
    )
    // The client's listener subscribed first, so the request is open when
    // this one cancels it, before the async prompt build lands.
    let parked!: () => void
    const suspended = new Promise<void>(r => (parked = r))
    session.subscribe(evt => {
      if (evt.type !== "tool_suspended") return
      session.emit({
        type: "tool_suspension_cancelled",
        toolCallId: evt.toolCallId,
        toolName: evt.toolName,
        reason: "gone",
      })
      parked()
    })
    await client.send("turn-1", "deploy prod")
    void suspended.then(() => setTimeout(() => void client.cancel("turn-1"), 50))
    const events: StreamEvent[] = []
    for await (const evt of client.events()) events.push(evt)

    expect(promptsIn(events)).toEqual([])
    expect(deployRuns).toEqual([])
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "cancelled" })
  })

  it("a multi_select question is single-pick: one answer, no selectionMode advertised", async () => {
    const { client, prompts } = await connected([
      {
        toolCall: {
          name: "ask_user",
          input: {
            question: "Which teas?",
            options: [{ label: "Oolong" }, { label: "Puer" }],
            selectionMode: "multi_select",
          },
        },
      },
      { text: "ok" },
    ])
    const events = await runTurn(client, "pick teas", p => {
      expect(p._meta).not.toHaveProperty("mastra-controller/selectionMode")
      return { optionId: "answer:1" }
    })

    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "completed" })
    expect(JSON.stringify(prompts.at(-1))).toContain("Puer")
  })
})

describe("mastra-controller plan read (confined to the session cwd, bounded)", () => {
  const outside = mkdtempSync(join(tmpdir(), "mastra-controller-outside-"))
  const secret = join(outside, "secret.md")
  writeFileSync(secret, "TOP SECRET\n")

  /** Run a `submit_plan` turn for `path`; return the prompt's plan `_meta` (rejecting the plan). */
  async function planFor(path: string): Promise<unknown> {
    const { client } = await connected([
      { toolCall: { name: "submit_plan", input: { path } } },
      { text: "ok" },
    ])
    let plan: unknown
    const events = await runTurn(client, "plan it", p => {
      expect(p.toolName).toBe("submit_plan")
      plan = (p._meta as Record<string, unknown>)[META_PLAN]
      return { optionId: "reject" }
    })
    expect(promptsIn(events)).toHaveLength(1)
    return plan
  }

  it("refuses a ../ path that leaves the cwd", async () => {
    const rel = join("..", basename(outside), "secret.md")
    expect(await planFor(rel)).toBe("plan not readable: outside the session cwd")
  })

  it("refuses an absolute path outside the cwd", async () => {
    expect(await planFor(secret)).toBe("plan not readable: outside the session cwd")
  })

  it("refuses a symlink inside the cwd that resolves outside it", async () => {
    symlinkSync(secret, join(cwd, "escape.md"))
    expect(await planFor("escape.md")).toBe("plan not readable: outside the session cwd")
  })

  it("reads an absolute path inside the cwd", async () => {
    writeFileSync(join(cwd, "inside.md"), "inside plan")
    expect(await planFor(join(cwd, "inside.md"))).toBe("inside plan")
  })

  it("truncates an oversized plan to MAX_PLAN_BYTES bytes, with a note", async () => {
    const max = 256 * 1024
    writeFileSync(join(cwd, "big.md"), "\u00e9".repeat(max))
    expect(await planFor("big.md")).toBe(`${"\u00e9".repeat(max / 2)}\n[plan truncated at ${max} bytes]`)
  })

  it("refuses a non-regular file (a fifo) without blocking on it", async () => {
    execFileSync("mkfifo", [join(cwd, "pipe.md")])
    expect(await planFor("pipe.md")).toBe("plan not readable: not a regular file")
  })

  it("a missing plan still surfaces the prompt, with the reason", async () => {
    expect(await planFor("missing.md")).toBe("plan not readable: ENOENT")
  })
})
