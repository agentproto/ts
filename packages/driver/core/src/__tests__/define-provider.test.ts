import { describe, it, expect } from "vitest"
import { defineDriver, normalizeToolId } from "../define-provider.js"

describe("defineDriver — basic shape", () => {
  it("constructs a frozen handle from a minimal definition", () => {
    const provider = defineDriver({
      id: "openai-images-http",
      name: "OpenAI Images (HTTP)",
      description: "Image generation via OpenAI HTTP API.",
      version: "1.0.0",
      kind: "http",
      implements: [
        { tool: "./tools/image-create/TOOL.md", version: "^1.0.0" },
      ],
      execute: {
        "image-create": async () => ({ url: "https://..." }),
      },
    })

    expect(provider.id).toBe("openai-images-http")
    expect(provider.kind).toBe("http")
    expect(provider.region).toEqual(["global"])
    expect(provider.network.egress).toEqual([])
    expect(provider.policyTags).toEqual([])
    expect(provider.implements).toHaveLength(1)
    expect(provider.execute).toHaveProperty("image-create")
  })

  it("rejects invalid id", () => {
    expect(() =>
      defineDriver({
        id: "Invalid Id",
        name: "x",
        description: "x",
        kind: "http",
        implements: [{ tool: "./tools/x/TOOL.md", version: "^1" }],
        execute: { x: async () => undefined },
      })
    ).toThrow(/invalid id/)
  })

  it("rejects empty implements[]", () => {
    expect(() =>
      defineDriver({
        id: "prov",
        name: "prov",
        description: "desc",
        kind: "http",
        implements: [],
        execute: {},
      })
    ).toThrow(/≥1 implements/)
  })

  it("rejects implements/execute mismatch (missing execute key)", () => {
    expect(() =>
      defineDriver({
        id: "prov",
        name: "prov",
        description: "desc",
        kind: "http",
        implements: [{ tool: "./tools/foo/TOOL.md", version: "^1" }],
        execute: {},
      })
    ).toThrow(/no execute\['foo'\] body/)
  })

  it("rejects implements/execute mismatch (extra execute key)", () => {
    expect(() =>
      defineDriver({
        id: "prov",
        name: "prov",
        description: "desc",
        kind: "http",
        implements: [{ tool: "./tools/foo/TOOL.md", version: "^1" }],
        execute: {
          foo: async () => undefined,
          bar: async () => undefined,
        },
      })
    ).toThrow(/execute\['bar'\] but 'bar' is not in implements/)
  })

  it("preserves auth, network, region, policy_tags", () => {
    const provider = defineDriver({
      id: "prov",
      name: "prov",
      description: "desc",
      kind: "http",
      implements: [{ tool: "./tools/foo/TOOL.md", version: "^1" }],
      execute: { foo: async () => undefined },
      auth: {
        ref: "./SECRETS.md",
        state: { env: ["FOO_KEY"] },
        expiry: { detect: "http_status:401" },
      },
      network: { egress: ["api.foo.com"] },
      region: ["us-east-1"],
      policyTags: ["third-party-llm"],
    })
    expect(provider.auth?.state?.env).toEqual(["FOO_KEY"])
    expect(provider.network.egress).toEqual(["api.foo.com"])
    expect(provider.region).toEqual(["us-east-1"])
    expect(provider.policyTags).toEqual(["third-party-llm"])
  })
})

describe("normalizeToolId", () => {
  it.each([
    ["./tools/foo/TOOL.md", "foo"],
    ["tools/image-create/TOOL.md", "image-create"],
    ["./packages/x/tools/bar/TOOL.md", "bar"],
    ["foo", "foo"],
    ["foo/bar", "bar"],
  ])("normalises %s → %s", (ref, expected) => {
    expect(normalizeToolId(ref)).toBe(expected)
  })
})
