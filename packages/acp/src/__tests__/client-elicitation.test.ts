import { describe, it, expect } from "vitest"
import {
  AgentSideConnection,
  ndJsonStream,
  type AgentSideConnection as AgentConn,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
} from "@agentclientprotocol/sdk"

import { createAcpClient, type AcpClient } from "../client/index.js"
import type { AgentPromptAnswers, StreamEvent } from "../types.js"
import { ASK_MULTI, ASK_SINGLE, ASK_TWO } from "./fixtures/claude-agent-acp-elicitation.js"

// ---------------------------------------------------------------------------
// Real SDK on both ends of an in-memory pipe: the agent side sends the exact
// `elicitation/create` claude-agent-acp@0.81.2 sends for AskUserQuestion, the
// client side is `createAcpClient`. No SDK mock, so the SDK's own request
// validation (which decides whether `_meta` and option descriptions survive)
// is part of what is tested.
// ---------------------------------------------------------------------------

type Prompt = Extract<StreamEvent, { kind: "agent-prompt" }>

interface Harness {
  client: AcpClient
  clientCapabilities: () => Record<string, unknown> | undefined
  /** Make the agent send `request` during the next turn; resolves with the response. */
  ask: (request: unknown) => { response: Promise<CreateElicitationResponse>; prompt: Promise<Prompt> }
}

async function connect(permissionHold: boolean): Promise<Harness> {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>()
  const toClient = new TransformStream<Uint8Array, Uint8Array>()
  let caps: Record<string, unknown> | undefined
  let pending: { request: unknown; done: (r: CreateElicitationResponse) => void } | undefined
  let conn!: AgentConn
  conn = new AgentSideConnection(
    c => {
      conn = c
      return {
        async initialize(params) {
          caps = params.clientCapabilities as Record<string, unknown> | undefined
          return { protocolVersion: 1, agentCapabilities: {} }
        },
        async newSession() {
          return { sessionId: "sess-q" }
        },
        async authenticate() {
          return {}
        },
        async prompt() {
          const job = pending!
          pending = undefined
          const request = { ...(job.request as object), sessionId: "sess-q" } as CreateElicitationRequest
          job.done(await conn.createElicitation(request))
          return { stopReason: "end_turn" }
        },
        async cancel() {},
      }
    },
    ndJsonStream(toClient.writable, toAgent.readable),
  )
  const client = await createAcpClient({
    output: toAgent.writable,
    input: toClient.readable,
    permissionHold,
  })
  const session = await client.newSession({ cwd: "/tmp" })
  return {
    client,
    clientCapabilities: () => caps,
    ask(request) {
      let done!: (r: CreateElicitationResponse) => void
      const response = new Promise<CreateElicitationResponse>(r => (done = r))
      pending = { request, done }
      const prompt = (async () => {
        for await (const evt of session.prompt({ messages: [{ type: "text", text: "ask" }] })) {
          if (evt.kind === "agent-prompt") return evt
        }
        throw new Error("turn ended without an agent-prompt")
      })()
      return { response, prompt }
    },
  }
}

describe("createAcpClient form elicitation (claude-agent-acp AskUserQuestion)", () => {
  it("advertises elicitation.form only when permission hold is on", async () => {
    expect((await connect(true)).clientCapabilities()?.elicitation).toEqual({ form: {} })
    expect((await connect(false)).clientCapabilities()?.elicitation).toBeUndefined()
  })

  it("maps a single-select question with its Other box to one field", async () => {
    const h = await connect(true)
    const { prompt, response } = h.ask(ASK_SINGLE)
    const evt = await prompt
    expect(evt.request).toBe("question")
    expect(evt.toolCallId).toMatch(/^perm_/)
    expect(evt.text).toBe("Which database should we use?")
    expect(evt.question?.fields).toEqual([
      {
        id: "question_0",
        input: "single",
        header: "Database",
        prompt: "Which database should we use?",
        choices: [
          { value: "Postgres", label: "Postgres", description: "Relational, battle tested" },
          { value: "SQLite", label: "SQLite", description: "Embedded file", preview: "db.sqlite" },
        ],
        allowFreeText: true,
      },
    ])
    // Legacy projection of the one single field, every id in `options`.
    expect(evt.question?.choices).toEqual([
      { optionId: "choice_0", label: "Postgres", description: "Relational, battle tested" },
      { optionId: "choice_1", label: "SQLite", description: "Embedded file" },
    ])
    expect(evt.question?.allowFreeText).toBe(true)
    expect(evt.question?.freeTextOptionId).toBe("other")
    const optionIds = (evt.options as Array<{ optionId: string }>).map(o => o.optionId)
    expect(optionIds).toEqual(["submit", "skip", "choice_0", "choice_1", "other"])

    const answers: AgentPromptAnswers = { question_0: { selected: ["SQLite"], text: "keep it local" } }
    expect(h.client.respondPermission(evt.toolCallId, { answers })).toBe(true)
    expect(await response).toEqual({
      action: "accept",
      content: { question_0: "SQLite", question_0_custom: "keep it local" },
    })
  })

  it("maps a multiSelect question and sends the picks back as an array", async () => {
    const h = await connect(true)
    const { prompt, response } = h.ask(ASK_MULTI)
    const evt = await prompt
    expect(evt.question?.fields).toEqual([
      {
        id: "question_0",
        input: "multi",
        header: "Features",
        prompt: "Which features do you want?",
        choices: [
          { value: "Logs", label: "Logs" },
          { value: "Metrics", label: "Metrics" },
          { value: "Traces", label: "Traces" },
        ],
        allowFreeText: true,
      },
    ])
    // No legacy projection for a multi field: only submit + skip.
    expect(evt.question?.choices).toEqual([])
    expect((evt.options as Array<{ optionId: string }>).map(o => o.optionId)).toEqual(["submit", "skip"])

    h.client.respondPermission(evt.toolCallId, {
      answers: { question_0: { selected: ["Logs", "Traces"], text: "profiles" } },
    })
    expect(await response).toEqual({
      action: "accept",
      content: { question_0: ["Logs", "Traces"], question_0_custom: "profiles" },
    })
  })

  it("maps two questions to two fields and answers both in one response", async () => {
    const h = await connect(true)
    const { prompt, response } = h.ask(ASK_TWO)
    const evt = await prompt
    expect(evt.text).toBe("Please answer the following questions.")
    expect(evt.question?.prompt).toBe("Please answer the following questions.")
    const fields = evt.question?.fields ?? []
    expect(fields.map(f => [f.id, f.input, f.header, f.prompt, f.allowFreeText])).toEqual([
      ["question_0", "single", "Database", "Which database should we use?", true],
      ["question_1", "multi", "Features", "Which features do you want?", true],
    ])

    h.client.respondPermission(evt.toolCallId, {
      answers: { question_0: { text: "MySQL" }, question_1: { selected: ["Metrics"] } },
    })
    expect(await response).toEqual({
      action: "accept",
      content: { question_0_custom: "MySQL", question_1: ["Metrics"] },
    })
  })

  it("skip declines, a legacy choice accepts, teardown cancels", async () => {
    const skip = await connect(true)
    const a = skip.ask(ASK_TWO)
    skip.client.respondPermission((await a.prompt).toolCallId, { optionId: "skip" })
    expect(await a.response).toEqual({ action: "decline" })

    const legacy = await connect(true)
    const b = legacy.ask(ASK_SINGLE)
    const evt = await b.prompt
    expect(legacy.client.respondPermission(evt.toolCallId, { optionId: "nope" })).toBe(false)
    expect(legacy.client.respondPermission(evt.toolCallId, { optionId: "choice_0" })).toBe(true)
    expect(await b.response).toEqual({ action: "accept", content: { question_0: "Postgres" } })

    const torn = await connect(true)
    const c = torn.ask(ASK_MULTI)
    await c.prompt
    await torn.client.close()
    expect(await c.response).toEqual({ action: "cancel" })
  })
})
