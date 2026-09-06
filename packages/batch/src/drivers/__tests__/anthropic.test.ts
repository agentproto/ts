import { describe, expect, it } from "vitest"
import { anthropicBatchDriver } from "../anthropic.js"
import type { BatchHandle, BatchRequest } from "../../types.js"
import { fakeFetch } from "./fake-fetch.js"

const REQUEST: BatchRequest = {
  customId: "r1",
  body: {
    model: "claude-sonnet-5",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  },
}

function handleFor(batchId: string, requestCount = 1): BatchHandle {
  return {
    id: "b_test",
    driver: "anthropic",
    provider: { batchIds: [batchId] },
    createdAt: "2026-09-01T00:00:00.000Z",
    requestCount,
    models: ["claude-sonnet-5"],
  }
}

describe("anthropicBatchDriver.submit", () => {
  it("wraps requests as { custom_id, params } and returns a handle", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: {
        id: "msgbatch_1",
        processing_status: "in_progress",
        request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      },
    }))
    const driver = anthropicBatchDriver({ apiKey: "sk-x", fetch })

    const handle = await driver.submit([REQUEST])

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages/batches")
    expect(calls[0]?.init?.headers).toMatchObject({ "x-api-key": "sk-x" })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      requests: [{ custom_id: "r1", params: REQUEST.body }],
    })
    expect(handle.driver).toBe("anthropic")
    expect(handle.provider.batchIds).toEqual(["msgbatch_1"])
    expect(handle.requestCount).toBe(1)
    expect(handle.models).toEqual(["claude-sonnet-5"])
  })

  it("rejects an invalid batch request before ever calling fetch", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: {} }))
    const driver = anthropicBatchDriver({ apiKey: "sk-x", fetch })
    const bad: BatchRequest = { customId: "bad", body: { ...REQUEST.body, stream: true } }

    await expect(driver.submit([bad])).rejects.toThrow(/invalid batch request "bad"/)
    expect(calls).toHaveLength(0)
  })
})

describe("anthropicBatchDriver.status", () => {
  it("maps processing_status and request_counts", async () => {
    const { fetch } = fakeFetch(() => ({
      body: {
        id: "msgbatch_1",
        processing_status: "ended",
        request_counts: { processing: 0, succeeded: 2, errored: 1, canceled: 0, expired: 1 },
      },
    }))
    const driver = anthropicBatchDriver({ apiKey: "sk-x", fetch })

    const status = await driver.status(handleFor("msgbatch_1", 4))

    expect(status.state).toBe("ended")
    expect(status.counts).toEqual({ processing: 0, succeeded: 2, errored: 1, canceled: 0, expired: 1 })
    expect(status.providerStatus).toBe("ended")
  })
})

describe("anthropicBatchDriver.results", () => {
  it("parses out-of-order JSONL lines, including errored and expired outcomes", async () => {
    const lines = [
      JSON.stringify({ custom_id: "r3", result: { type: "expired" } }),
      JSON.stringify({
        custom_id: "r1",
        result: {
          type: "succeeded",
          message: {
            content: [{ type: "text", text: "hi" }],
            model: "claude-sonnet-5",
            usage: { input_tokens: 3, output_tokens: 5 },
          },
        },
      }),
      JSON.stringify({
        custom_id: "r2",
        result: { type: "errored", error: { type: "invalid_request", message: "bad params" } },
      }),
    ]
    const { fetch } = fakeFetch(url => {
      if (url.endsWith("/results")) return { text: `${lines.join("\n")}\n` }
      return {
        body: {
          id: "msgbatch_1",
          processing_status: "ended",
          request_counts: { processing: 0, succeeded: 1, errored: 1, canceled: 0, expired: 1 },
          results_url: "https://api.anthropic.com/v1/messages/batches/msgbatch_1/results",
        },
      }
    })
    const driver = anthropicBatchDriver({ apiKey: "sk-x", fetch })

    const results = []
    for await (const result of driver.results(handleFor("msgbatch_1", 3))) results.push(result)

    expect(results.map(r => r.customId)).toEqual(["r3", "r1", "r2"])
    expect(results[0]?.outcome).toBe("expired")
    expect(results[1]?.outcome).toBe("succeeded")
    expect(results[1]?.message?.usage.input_tokens).toBe(3)
    expect(results[2]?.outcome).toBe("errored")
    expect(results[2]?.error).toEqual({ type: "invalid_request", message: "bad params" })
  })
})

describe("anthropicBatchDriver.cancel", () => {
  it("posts to the cancel endpoint for the provider batch id", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: {} }))
    const driver = anthropicBatchDriver({ apiKey: "sk-x", fetch })

    await driver.cancel(handleFor("msgbatch_1"))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(
      "https://api.anthropic.com/v1/messages/batches/msgbatch_1/cancel",
    )
    expect(calls[0]?.init?.method).toBe("POST")
  })
})
