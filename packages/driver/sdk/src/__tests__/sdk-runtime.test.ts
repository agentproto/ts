import { describe, it, expect } from "vitest"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { runTool } from "@agentproto/driver"
import { defineSdkDriver, resolveFunctionRef } from "../index.js"

describe("resolveFunctionRef", () => {
  const modWithDefault = {
    default: () => "default-fn",
    createImage: () => "create",
    images: {
      create: () => "images.create",
    },
  }
  const modCallableSelf = (() => "callable") as { (): string } & Record<string, unknown>

  it("resolves explicit default export when present (ESM)", () => {
    expect(resolveFunctionRef(modWithDefault, "default")).toBe(modWithDefault.default)
  })

  it("falls back to the module itself when no .default (CJS-style)", () => {
    expect(resolveFunctionRef(modCallableSelf, "default")).toBe(modCallableSelf)
  })

  it("resolves single key", () => {
    expect(typeof resolveFunctionRef(modWithDefault, "createImage")).toBe("function")
  })

  it("resolves nested keys", () => {
    expect(typeof resolveFunctionRef(modWithDefault, "images.create")).toBe("function")
  })

  it("returns undefined for unknown keys", () => {
    expect(resolveFunctionRef(modWithDefault, "nope.nope")).toBeUndefined()
  })
})

describe("defineSdkDriver — end-to-end via runTool", () => {
  it("dispatches to a custom-loaded module's default export with object args", async () => {
    const tool = defineTool({
      id: "uppercase",
      description: "Uppercases.",
      inputSchema: z.object({ s: z.string() }),
      outputSchema: z.object({ result: z.string() }),
    })

    const provider = defineSdkDriver({
      id: "host-uppercase-sdk",
      name: "host-uppercase",
      description: "x",
      kind: "sdk",
      package: "host-uppercase",
      packageManager: "local",
      loadModule: async () => ({
        default: (input: { s: string }) => ({ result: input.s.toUpperCase() }),
      }),
      implements: [
        {
          tool: "./tools/uppercase/TOOL.md",
          version: "^1",
          metadata: { sdk: { functionRef: "default" } },
        },
      ],
    })

    const out = await runTool({
      tool,
      candidates: [provider],
      input: { s: "hi" },
    })
    expect(out).toEqual({ result: "HI" })
  })

  it("supports nested function refs (images.create)", async () => {
    const tool = defineTool({
      id: "image-create",
      description: "x",
      inputSchema: z.object({ prompt: z.string() }),
      outputSchema: z.object({ url: z.string() }),
    })

    const provider = defineSdkDriver({
      id: "test-sdk",
      name: "test",
      description: "x",
      kind: "sdk",
      package: "test",
      packageManager: "local",
      loadModule: async () => ({
        images: {
          create: (input: { prompt: string }) => ({
            url: `https://result/${input.prompt}`,
          }),
        },
      }),
      implements: [
        {
          tool: "./tools/image-create/TOOL.md",
          version: "^1",
          metadata: { sdk: { functionRef: "images.create" } },
        },
      ],
    })

    const out = await runTool({
      tool,
      candidates: [provider],
      input: { prompt: "hi" },
    })
    expect(out).toEqual({ url: "https://result/hi" })
  })

  it("supports args_template + result_extract", async () => {
    const tool = defineTool({
      id: "chat",
      description: "x",
      inputSchema: z.object({ messages: z.array(z.unknown()) }),
      outputSchema: z.object({ content: z.string() }),
    })

    const provider = defineSdkDriver({
      id: "test-sdk",
      name: "test",
      description: "x",
      kind: "sdk",
      package: "test",
      packageManager: "local",
      loadModule: async () => ({
        completions: {
          create: (req: { model: string; messages: unknown[] }) => ({
            choices: [{ message: { content: `received-${req.messages.length}` } }],
          }),
        },
      }),
      implements: [
        {
          tool: "./tools/chat/TOOL.md",
          version: "^1",
          metadata: {
            sdk: {
              functionRef: "completions.create",
              argsTemplate: { model: "gpt-4o", messages: "${input.messages}" },
              resultExtract: "$.choices[0].message",
            },
          },
        },
      ],
    })

    const out = await runTool({
      tool,
      candidates: [provider],
      input: { messages: [{ role: "user", content: "hi" }] },
    })
    expect(out).toEqual({ content: "received-1" })
  })

  it("uses custom buildArgs when provided", async () => {
    const tool = defineTool({
      id: "positional",
      description: "x",
      inputSchema: z.object({ a: z.string(), b: z.number() }),
      outputSchema: z.object({ joined: z.string() }),
    })

    const provider = defineSdkDriver({
      id: "test-sdk",
      name: "test",
      description: "x",
      kind: "sdk",
      package: "test",
      packageManager: "local",
      loadModule: async () => ({
        default: (a: string, b: number) => ({ joined: `${a}-${b}` }),
      }),
      buildArgs: ({ input }) => [
        (input as { a: string }).a,
        (input as { b: number }).b,
      ],
      implements: [
        {
          tool: "./tools/positional/TOOL.md",
          version: "^1",
          metadata: { sdk: { functionRef: "default" } },
        },
      ],
    })

    const out = await runTool({
      tool,
      candidates: [provider],
      input: { a: "x", b: 42 },
    })
    expect(out).toEqual({ joined: "x-42" })
  })

  it("throws function_ref_unresolvable when ref doesn't resolve", async () => {
    const tool = defineTool({
      id: "missing-fn",
      description: "x",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
    })
    const provider = defineSdkDriver({
      id: "broken-sdk",
      name: "broken",
      description: "x",
      kind: "sdk",
      package: "broken",
      packageManager: "local",
      loadModule: async () => ({}),
      implements: [
        {
          tool: "./tools/missing-fn/TOOL.md",
          version: "^1",
          metadata: { sdk: { functionRef: "no.such.thing" } },
        },
      ],
    })
    await expect(
      runTool({ tool, candidates: [provider], input: {} })
    ).rejects.toMatchObject({ code: "function_ref_unresolvable" })
  })
})
