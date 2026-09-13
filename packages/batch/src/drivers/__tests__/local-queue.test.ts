import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BatchStore } from "../../store.js"
import type { AnthropicMessage, BatchHandle, BatchRequest, MessagesBody } from "../../types.js"
import { RetryableCompletionError, localQueueDriver } from "../local-queue.js"

function req(customId: string, model = "model-x"): BatchRequest {
  return {
    customId,
    body: { model, max_tokens: 10, messages: [{ role: "user", content: customId }] },
  }
}

function fakeMessage(model: string): AnthropicMessage {
  return { content: [], model, usage: { input_tokens: 1, output_tokens: 1 } }
}

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iter) out.push(item)
  return out
}

describe("localQueueDriver", () => {
  let dir: string
  let store: BatchStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "batch-local-queue-"))
    store = new BatchStore({ stateDir: dir })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("respects the concurrency bound", async () => {
    let active = 0
    let maxActive = 0
    const complete = vi.fn(async (body: MessagesBody): Promise<AnthropicMessage> => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      active -= 1
      return fakeMessage(body.model)
    })
    const driver = localQueueDriver({ complete, concurrency: 2, store })
    const requests = Array.from({ length: 6 }, (_, i) => req(`c${i}`))

    await driver.submit(requests)

    expect(maxActive).toBeLessThanOrEqual(2)
    expect(complete).toHaveBeenCalledTimes(6)
  })

  it("retries a RetryableCompletionError with backoff before succeeding", async () => {
    let attempts = 0
    const complete = vi.fn(async (body: MessagesBody): Promise<AnthropicMessage> => {
      attempts += 1
      if (attempts < 3) throw new RetryableCompletionError("rate limited", 429)
      return fakeMessage(body.model)
    })
    const driver = localQueueDriver({
      complete,
      concurrency: 1,
      store,
      retry: { max: 5, backoffMs: 1 },
    })

    const handle = await driver.submit([req("r1")])

    expect(attempts).toBe(3)
    const results = await drain(driver.results(handle))
    expect(results).toEqual([
      { customId: "r1", outcome: "succeeded", message: fakeMessage("model-x") },
    ])
  })

  it("gives up after the retry budget and records a permanent error", async () => {
    const complete = vi.fn(async (): Promise<AnthropicMessage> => {
      throw new RetryableCompletionError("still limited", 429)
    })
    const driver = localQueueDriver({
      complete,
      concurrency: 1,
      store,
      retry: { max: 2, backoffMs: 1 },
    })

    const handle = await driver.submit([req("r1")])

    expect(complete).toHaveBeenCalledTimes(3) // initial attempt + 2 retries
    const results = await drain(driver.results(handle))
    expect(results[0]?.outcome).toBe("errored")
    expect(results[0]?.error?.type).toBe("RetryableCompletionError")
  })

  it("resumes only the items missing a result after a simulated crash", async () => {
    const requests = [req("r1"), req("r2"), req("r3")]
    const handle: BatchHandle = {
      id: "b_crash",
      driver: "local-queue",
      provider: { batchIds: [] },
      createdAt: "2026-09-01T00:00:00.000Z",
      requestCount: 3,
      models: ["model-x"],
    }
    // Simulate a prior process that submitted, finished one item, then died
    // before the run loop completed.
    await store.create(handle, requests)
    await store.appendResults(handle.id, [{ customId: "r1", outcome: "succeeded" }])

    const complete = vi.fn(async (body: MessagesBody): Promise<AnthropicMessage> =>
      fakeMessage(body.model),
    )
    const driver = localQueueDriver({ complete, concurrency: 2, store })

    await driver.resume(handle)

    expect(complete).toHaveBeenCalledTimes(2)
    const record = await store.load(handle.id)
    expect(record?.results.map(r => r.customId).sort()).toEqual(["r1", "r2", "r3"])
  })
})
