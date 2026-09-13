import { describe, expect, it } from "vitest"
import { openrouterBatchDriver } from "../openrouter.js"
import { BatchUnsupportedError, type BatchRequest } from "../../types.js"
import { fakeFetch } from "./fake-fetch.js"

function req(customId: string, model: string): BatchRequest {
  return {
    customId,
    body: { model, max_tokens: 50, messages: [{ role: "user", content: customId }] },
  }
}

describe("openrouterBatchDriver.submit", () => {
  it("groups requests by model into one provider batch per model, in exact field order", async () => {
    const { fetch, calls } = fakeFetch(url => {
      const batchId = url.includes("beta/batches") ? "batch-created" : "unused"
      return { body: { id: batchId, status: "validating" } }
    })
    const driver = openrouterBatchDriver({ apiKey: "or-key", fetch })

    const requests = [req("a1", "model-a"), req("b1", "model-b"), req("a2", "model-a")]
    const handle = await driver.submit(requests)

    expect(calls).toHaveLength(2)
    const bodies = calls.map(c => String(c.init?.body))
    // field order matters (stream-parsed): endpoint, model, requests.
    for (const body of bodies) {
      expect(body.indexOf('"endpoint"')).toBeLessThan(body.indexOf('"model"'))
      expect(body.indexOf('"model"')).toBeLessThan(body.indexOf('"requests"'))
    }
    const parsedBodies = bodies.map(b => JSON.parse(b))
    expect(parsedBodies[0]).toMatchObject({ endpoint: "/v1/messages", model: "model-a" })
    expect(parsedBodies[0].requests).toEqual([
      { custom_id: "a1", body: requests[0]?.body },
      { custom_id: "a2", body: requests[2]?.body },
    ])
    expect(parsedBodies[1]).toMatchObject({ endpoint: "/v1/messages", model: "model-b" })
    expect(parsedBodies[1].requests).toEqual([{ custom_id: "b1", body: requests[1]?.body }])

    expect(handle.driver).toBe("openrouter")
    expect(handle.provider.batchIds).toEqual(["batch-created", "batch-created"])
    expect(handle.models).toEqual(["model-a", "model-b"])
    expect(handle.requestCount).toBe(3)
  })

  it("rejects duplicate custom_ids across the whole submit, before grouping", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { id: "x", status: "validating" } }))
    const driver = openrouterBatchDriver({ apiKey: "or-key", fetch })

    await expect(driver.submit([req("dup", "model-a"), req("dup", "model-b")])).rejects.toThrow(
      /duplicate customId "dup"/,
    )
    expect(calls).toHaveLength(0)
  })
})

describe("openrouterBatchDriver.status", () => {
  it("aggregates worst state and sums counts across provider batches", async () => {
    let call = 0
    const { fetch } = fakeFetch(url => {
      call += 1
      if (url.endsWith("/batches")) {
        // two submit calls, one per model group
        return { body: { id: call === 1 ? "batch-a" : "batch-b", status: "validating" } }
      }
      if (url.endsWith("/batch-a")) {
        return {
          body: {
            id: "batch-a",
            status: "completed",
            results: [
              { custom_id: "a1", response: { content: [], model: "model-a", usage: { input_tokens: 1, output_tokens: 1 } } },
              { custom_id: "a2", error: { type: "bad_request", message: "oops" } },
            ],
          },
        }
      }
      return { body: { id: "batch-b", status: "in_progress" } }
    })
    const driver = openrouterBatchDriver({ apiKey: "or-key", fetch })
    const handle = await driver.submit([req("a1", "model-a"), req("a2", "model-a"), req("b1", "model-b")])

    const status = await driver.status(handle)

    expect(status.state).toBe("in_progress")
    expect(status.counts).toEqual({ processing: 1, succeeded: 1, errored: 1, canceled: 0, expired: 0 })
  })
})

describe("openrouterBatchDriver.results", () => {
  it("maps inline results, and synthesizes outcomes for a group with no results", async () => {
    let call = 0
    const { fetch } = fakeFetch(url => {
      call += 1
      if (url.endsWith("/batches")) return { body: { id: call === 1 ? "batch-a" : "batch-b", status: "validating" } }
      if (url.endsWith("/batch-a")) {
        return {
          body: {
            id: "batch-a",
            status: "completed",
            results: [
              { custom_id: "a1", response: { content: [], model: "model-a", usage: { input_tokens: 1, output_tokens: 1 } } },
            ],
          },
        }
      }
      return { body: { id: "batch-b", status: "expired" } }
    })
    const driver = openrouterBatchDriver({ apiKey: "or-key", fetch })
    const handle = await driver.submit([req("a1", "model-a"), req("b1", "model-b")])

    const results = []
    for await (const result of driver.results(handle)) results.push(result)

    expect(results).toEqual([
      { customId: "a1", outcome: "succeeded", message: expect.objectContaining({ model: "model-a" }), error: undefined },
      { customId: "b1", outcome: "expired" },
    ])
  })
})

describe("openrouterBatchDriver.cancel", () => {
  it("throws BatchUnsupportedError — cancel is undocumented for openrouter batches", async () => {
    const { fetch } = fakeFetch(() => ({ body: {} }))
    const driver = openrouterBatchDriver({ apiKey: "or-key", fetch })

    await expect(
      driver.cancel({
        id: "b_x",
        driver: "openrouter",
        provider: { batchIds: ["batch-a"] },
        createdAt: "2026-09-01T00:00:00.000Z",
        requestCount: 1,
        models: ["model-a"],
      }),
    ).rejects.toThrow(BatchUnsupportedError)
  })
})
