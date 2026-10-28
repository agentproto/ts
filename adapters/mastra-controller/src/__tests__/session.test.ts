import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Agent } from "@mastra/core/agent"
import type { AgentController } from "@mastra/core/agent-controller"
import { InMemoryStore } from "@mastra/core/storage"
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock"
import type { AgentCliClient, StreamEvent } from "@agentproto/harness"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  MANIFEST_ENV_KEY,
  MODE_ENV_KEY,
  UnresolvedReferenceError,
  createAgentCliClient,
  createAgentControllerHost,
  mastraController,
  parseControllerManifest,
  type ControllerResolver,
} from "../index.js"

const FIXTURE = join(__dirname, "fixtures", "research-assistant.md")
const manifest = parseControllerManifest(readFileSync(FIXTURE, "utf8"))

/** A model that streams `text` in two chunks, then finishes. */
function textModel(text: string) {
  const mid = Math.ceil(text.length / 2)
  return new MastraLanguageModelV2Mock({
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] })
          c.enqueue({ type: "text-start", id: "t1" })
          c.enqueue({ type: "text-delta", id: "t1", delta: text.slice(0, mid) })
          c.enqueue({ type: "text-delta", id: "t1", delta: text.slice(mid) })
          c.enqueue({ type: "text-end", id: "t1" })
          c.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
          })
          c.close()
        },
      }),
    }),
  })
}

/** A model that streams one chunk, then hangs until the run is aborted. */
function hangingModel(onStarted: () => void) {
  return new MastraLanguageModelV2Mock({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] })
          c.enqueue({ type: "text-start", id: "t1" })
          c.enqueue({ type: "text-delta", id: "t1", delta: "thinking" })
          onStarted()
          abortSignal?.addEventListener("abort", () => c.error(abortSignal.reason))
        },
      }),
    }),
  })
}

/** Resolvers for every `$resolver` the research-assistant fixture names, all backed by `model`. */
function fixtureResolvers(
  model: MastraLanguageModelV2Mock,
  extra: Record<string, ControllerResolver> = {},
): Record<string, ControllerResolver> {
  return {
    "@guilde/harness/storage/postgres": () => new InMemoryStore(),
    "@guilde/harness/model/resolver": () => () => model,
    "@guilde/harness/memory/shared": () => undefined,
    "@guilde/harness/model/for-mode": ref =>
      (ref.input as { default: string }).default,
    "@guilde/harness/agent/operator": () =>
      new Agent({ id: "operator", name: "operator", instructions: "You research.", model }),
    ...extra,
  }
}

async function drain(client: AgentCliClient): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const evt of client.events()) out.push(evt)
  return out
}

const clients: AgentCliClient[] = []
function newClient(resolvers: Record<string, ControllerResolver>): AgentCliClient {
  const client = createAgentCliClient(mastraController, {
    host: createAgentControllerHost({ resolvers }),
  })
  clients.push(client)
  return client
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close()
})

describe("mastra-controller session (research-assistant fixture, stub model)", () => {
  it("starts in plan, streams text deltas then turn-end as AIP-45 events in order", async () => {
    const client = newClient(fixtureResolvers(textModel("Here is the plan.")))
    await client.connect({
      cwd: __dirname,
      env: { [MANIFEST_ENV_KEY]: FIXTURE },
      abortSignal: new AbortController().signal,
    })

    expect(client.currentModeId).toBe("plan")
    expect(client.availableModes).toEqual([
      expect.objectContaining({ id: "plan", name: "Plan" }),
      expect.objectContaining({ id: "execute", name: "Execute" }),
    ])
    expect(client.sessionId).toMatch(/^agentproto-mastra-controller-.+:.+$/)

    await client.send("turn-1", "Research the history of tea.")
    const events = await drain(client)
    const kinds = events.map(e => e.kind)

    const text = events
      .filter((e): e is Extract<StreamEvent, { kind: "text-delta" }> => e.kind === "text-delta")
      .map(e => e.text)
      .join("")
    expect(text).toBe("Here is the plan.")
    expect(kinds.at(-1)).toBe("turn-end")
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "completed" })
    expect(kinds.indexOf("text-delta")).toBeLessThan(kinds.indexOf("turn-end"))
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "usage_update", tokensIn: 7, tokensOut: 3 }),
    )
    for (const e of events) {
      expect((e as { sessionId?: string }).sessionId).toBe(client.sessionId)
    }
  })

  it("selects the execute mode at spawn", async () => {
    const client = newClient(fixtureResolvers(textModel("ok")))
    await client.connect({
      cwd: __dirname,
      env: { [MANIFEST_ENV_KEY]: FIXTURE, [MODE_ENV_KEY]: "execute" },
      abortSignal: new AbortController().signal,
    })
    expect(client.currentModeId).toBe("execute")
  })

  it("connect({ mode }) wins over the env option and an unknown mode is refused", async () => {
    const client = newClient(fixtureResolvers(textModel("ok")))
    await client.connect({
      cwd: __dirname,
      env: { [MANIFEST_ENV_KEY]: FIXTURE, [MODE_ENV_KEY]: "plan" },
      abortSignal: new AbortController().signal,
      mode: "execute",
    })
    expect(client.currentModeId).toBe("execute")

    const bad = newClient(fixtureResolvers(textModel("ok")))
    await expect(
      bad.connect({
        cwd: __dirname,
        env: { [MANIFEST_ENV_KEY]: FIXTURE, [MODE_ENV_KEY]: "review" },
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow(/mode 'review' is not declared.*Known modes: plan, execute/)
  })

  it("setSessionMode switches the controller mode without a notice; unknown ids are refused", async () => {
    const client = newClient(fixtureResolvers(textModel("ok")))
    await client.connect({
      cwd: __dirname,
      env: { [MANIFEST_ENV_KEY]: FIXTURE },
      abortSignal: new AbortController().signal,
    })
    const notices: StreamEvent[] = []
    client.onOutOfTurnEvent!(e => notices.push(e))

    await expect(client.setSessionMode!("execute")).resolves.toEqual({ applied: true })
    expect(client.currentModeId).toBe("execute")
    expect(notices).toEqual([])
    await expect(client.setSessionMode!("review")).resolves.toMatchObject({ applied: false })
  })

  it("a mode switch the controller makes by itself surfaces as a thought notice", async () => {
    const host = createAgentControllerHost({ resolvers: fixtureResolvers(textModel("ok")) })
    let controller: AgentController | undefined
    const createController = host.createController.bind(host)
    host.createController = async (m, ctx) => (controller = await createController(m, ctx))
    const client = createAgentCliClient(mastraController, { host })
    clients.push(client)
    await client.connect({
      cwd: __dirname,
      env: { [MANIFEST_ENV_KEY]: FIXTURE },
      abortSignal: new AbortController().signal,
    })
    const notices: StreamEvent[] = []
    client.onOutOfTurnEvent!(e => notices.push(e))

    // What plan approval does in PR 3: the session flips to `transitionsTo`.
    const resourceId = client.sessionId!.slice(0, client.sessionId!.lastIndexOf(":"))
    const session = await controller!.getSessionByResource(resourceId)
    await session!.mode.switch({ modeId: "execute" })

    expect(client.currentModeId).toBe("execute")
    expect(notices).toEqual([
      {
        kind: "thought",
        sessionId: client.sessionId,
        text: "[mastra-controller] mode switched by the controller: plan -> execute",
      },
    ])
  })

  it("cancel during a turn ends it with turn-end cancelled", async () => {
    let started!: () => void
    const running = new Promise<void>(r => (started = r))
    const client = newClient(fixtureResolvers(hangingModel(() => started())))
    await client.connect({
      cwd: __dirname,
      env: { [MANIFEST_ENV_KEY]: FIXTURE },
      abortSignal: new AbortController().signal,
    })

    await client.send("turn-1", "go")
    const collected = drain(client)
    await running
    await client.cancel("turn-1")
    const events = await collected
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", reason: "cancelled" })
  })
})

describe("createAgentControllerHost resolvers", () => {
  it("calls a registered resolver with the ref and its path; the result reaches the config", async () => {
    const store = new InMemoryStore()
    const storage = vi.fn<ControllerResolver>(() => store)
    const model = textModel("ok")
    const host = createAgentControllerHost({
      resolvers: fixtureResolvers(model, { "@guilde/harness/storage/postgres": storage }),
    })
    const config = await host.buildConfig(manifest, { cwd: "/work" })

    expect(storage).toHaveBeenCalledTimes(1)
    const [ref, ctx] = storage.mock.calls[0]!
    expect(ref).toEqual({
      $resolver: "@guilde/harness/storage/postgres",
      input: { connectionStringEnv: "DATABASE_URL", storeId: "guilde-harness" },
    })
    expect(ctx).toMatchObject({ path: "storage", cwd: "/work" })
    expect(config.storage).toBe(store)
    // A per-mode model resolver's id becomes that mode's defaultModelId.
    expect(config.modes.map(m => [m.id, m.defaultModelId, m.transitionsTo])).toEqual([
      ["plan", "claude-sonnet-4-6", "execute"],
      ["execute", "claude-sonnet-4-6", undefined],
    ])
    expect(config.modes[0]!.agent).toBeInstanceOf(Agent)
  })

  it("an unregistered $resolver fails with the field path", async () => {
    const resolvers = fixtureResolvers(textModel("ok"))
    delete resolvers["@guilde/harness/model/for-mode"]
    const host = createAgentControllerHost({ resolvers })

    const err = await host.buildConfig(manifest).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UnresolvedReferenceError)
    expect(err).toMatchObject({ path: "modes.0.model", resolver: "@guilde/harness/model/for-mode" })
    expect((err as Error).message).toMatch(
      /modes\.0\.model references \$resolver '@guilde\/harness\/model\/for-mode'/,
    )
  })

  it("defaults: in-memory storage and an inline backing agent when nothing is resolved", async () => {
    const host = createAgentControllerHost()
    const config = await host.buildConfig(
      parseControllerManifest({
        id: "bare",
        name: "Bare",
        version: "1.0.0",
        modes: [{ id: "only", default: true, defaultModelId: "openai/gpt-5" }],
      }),
    )
    expect(config.storage).toBeInstanceOf(InMemoryStore)
    expect(config.agent).toBeInstanceOf(Agent)
    expect(config.memory).toBeUndefined()
  })
})
