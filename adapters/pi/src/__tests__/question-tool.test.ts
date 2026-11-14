import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", () => ({ spawn: spawnMock }))

import { createAgentCliClient } from "../client.js"
import { pi } from "../index.js"
import type { AgentCliClient, AgentCliConnectOptions, StreamEvent } from "@agentproto/harness"

interface FakeChild {
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
  killed: boolean
}

function makeFakeChild(): EventEmitter & FakeChild {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const child = new EventEmitter() as EventEmitter & FakeChild
  child.stdout = stdout
  child.stderr = stderr
  child.killed = false
  child.kill = vi.fn()
  child.stdin = {
    end: vi.fn(),
    write: vi.fn((data: string) => {
      const msg = JSON.parse(data) as { id: string; type: string }
      if (msg.type === "get_state") {
        queueMicrotask(() => {
          stdout.emit(
            "data",
            `${JSON.stringify({
              id: msg.id,
              type: "response",
              command: "get_state",
              success: true,
              data: { sessionId: "sess-fake" },
            })}\n`,
          )
        })
      }
      if (msg.type === "abort") {
        queueMicrotask(() => {
          stdout.emit(
            "data",
            `${JSON.stringify({
              id: msg.id,
              type: "response",
              command: "abort",
              success: true,
            })}\n`,
          )
        })
      }
    }),
  }
  return child
}

function connectOpts(overrides: Partial<AgentCliConnectOptions> = {}): AgentCliConnectOptions {
  return {
    cwd: "/tmp",
    env: {},
    abortSignal: new AbortController().signal,
    ...overrides,
  }
}

function questionPrefill(): string {
  return JSON.stringify({
    questions: [
      {
        question: "Pick a color",
        header: "Couleur",
        options: [
          { label: "Red", description: "warm" },
          { label: "Blue", description: "cool" },
        ],
        multiSelect: false,
      },
      {
        question: "Pick targets",
        header: "Cibles",
        options: [
          { label: "Web" },
          { label: "iOS" },
        ],
        multiSelect: true,
      },
    ],
  })
}

async function parkQuestion(
  client: AgentCliClient,
  child: EventEmitter & FakeChild,
  prefill: string,
  requestId: string,
): Promise<StreamEvent> {
  const iter = client.events()[Symbol.asyncIterator]()
  await client.send("turn-1", { role: "user", content: [{ type: "text", text: "ask me" }] })
  child.stdout.emit(
    "data",
    `${JSON.stringify({
      type: "extension_ui_request",
      id: requestId,
      method: "editor",
      title: "agentproto.question/v1",
      prefill,
    })}\n`,
  )
  const first = iter.next()
  const result = await first
  expect(result.done).toBe(false)
  if (result.done) throw new Error("expected an agent-prompt event")
  return result.value
}

describe("adapter-pi question tool", () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it("does not pass the question extension when permissionHold is unset", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const client = createAgentCliClient(pi)

    await client.connect(connectOpts({ model: "anthropic/claude-sonnet-5-5" }))

    const [, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(args).toEqual(["--mode", "rpc", "--model", "anthropic/claude-sonnet-5-5"])

    await client.close()
  })

  it("passes the question extension when permissionHold is set", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const client = createAgentCliClient(pi)

    await client.connect(
      connectOpts({ model: "anthropic/claude-sonnet-5-5", permissionHold: true }),
    )

    const [, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(args[0]).toBe("--mode")
    expect(args[1]).toBe("rpc")
    const extIndex = args.indexOf("-e")
    expect(extIndex).toBeGreaterThanOrEqual(0)
    expect(String(args[extIndex + 1])).toMatch(/question-extension\.mjs$/)

    await client.close()
  })

  it("parks an extension_ui_request as an agent-prompt question with fields", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const client = createAgentCliClient(pi)

    await client.connect(
      connectOpts({ model: "anthropic/claude-sonnet-5-5", permissionHold: true }),
    )

    const event = await parkQuestion(client, child, questionPrefill(), "req-q1")
    expect(event.kind).toBe("agent-prompt")
    if (event.kind !== "agent-prompt") throw new Error("not an agent-prompt")
    expect(event.toolCallId).toBe("req-q1")
    expect(event.request).toBe("question")
    expect(event.text).toBe("Pick a color")
    const question = event.question
    expect(question).toBeDefined()
    if (!question) throw new Error("no question")
    expect(question.prompt).toBe("Pick a color")
    expect(question.allowFreeText).toBe(true)
    expect(question.fields).toBeDefined()
    expect(question.fields?.length).toBe(2)
    const firstField = question.fields?.[0]
    expect(firstField?.id).toBe("question_0")
    expect(firstField?.input).toBe("single")
    expect(firstField?.prompt).toBe("Pick a color")
    const secondField = question.fields?.[1]
    expect(secondField?.id).toBe("question_1")
    expect(secondField?.input).toBe("multi")

    await client.close()
  })

  it("answers a parked question through respondPermission with selected answers", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const client = createAgentCliClient(pi)

    await client.connect(
      connectOpts({ model: "anthropic/claude-sonnet-5-5", permissionHold: true }),
    )

    const event = await parkQuestion(client, child, questionPrefill(), "req-q2")
    if (event.kind !== "agent-prompt") throw new Error("not an agent-prompt")

    const answered = client.respondPermission!("req-q2", {
      answers: { "question_0": { selected: ["Red"] } },
    })
    expect(answered).toBe(true)

    expect(child.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({
        type: "extension_ui_response",
        id: "req-q2",
        value: JSON.stringify({
          answers: [{ header: "Couleur", question: "Pick a color", selected: ["Red"] },{ header: "Cibles", question: "Pick targets", selected: [] }],
        }),
      })}\n`,
    )

    await client.close()
  })

  it("answers a parked question through respondPermission with skip", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const client = createAgentCliClient(pi)

    await client.connect(
      connectOpts({ model: "anthropic/claude-sonnet-5-5", permissionHold: true }),
    )

    const event = await parkQuestion(client, child, questionPrefill(), "req-q3")
    if (event.kind !== "agent-prompt") throw new Error("not an agent-prompt")

    const skipped = client.respondPermission!("req-q3", { optionId: "skip" })
    expect(skipped).toBe(true)

    expect(child.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: "extension_ui_response", id: "req-q3", value: JSON.stringify({ skipped: true }) })}\n`,
    )

    await client.close()
  })

  it("refuses a bare submit without answers", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const client = createAgentCliClient(pi)

    await client.connect(
      connectOpts({ model: "anthropic/claude-sonnet-5-5", permissionHold: true }),
    )

    const event = await parkQuestion(client, child, questionPrefill(), "req-q4")
    if (event.kind !== "agent-prompt") throw new Error("not an agent-prompt")

    const submitted = client.respondPermission!("req-q4", { optionId: "submit" })
    expect(submitted).toBe(false)
    expect(child.stdin.write).not.toHaveBeenCalledWith(
      expect.stringContaining("req-q4"),
    )

    await client.close()
  })

  it("cancels a parked question on turn cancel", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const client = createAgentCliClient(pi)

    await client.connect(
      connectOpts({ model: "anthropic/claude-sonnet-5-5", permissionHold: true }),
    )

    const event = await parkQuestion(client, child, questionPrefill(), "req-q5")
    if (event.kind !== "agent-prompt") throw new Error("not an agent-prompt")

    await client.cancel("turn-1")

    expect(child.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: "extension_ui_response", id: "req-q5", cancelled: true })}\n`,
    )

    await client.close()
  })
})
