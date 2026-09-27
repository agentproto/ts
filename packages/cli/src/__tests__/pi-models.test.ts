/**
 * `syncPiModels` — regenerates `~/.pi/agent/models.json` provider entries
 * from configured named endpoints + their connectors, tracking ownership in
 * a side ledger so a hand-added provider/model is never touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetConfiguredEndpointsCache } from "@agentproto/llm-endpoint"
import { resolvePiLedgerFilePath, resolvePiModelsFilePath, syncPiModels } from "../lib/pi-models.js"

let dir: string
const SAVED = {
  endpoints: process.env.LLM_ENDPOINT_ENDPOINTS_FILE,
  models: process.env.AGENTPROTO_PI_MODELS_FILE,
  ledger: process.env.AGENTPROTO_PI_LEDGER_FILE,
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-models-test-"))
  process.env.LLM_ENDPOINT_ENDPOINTS_FILE = join(dir, "llm-endpoints.json")
  process.env.AGENTPROTO_PI_MODELS_FILE = join(dir, "models.json")
  process.env.AGENTPROTO_PI_LEDGER_FILE = join(dir, "ledger.json")
  resetConfiguredEndpointsCache()
})

afterEach(async () => {
  for (const [k, v] of Object.entries(SAVED)) {
    const envKey = k === "endpoints" ? "LLM_ENDPOINT_ENDPOINTS_FILE" : k === "models" ? "AGENTPROTO_PI_MODELS_FILE" : "AGENTPROTO_PI_LEDGER_FILE"
    if (v === undefined) delete process.env[envKey]
    else process.env[envKey] = v
  }
  resetConfiguredEndpointsCache()
  await rm(dir, { recursive: true, force: true })
})

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (!(url in routes)) throw new Error(`connect ECONNREFUSED ${url}`)
    return { ok: true, json: async () => routes[url] } as Response
  }) as typeof fetch
}

async function writeEndpoints(entries: unknown[]) {
  await writeFile(process.env.LLM_ENDPOINT_ENDPOINTS_FILE!, JSON.stringify({ endpoints: entries }))
}

describe("syncPiModels", () => {
  it("creates a new provider entry from a loaded lmstudio model", async () => {
    await writeEndpoints([{ id: "lmstudio", kind: "openai", baseUrl: "http://127.0.0.1:1234/v1", connector: "lmstudio" }])
    const fetchImpl = fakeFetch({
      "http://127.0.0.1:1234/api/v0/models": {
        data: [{ id: "bonsai-27b-win", state: "loaded", loaded_context_length: 62976, max_context_length: 262144 }],
      },
    })
    const result = await syncPiModels({ fetchImpl })
    expect(result.entries).toEqual([
      { providerId: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", action: "added", modelIds: ["bonsai-27b-win"] },
    ])
    const written = JSON.parse(await readFile(resolvePiModelsFilePath(), "utf-8"))
    expect(written.providers.lmstudio.models).toEqual([
      expect.objectContaining({ id: "bonsai-27b-win", contextWindow: 62976 }),
    ])
    const ledger = JSON.parse(await readFile(resolvePiLedgerFilePath(), "utf-8"))
    expect(ledger.managed.lmstudio).toEqual(["bonsai-27b-win"])
  })

  it("skips a not-loaded model — contextWindow must be the loaded ctx, never max", async () => {
    await writeEndpoints([{ id: "lmstudio", kind: "openai", baseUrl: "http://127.0.0.1:1234/v1", connector: "lmstudio" }])
    const fetchImpl = fakeFetch({
      "http://127.0.0.1:1234/api/v0/models": { data: [{ id: "unloaded-model", state: "not-loaded", max_context_length: 32768 }] },
    })
    const result = await syncPiModels({ fetchImpl })
    expect(result.entries).toEqual([
      { providerId: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", action: "skipped-no-loaded-models", modelIds: [] },
    ])
  })

  it("never touches a provider with no configured endpoint (hand-added by the user)", async () => {
    await writeFile(
      resolvePiModelsFilePath(),
      JSON.stringify({
        providers: { "my-own-provider": { baseUrl: "http://elsewhere", api: "openai-completions", apiKey: "x", models: [] } },
      }),
    )
    await writeEndpoints([])
    await syncPiModels({ fetchImpl: fakeFetch({}) })
    const written = JSON.parse(await readFile(resolvePiModelsFilePath(), "utf-8"))
    expect(written.providers["my-own-provider"]).toEqual({
      baseUrl: "http://elsewhere",
      api: "openai-completions",
      apiKey: "x",
      models: [],
    })
  })

  it("preserves a hand-added model within a provider it also manages, and drops a stale managed one", async () => {
    await writeEndpoints([{ id: "lmstudio", kind: "openai", baseUrl: "http://127.0.0.1:1234/v1", connector: "lmstudio" }])
    // First run: manages "old-model".
    await syncPiModels({
      fetchImpl: fakeFetch({
        "http://127.0.0.1:1234/api/v0/models": { data: [{ id: "old-model", state: "loaded", loaded_context_length: 4096 }] },
      }),
    })
    // User hand-adds their own model into the same provider.
    const models = JSON.parse(await readFile(resolvePiModelsFilePath(), "utf-8"))
    models.providers.lmstudio.models.push({
      id: "my-hand-added-model",
      name: "Mine",
      reasoning: false,
      input: ["text"],
      contextWindow: 1000,
      maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
    await writeFile(resolvePiModelsFilePath(), JSON.stringify(models))

    // Second run: "old-model" is no longer loaded, "new-model" is.
    const result = await syncPiModels({
      fetchImpl: fakeFetch({
        "http://127.0.0.1:1234/api/v0/models": { data: [{ id: "new-model", state: "loaded", loaded_context_length: 8192 }] },
      }),
    })
    expect(result.entries[0]).toMatchObject({ action: "updated", modelIds: ["new-model"] })
    const written = JSON.parse(await readFile(resolvePiModelsFilePath(), "utf-8"))
    const ids = written.providers.lmstudio.models.map((m: { id: string }) => m.id).sort()
    expect(ids).toEqual(["my-hand-added-model", "new-model"])
  })

  it("dry-run reports without writing either file", async () => {
    await writeEndpoints([{ id: "lmstudio", kind: "openai", baseUrl: "http://127.0.0.1:1234/v1", connector: "lmstudio" }])
    const fetchImpl = fakeFetch({
      "http://127.0.0.1:1234/api/v0/models": { data: [{ id: "bonsai-27b-win", state: "loaded", loaded_context_length: 62976 }] },
    })
    const result = await syncPiModels({ dryRun: true, fetchImpl })
    expect(result.entries[0]).toMatchObject({ action: "added" })
    await expect(readFile(resolvePiModelsFilePath(), "utf-8")).rejects.toThrow()
    await expect(readFile(resolvePiLedgerFilePath(), "utf-8")).rejects.toThrow()
  })

  it("syncs a loaded ollama model with the conservative context fallback (ollama never reports loadedCtx)", async () => {
    await writeEndpoints([{ id: "ollama", kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", connector: "ollama" }])
    const fetchImpl = fakeFetch({
      "http://127.0.0.1:11434/api/tags": { models: [{ name: "llama3" }] },
      "http://127.0.0.1:11434/api/ps": { models: [{ name: "llama3" }] },
    })
    const result = await syncPiModels({ fetchImpl })
    expect(result.entries).toEqual([
      { providerId: "ollama", baseUrl: "http://127.0.0.1:11434/v1", action: "added", modelIds: ["llama3"] },
    ])
    const written = JSON.parse(await readFile(resolvePiModelsFilePath(), "utf-8"))
    expect(written.providers.ollama.models).toEqual([expect.objectContaining({ id: "llama3", contextWindow: 4096 })])
  })

  it("a keyless endpoint gets a placeholder apiKey, never a fabricated secret", async () => {
    await writeEndpoints([{ id: "lmstudio", kind: "openai", baseUrl: "http://127.0.0.1:1234/v1", connector: "lmstudio" }])
    const fetchImpl = fakeFetch({
      "http://127.0.0.1:1234/api/v0/models": { data: [{ id: "m", state: "loaded", loaded_context_length: 4096 }] },
    })
    await syncPiModels({ fetchImpl })
    const written = JSON.parse(await readFile(resolvePiModelsFilePath(), "utf-8"))
    expect(written.providers.lmstudio.apiKey).toBe("not-needed")
  })
})
