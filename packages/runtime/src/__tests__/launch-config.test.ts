import { describe, it, expect } from "vitest"
import { buildRouteAwareLaunchConfig } from "../launch-config.js"
import type { ResolvedAuthSpec } from "../spawn-defaults.js"

describe("buildRouteAwareLaunchConfig", () => {
  const baseAuthSpec = (baseUrl: string): ResolvedAuthSpec =>
    ({
      mode: "api-key",
      setEnv: "ANTHROPIC_AUTH_TOKEN",
      unsetEnv: [],
      explicit: true,
      enforce: "when-configured",
      baseUrl,
    }) as ResolvedAuthSpec

  it("injects base_url for an adapter that declares the option", () => {
    const result = buildRouteAwareLaunchConfig({
      adapter: "claude-code",
      route: { gateway: "moonshot" },
      authSpec: baseAuthSpec("https://api.moonshot.ai/v1"),
      declaredOptions: [{ id: "base_url", type: "string" }],
      routeSelection: "free",
      adapterProvider: "anthropic",
    })
    expect(result.options?.base_url).toBe("https://api.moonshot.ai/v1")
  })

  it("skips base_url for a derived-from-model adapter that does not declare it (hermes)", () => {
    const result = buildRouteAwareLaunchConfig({
      adapter: "hermes",
      route: { gateway: "moonshot" },
      authSpec: baseAuthSpec("https://api.moonshot.ai/v1"),
      declaredOptions: [
        { id: "skills", type: "string" },
        { id: "model", type: "string" },
        { id: "effort", type: "enum" },
      ],
      routeSelection: "derived-from-model",
      adapterProvider: "openrouter",
    })
    expect(result.options?.base_url).toBeUndefined()
    expect("base_url" in (result.options ?? {})).toBe(false)
  })

  it("fails loud for a free-route adapter that cannot accept base_url and cannot derive route", () => {
    expect(() =>
      buildRouteAwareLaunchConfig({
        adapter: "hypothetical",
        route: { gateway: "moonshot" },
        authSpec: baseAuthSpec("https://api.moonshot.ai/v1"),
        declaredOptions: [{ id: "model", type: "string" }],
        routeSelection: "free",
        adapterProvider: "anthropic",
      }),
    ).toThrow(/cannot be routed through gateway/)
  })

  it("codex + native openai gateway preset skips base_url injection", () => {
    // resolveAuthSpec drops the base_url for a native fixed-provider gateway
    // preset, so authSpec.baseUrl is undefined here.
    const result = buildRouteAwareLaunchConfig({
      adapter: "codex",
      model: "openai/gpt-5-codex",
      route: { gateway: "openai" },
      authSpec: {
        mode: "api-key",
        setEnv: "OPENAI_API_KEY",
        unsetEnv: [],
        explicit: true,
        enforce: "when-configured",
      } as ResolvedAuthSpec,
      declaredOptions: [{ id: "model", type: "enum" }],
      adapterProvider: "openai",
    })
    expect(result.options?.base_url).toBeUndefined()
    expect("base_url" in (result.options ?? {})).toBe(false)
    expect(result.wireModel).toBe("gpt-5-codex")
  })

  it("codex + non-native gateway preset rejects", () => {
    expect(() =>
      buildRouteAwareLaunchConfig({
        adapter: "codex",
        model: "gpt-5-codex",
        route: { gateway: "openai-direct" },
        authSpec: baseAuthSpec("https://api.openai.com/v1"),
        declaredOptions: [{ id: "model", type: "enum" }],
        adapterProvider: "openai",
      }),
    ).toThrow(/cannot be routed through gateway/)
  })

  it("codex + custom route base_url rejects", () => {
    expect(() =>
      buildRouteAwareLaunchConfig({
        adapter: "codex",
        model: "gpt-5-codex",
        route: { gateway: "custom-openai", baseUrl: "https://api.openai.com/v1" },
        declaredOptions: [{ id: "model", type: "enum" }],
        adapterProvider: "openai",
      }),
    ).toThrow(/cannot be routed through gateway/)
  })

  it("skips a custom route base_url for a derived-from-model adapter that does not declare base_url", () => {
    const result = buildRouteAwareLaunchConfig({
      adapter: "hermes",
      route: { gateway: "custom", baseUrl: "https://custom.example.com/v1" },
      declaredOptions: [
        { id: "skills", type: "string" },
        { id: "model", type: "string" },
        { id: "effort", type: "enum" },
      ],
      routeSelection: "derived-from-model",
      adapterProvider: "openrouter",
    })
    // Derived-from-model adapters derive their endpoint from the model prefix;
    // an undeclared base_url option would crash manifest validation, so the
    // custom route base_url is dropped rather than injected.
    expect(result.options?.base_url).toBeUndefined()
    expect("base_url" in (result.options ?? {})).toBe(false)
  })

  it("strips the native vendor prefix from the wire model for fixed-provider adapters", () => {
    const result = buildRouteAwareLaunchConfig({
      adapter: "claude-code",
      model: "anthropic/claude-sonnet-4-5",
      routeSelection: "free",
      adapterProvider: "anthropic",
    })
    expect(result.wireModel).toBe("claude-sonnet-4-5")
  })

  it("keeps the vendor prefix for derived-from-model adapters", () => {
    const result = buildRouteAwareLaunchConfig({
      adapter: "hermes",
      model: "openai/gpt-4",
      routeSelection: "derived-from-model",
      adapterProvider: "openrouter",
    })
    expect(result.wireModel).toBe("openai/gpt-4")
  })

  it("strips catalog @route suffixes from the wire model", () => {
    const result = buildRouteAwareLaunchConfig({
      adapter: "hermes",
      model: "z-ai/glm-5.2@openrouter",
      routeSelection: "derived-from-model",
      adapterProvider: "openrouter",
    })
    expect(result.wireModel).toBe("z-ai/glm-5.2")
  })
})
