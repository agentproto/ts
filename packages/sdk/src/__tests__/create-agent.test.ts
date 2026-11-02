import { describe, expect, it } from "vitest"
import { z } from "zod"
import { defineTool, implementTool } from "../index.js"
import {
  AgentCompletionError,
  AgentStepLimitError,
  AgentStoppedError,
  createAgent,
} from "../create-agent.js"
import type {
  AgentStreamEvent,
  CompletionFn,
  FetchLike,
  ToolCallRequest,
} from "../types.js"

const weatherTool = () =>
  implementTool(
    defineTool({
      id: "weather",
      description: "Get weather",
      inputSchema: z.object({ city: z.string() }),
    }),
    async ({ input }) => ({ city: input.city, tempC: 21 }),
  )

const toolCall = (
  name: string,
  args: Record<string, unknown> = {},
  id = "call_1",
): ToolCallRequest => ({
  id,
  name,
  arguments: JSON.stringify(args),
})

describe("createAgent", () => {
  it("builds a validated AIP-42 handle", () => {
    const agent = createAgent({
      id: "greeter",
      model: "test/model",
      description: "Greets.",
      tools: [weatherTool()],
    })

    expect(agent.id).toBe("greeter")
    expect(agent.model).toBe("test/model")
    expect(agent.handle.schema).toBe("agent/v1")
    expect(agent.handle.tools).toEqual(["weather"])
    expect(agent.tools.map((tool) => tool.id)).toEqual(["weather"])
  })

  it("rejects an invalid id with the AIP-42 error", () => {
    expect(() => createAgent({ id: "X", model: "m" })).toThrow(/invalid id/)
  })

  it("rejects duplicate tool ids", () => {
    const handle = defineTool({
      id: "dup",
      description: "Duplicate.",
      inputSchema: z.object({}),
    })
    expect(() =>
      createAgent({ id: "agent", model: "m", tools: [handle, handle] }),
    ).toThrow(/duplicate tool id/)
  })

  it("runs a tool round-trip and returns the final text", async () => {
    const seen: string[] = []
    let calls = 0
    const complete: CompletionFn = async (request) => {
      calls += 1
      expect(request.tools.map((tool) => tool.name)).toEqual(["weather"])
      expect(request.tools[0]?.parameters).toMatchObject({
        type: "object",
        properties: { city: { type: "string" } },
      })

      if (calls === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            toolCalls: [toolCall("weather", { city: "Paris" })],
          },
        }
      }

      const toolMessage = request.messages.find((m) => m.role === "tool")
      seen.push(toolMessage?.content ?? "")
      return { message: { role: "assistant", content: "21°C in Paris" } }
    }

    const agent = createAgent({
      id: "greeter",
      model: "test/model",
      system: "Be brief.",
      tools: [weatherTool()],
      complete,
    })

    await expect(agent.run("Weather in Paris?")).resolves.toBe("21°C in Paris")
    expect(calls).toBe(2)
    expect(JSON.parse(seen[0]!)).toEqual({ city: "Paris", tempC: 21 })
  })

  it("reports a tool-error for a contract with no implementation", async () => {
    const bare = defineTool({
      id: "bare",
      description: "No body.",
      inputSchema: z.object({ n: z.number() }),
    })
    let calls = 0
    const complete: CompletionFn = async () => {
      calls += 1
      if (calls === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            toolCalls: [toolCall("bare", { n: 1 })],
          },
        }
      }
      return { message: { role: "assistant", content: "gave up" } }
    }

    const agent = createAgent({
      id: "agent",
      model: "m",
      tools: [bare],
      complete,
    })

    const events: AgentStreamEvent[] = []
    for await (const event of agent.stream("go")) events.push(event)

    const toolError = events.find((event) => event.type === "tool-error")
    expect(toolError).toMatchObject({
      type: "tool-error",
      error: expect.stringContaining("no implementation"),
    })
    expect(events.at(-1)).toMatchObject({ type: "done", content: "gave up" })
  })

  it("uses the OpenAI-compatible wire shape by default", async () => {
    let captured: {
      url: string
      init?: { headers?: Record<string, string>; body?: string }
    } = { url: "" }

    const fetchImpl: FetchLike = async (url, init) => {
      captured = { url, init }
      return {
        ok: true,
        status: 200,
        async text() {
          return ""
        },
        async json() {
          return {
            choices: [{ message: { content: "hi" } }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          }
        },
      }
    }

    const agent = createAgent({
      id: "wire",
      model: "test/model",
      tools: [weatherTool()],
      baseUrl: "https://example.test/v1/",
      apiKey: "secret",
      fetch: fetchImpl,
    })

    await expect(agent.run("yo")).resolves.toBe("hi")
    expect(captured.url).toBe("https://example.test/v1/chat/completions")
    expect(captured.init?.headers?.authorization).toBe("Bearer secret")

    const body = JSON.parse(captured.init?.body ?? "{}") as {
      model: string
      tools: Array<{ type: string; function: { name: string } }>
    }
    expect(body.model).toBe("test/model")
    expect(body.tools[0]).toMatchObject({
      type: "function",
      function: { name: "weather" },
    })
  })

  it("surfaces a non-2xx completion as AgentCompletionError", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 401,
      async text() {
        return "bad key"
      },
      async json() {
        return {}
      },
    })

    const agent = createAgent({
      id: "wire",
      model: "m",
      fetch: fetchImpl,
    })

    const error = await agent.run("yo").catch((err: unknown) => err)
    expect(error).toBeInstanceOf(AgentCompletionError)
    expect((error as AgentCompletionError).status).toBe(401)
    expect((error as Error).message).toContain("bad key")
  })

  it("stops an in-flight run", async () => {
    let started: () => void = () => {}
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })

    const complete: CompletionFn = (request) =>
      new Promise((_resolve, reject) => {
        started()
        request.signal.addEventListener("abort", () => {
          reject(new Error("aborted"))
        })
      })

    const agent = createAgent({
      id: "stoppable",
      model: "m",
      complete,
    })

    const running = agent.run("long task")
    await startedPromise
    agent.stop()

    await expect(running).rejects.toBeInstanceOf(AgentStoppedError)
  })

  it("fails closed at the step ceiling", async () => {
    const complete: CompletionFn = async () => ({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [toolCall("weather", { city: "Paris" })],
      },
    })

    const agent = createAgent({
      id: "loopy",
      model: "m",
      tools: [weatherTool()],
      maxSteps: 2,
      complete,
    })

    await expect(agent.run("go")).rejects.toBeInstanceOf(AgentStepLimitError)
  })

  it("rejects malformed tool arguments", async () => {
    let calls = 0
    const complete: CompletionFn = async () => {
      calls += 1
      if (calls === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            toolCalls: [
              { id: "c1", name: "weather", arguments: "{not json" },
            ],
          },
        }
      }
      return { message: { role: "assistant", content: "ok" } }
    }

    const agent = createAgent({
      id: "malformed",
      model: "m",
      tools: [weatherTool()],
      complete,
    })

    const events: AgentStreamEvent[] = []
    for await (const event of agent.stream("go")) events.push(event)

    expect(events.find((event) => event.type === "tool-error")).toMatchObject({
      error: expect.stringContaining("malformed JSON"),
    })
  })
})
