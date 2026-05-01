import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { runTool } from "@agentproto/driver"
import { defineHttpDriver, expandTemplate, extractResponse } from "../index.js"

describe("expandTemplate", () => {
  const vars = {
    input: { prompt: "hi", aspect: "16:9" },
    secrets: { OPENAI_KEY: "sk-test" },
    context: { user: { id: "u_abc" } },
  }

  it("substitutes input values into strings", () => {
    expect(expandTemplate("hello ${input.prompt}", vars)).toBe("hello hi")
  })

  it("returns the typed value when entire string is a single substitution", () => {
    expect(expandTemplate("${input.prompt}", vars)).toBe("hi")
  })

  it("substitutes secrets", () => {
    expect(expandTemplate("Bearer ${secrets.OPENAI_KEY}", vars)).toBe(
      "Bearer sk-test"
    )
  })

  it("supports default fallback", () => {
    expect(
      expandTemplate("${input.missing | default('fallback')}", vars)
    ).toBe("fallback")
  })

  it("recursively expands objects + arrays", () => {
    const out = expandTemplate(
      {
        prompt: "${input.prompt}",
        nested: { aspect: "${input.aspect}" },
        arr: ["${input.prompt}"],
      },
      vars
    )
    expect(out).toEqual({
      prompt: "hi",
      nested: { aspect: "16:9" },
      arr: ["hi"],
    })
  })
})

describe("extractResponse — JSONPath-lite", () => {
  const body = {
    data: [
      { url: "https://a", id: "a" },
      { url: "https://b", id: "b" },
    ],
    meta: { count: 2 },
  }

  it("returns the body for $", () => {
    expect(extractResponse(body, "$")).toEqual(body)
  })

  it("extracts a property", () => {
    expect(extractResponse(body, "$.meta")).toEqual({ count: 2 })
  })

  it("extracts a nested property", () => {
    expect(extractResponse(body, "$.meta.count")).toBe(2)
  })

  it("extracts an array index", () => {
    expect(extractResponse(body, "$.data[0]")).toEqual({
      url: "https://a",
      id: "a",
    })
  })

  it("extracts a nested array index property", () => {
    expect(extractResponse(body, "$.data[0].url")).toBe("https://a")
  })

  it("maps wildcard array projections", () => {
    expect(extractResponse(body, "$.data[*].id")).toEqual(["a", "b"])
  })
})

describe("defineHttpDriver — end-to-end via runTool", () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("dispatches HTTP POST with body templating + response extraction", async () => {
    const tool = defineTool({
      id: "image-create",
      description: "Generate.",
      inputSchema: z.object({ prompt: z.string() }),
      outputSchema: z.object({ url: z.string() }),
    })

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      expect(url).toBe("https://api.openai.com/v1/images/generations")
      expect(init?.method).toBe("POST")
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer sk-test",
        "Content-Type": "application/json",
      })
      const body = JSON.parse(init!.body as string)
      expect(body).toEqual({ prompt: "hi", model: "dall-e-3" })
      return new Response(JSON.stringify({ data: [{ url: "https://result" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch

    const provider = defineHttpDriver({
      id: "openai-images-http",
      name: "OpenAI Images",
      description: "x",
      kind: "http",
      baseUrl: "https://api.openai.com",
      defaultHeaders: {
        Authorization: "Bearer ${secrets.OPENAI_KEY}",
        "Content-Type": "application/json",
      },
      implements: [
        {
          tool: "./tools/image-create/TOOL.md",
          version: "^1",
          metadata: {
            http: {
              endpoint: "/v1/images/generations",
              method: "POST",
              bodyTemplate: { prompt: "${input.prompt}", model: "dall-e-3" },
              responseExtract: "$.data[0]",
            },
          },
        },
      ],
    })

    const out = await runTool({
      tool,
      candidates: [provider],
      input: { prompt: "hi" },
      secrets: { OPENAI_KEY: "sk-test" },
    })
    expect(out).toEqual({ url: "https://result" })
  })

  it("surfaces auth_required on 401", async () => {
    const tool = defineTool({
      id: "echo",
      description: "x",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
    })
    globalThis.fetch = vi.fn(async () =>
      new Response("Unauthorized", { status: 401 })
    ) as typeof globalThis.fetch

    const provider = defineHttpDriver({
      id: "broken-http",
      name: "broken",
      description: "x",
      kind: "http",
      baseUrl: "https://api.example.com",
      implements: [
        {
          tool: "./tools/echo/TOOL.md",
          version: "^1",
          metadata: { http: { endpoint: "/echo" } },
        },
      ],
    })
    await expect(
      runTool({ tool, candidates: [provider], input: {} })
    ).rejects.toThrow(/auth_required|HTTP 401/)
  })

  it("supports custom buildRequest entry", async () => {
    const tool = defineTool({
      id: "custom",
      description: "x",
      inputSchema: z.object({ q: z.string() }),
      outputSchema: z.object({ r: z.string() }),
    })
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      expect(url).toBe("https://api.example.com/special")
      expect(init?.method).toBe("PUT")
      return new Response(JSON.stringify({ r: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch

    const provider = defineHttpDriver({
      id: "custom-http",
      name: "custom",
      description: "x",
      kind: "http",
      baseUrl: "https://api.example.com",
      buildRequest: ({ input }) => ({
        url: "https://api.example.com/special",
        method: "PUT",
        headers: {},
        body: { wrapped: input },
      }),
      implements: [
        { tool: "./tools/custom/TOOL.md", version: "^1" },
      ],
    })

    const out = await runTool({
      tool,
      candidates: [provider],
      input: { q: "hi" },
    })
    expect(out).toEqual({ r: "ok" })
  })
})
