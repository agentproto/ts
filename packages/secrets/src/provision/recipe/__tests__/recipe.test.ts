import { describe, it, expect } from "vitest"
import {
  defineProvisionRecipe,
  parseRecipeManifest,
  getRecipe,
  registerRecipe,
  listRecipeIds,
  resolveRecipeMethod,
  resolveSourceSpec,
  codexRecipe,
} from "../index.js"

describe("defineProvisionRecipe", () => {
  it("builds + freezes a valid recipe", () => {
    const r = defineProvisionRecipe({
      id: "acme",
      description: "Acme CLI token",
      methods: [{ id: "token", source: { env: "ACME_TOKEN" } }],
    })
    expect(r.id).toBe("acme")
    expect(Object.isFrozen(r)).toBe(true)
    expect(Object.isFrozen(r.methods[0])).toBe(true)
  })

  it("rejects a recipe with no methods", () => {
    expect(() =>
      defineProvisionRecipe({
        id: "acme",
        description: "x",
        // @ts-expect-error empty methods
        methods: [],
      }),
    ).toThrow(/defineProvisionRecipe \(AIP-19\)/)
  })

  it("rejects a literal value smuggled into a source", () => {
    expect(() =>
      defineProvisionRecipe({
        id: "acme",
        description: "x",
        methods: [
          // @ts-expect-error value is not an allowed source key
          { id: "token", source: { value: "sk-live-xxx" } },
        ],
      }),
    ).toThrow(/defineProvisionRecipe \(AIP-19\)/)
  })

  it("rejects a bad id via the shared doctype id pattern", () => {
    expect(() =>
      defineProvisionRecipe({
        id: "A",
        description: "x",
        methods: [{ id: "t", source: { env: "A" } }],
      }),
    ).toThrow(/AIP-19/)
  })
})

describe("parseRecipeManifest", () => {
  it("parses a .md frontmatter recipe to a handle", () => {
    const md = `---
id: widget
description: Widget CLI credential
label: Widget
methods:
  - id: token
    source:
      file: ~/.widget/creds.json
      jsonPath: auth.token
---
Notes about the widget recipe.`
    const r = parseRecipeManifest(md)
    expect(r.id).toBe("widget")
    expect(r.methods[0].source).toEqual({
      file: "~/.widget/creds.json",
      jsonPath: "auth.token",
    })
  })

  it("throws on missing frontmatter", () => {
    expect(() => parseRecipeManifest("no frontmatter here")).toThrow(
      /missing or empty frontmatter/,
    )
  })

  it("registers a parsed recipe so it resolves by id", () => {
    const r = parseRecipeManifest(`---
id: registered-widget
description: registered via manifest
methods:
  - id: token
    source: { env: REG_WIDGET }
---`)
    registerRecipe(r)
    expect(getRecipe("registered-widget")?.id).toBe("registered-widget")
  })
})

describe("registry + flavor selection", () => {
  it("ships the builtins", () => {
    const ids = listRecipeIds()
    expect(ids).toContain("claude-code-oauth")
    expect(ids).toContain("codex")
    expect(ids).toContain("gemini")
  })

  it("defaults to the first method when --method is omitted", () => {
    const { method } = resolveRecipeMethod("codex")
    expect(method.id).toBe("oauth-subscription")
  })

  it("selects a flavor by methodId", () => {
    const { method } = resolveRecipeMethod("codex", "api-key")
    expect(method.id).toBe("api-key")
    expect(method.source).toEqual({ env: "OPENAI_API_KEY" })
  })

  it("errors with the method list for an unknown flavor", () => {
    expect(() => resolveRecipeMethod("codex", "nope")).toThrow(
      /no method 'nope'.*oauth-subscription, api-key/s,
    )
  })

  it("errors with the provider list for an unknown provider", () => {
    expect(() => resolveRecipeMethod("does-not-exist")).toThrow(
      /unknown provider/,
    )
  })
})

describe("resolveSourceSpec", () => {
  it("reads an env source", async () => {
    process.env.__RECIPE_TEST_ENV = "env-secret"
    await expect(
      resolveSourceSpec({ env: "__RECIPE_TEST_ENV" }),
    ).resolves.toBe("env-secret")
    delete process.env.__RECIPE_TEST_ENV
  })

  it("reads a prompt source via the injected impl", async () => {
    await expect(
      resolveSourceSpec(
        { prompt: "Website password" },
        { promptImpl: async () => "typed-secret" },
      ),
    ).resolves.toBe("typed-secret")
  })

  it("throws when a prompt source has no promptImpl", async () => {
    await expect(
      resolveSourceSpec({ prompt: "Website password" }),
    ).rejects.toThrow(/no promptImpl/)
  })
})

describe("builtin codex recipe", () => {
  it("carries both flavors with distinct sources", () => {
    expect(codexRecipe.methods.map((m) => m.id)).toEqual([
      "oauth-subscription",
      "api-key",
    ])
  })
})
