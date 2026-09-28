import { describe, expect, it } from "vitest"
import type { ConnectorModel, EndpointConfig } from "@agentproto/llm-endpoint"
import {
  fitCheckForTarget,
  resolveInferenceTarget,
  type DeviceProbeResult,
  type InferenceBindingOk,
} from "../inference-binding.js"

const LMSTUDIO_ENDPOINT: EndpointConfig = {
  id: "lmstudio",
  kind: "openai",
  baseUrl: "http://127.0.0.1:1234/v1",
  connector: "lmstudio",
}

const OLLAMA_ENDPOINT: EndpointConfig = {
  id: "ollama",
  kind: "openai",
  baseUrl: "http://127.0.0.1:11434/v1",
  connector: "ollama",
}

function fakeDeps(endpoints: EndpointConfig[], models: Record<string, ConnectorModel[]>) {
  return {
    getConfiguredEndpoints: () => endpoints,
    listModels: async (endpoint: EndpointConfig) => models[endpoint.id] ?? [],
  }
}

describe("resolveInferenceTarget — endpoint resolution", () => {
  it("resolves {endpoint, model} against a configured local endpoint", async () => {
    const deps = fakeDeps([LMSTUDIO_ENDPOINT], {
      lmstudio: [{ id: "bonsai-27b-win", state: "loaded", loadedCtx: 32_768, maxCtx: 262_144 }],
    })
    const result = await resolveInferenceTarget({ endpoint: "lmstudio", model: "bonsai-27b-win" }, deps)
    expect(result.ok).toBe(true)
    const ok = result as InferenceBindingOk
    expect(ok.gatewayModelId).toBe("lmstudio/bonsai-27b-win")
    expect(ok.target).toMatchObject({ kind: "local", endpointId: "lmstudio", modelId: "bonsai-27b-win", loadedCtx: 32_768 })
  })

  it("picks the sole loaded model when {endpoint} is given with no model", async () => {
    const deps = fakeDeps([LMSTUDIO_ENDPOINT], {
      lmstudio: [
        { id: "bonsai-27b-win", state: "loaded", loadedCtx: 32_768 },
        { id: "unrelated", state: "not-loaded" },
      ],
    })
    const result = await resolveInferenceTarget({ endpoint: "lmstudio" }, deps)
    expect(result.ok).toBe(true)
    expect((result as InferenceBindingOk).gatewayModelId).toBe("lmstudio/bonsai-27b-win")
  })

  it("errors when {endpoint} is given with no model and nothing is loaded", async () => {
    const deps = fakeDeps([LMSTUDIO_ENDPOINT], { lmstudio: [] })
    const result = await resolveInferenceTarget({ endpoint: "lmstudio" }, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("no model is currently loaded")
  })

  it("errors when {endpoint} is given with no model and multiple models are loaded", async () => {
    const deps = fakeDeps([LMSTUDIO_ENDPOINT], {
      lmstudio: [
        { id: "a", state: "loaded" },
        { id: "b", state: "loaded" },
      ],
    })
    const result = await resolveInferenceTarget({ endpoint: "lmstudio" }, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("pass `inference.model`")
  })

  it("errors when inference.endpoint names an unconfigured endpoint id", async () => {
    const deps = fakeDeps([LMSTUDIO_ENDPOINT], {})
    const result = await resolveInferenceTarget({ endpoint: "nope", model: "x" }, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("not a configured endpoint")
  })

  it("reports an unknown loaded ctx for a connector that never exposes one (e.g. Ollama)", async () => {
    const deps = fakeDeps([OLLAMA_ENDPOINT], { ollama: [{ id: "llama3", state: "loaded" }] })
    const result = await resolveInferenceTarget({ endpoint: "ollama", model: "llama3" }, deps)
    expect(result.ok).toBe(true)
    expect((result as InferenceBindingOk).target.loadedCtx).toBeUndefined()
  })
})

describe("resolveInferenceTarget — model-only shorthand \"<model>@<ref>\"", () => {
  it("resolves against a local endpoint id when the ref matches one", async () => {
    const deps = fakeDeps([LMSTUDIO_ENDPOINT], {
      lmstudio: [{ id: "bonsai-27b-mac", state: "loaded", loadedCtx: 86_016 }],
    })
    const result = await resolveInferenceTarget({ model: "bonsai-27b-mac@lmstudio" }, deps)
    expect(result.ok).toBe(true)
    const ok = result as InferenceBindingOk
    expect(ok.target).toMatchObject({ kind: "local", endpointId: "lmstudio", modelId: "bonsai-27b-mac" })
    expect(ok.gatewayModelId).toBe("lmstudio/bonsai-27b-mac")
  })

  it("falls back to a device probe when the ref does not match a local endpoint id", async () => {
    const probeDevice = async (device: string, modelId: string): Promise<DeviceProbeResult> => {
      expect(device).toBe("work-mac")
      expect(modelId).toBe("llama3")
      return { reachable: true, endpointId: "ollama", modelIds: ["llama3"] }
    }
    const result = await resolveInferenceTarget(
      { model: "llama3@work-mac" },
      { getConfiguredEndpoints: () => [], probeDevice },
    )
    expect(result.ok).toBe(true)
    const ok = result as InferenceBindingOk
    expect(ok.target).toMatchObject({ kind: "device", remoteEndpointId: "ollama", device: "work-mac", modelId: "llama3", loadedCtx: undefined })
    expect(ok.gatewayModelId).toBe("ollama@work-mac/llama3")
    expect(ok.label).toBe("ollama@work-mac")
  })

  it("errors with no \"@\" suffix and no explicit endpoint", async () => {
    const result = await resolveInferenceTarget({ model: "bare-model-id" }, { getConfiguredEndpoints: () => [] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("@<device|endpoint>")
  })

  it("errors when neither endpoint nor model is given", async () => {
    const result = await resolveInferenceTarget({}, { getConfiguredEndpoints: () => [] })
    expect(result.ok).toBe(false)
  })
})

describe("resolveInferenceTarget — device-endpoint offline", () => {
  it("errors distinctly when the paired device is unreachable", async () => {
    const probeDevice = async (): Promise<DeviceProbeResult> => ({ reachable: false, message: "pairing tunnel not connected" })
    const result = await resolveInferenceTarget(
      { endpoint: "ollama@work-mac", model: "llama3" },
      { getConfiguredEndpoints: () => [], probeDevice },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("offline or unreachable")
      expect(result.message).toContain("pairing tunnel not connected")
    }
  })

  it("errors when the device is online but the model isn't loaded there", async () => {
    const probeDevice = async (): Promise<DeviceProbeResult> => ({ reachable: true, endpointId: "ollama", modelIds: ["other-model"] })
    const result = await resolveInferenceTarget(
      { endpoint: "ollama@work-mac", model: "llama3" },
      { getConfiguredEndpoints: () => [], probeDevice },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("no loaded model")
  })

  it("errors when a device-qualified endpoint is given with no model", async () => {
    const result = await resolveInferenceTarget({ endpoint: "ollama@work-mac" }, { getConfiguredEndpoints: () => [] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("inference.model is required")
  })

  it("errors distinctly when no device probe is wired at all", async () => {
    const result = await resolveInferenceTarget(
      { endpoint: "ollama@work-mac", model: "llama3" },
      { getConfiguredEndpoints: () => [] },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("device probe")
  })
})

describe("fitCheckForTarget", () => {
  it("fits/no-fit/unknown propagate through from checkHarnessFit", () => {
    const localFits = fitCheckForTarget(
      "pi",
      { kind: "local", endpointId: "lmstudio", modelId: "m", loadedCtx: 32_768, connector: "lmstudio", baseUrl: "http://x" },
      "lmstudio",
    )
    expect(localFits.verdict).toBe("fits")

    const localNoFit = fitCheckForTarget(
      "claude-code",
      { kind: "local", endpointId: "lmstudio", modelId: "m", loadedCtx: 32_768, connector: "lmstudio", baseUrl: "http://x" },
      "lmstudio",
    )
    expect(localNoFit.verdict).toBe("no-fit")

    const deviceUnknown = fitCheckForTarget(
      "claude-code",
      { kind: "device", remoteEndpointId: "ollama", device: "work-mac", modelId: "m", loadedCtx: undefined },
      "ollama@work-mac",
    )
    expect(deviceUnknown.verdict).toBe("unknown")
  })
})
