import { describe, it, expect } from "vitest"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { runTool } from "@agentproto/driver"
import { defineCliDriver, expandArgv } from "../index.js"

describe("expandArgv", () => {
  it("substitutes ${input.X}", () => {
    expect(
      expandArgv(["pr", "create", "--title", "${input.title}"], {
        input: { title: "Fix bug" },
        secrets: {},
      })
    ).toEqual(["pr", "create", "--title", "Fix bug"])
  })

  it("supports default filter", () => {
    expect(
      expandArgv(["${input.base | default('main')}"], {
        input: {},
        secrets: {},
      })
    ).toEqual(["main"])
  })

  it("supports flag filter (truthy → append, falsy → skip)", () => {
    expect(
      expandArgv(["create", "${input.draft | flag('--draft')}"], {
        input: { draft: true },
        secrets: {},
      })
    ).toEqual(["create", "--draft"])
    expect(
      expandArgv(["create", "${input.draft | flag('--draft')}"], {
        input: { draft: false },
        secrets: {},
      })
    ).toEqual(["create"])
  })

  it("supports optional filter (set → flag+value, unset → skip)", () => {
    expect(
      expandArgv(["${input.head | optional('--head', input.head)}"], {
        input: { head: "feature/x" },
        secrets: {},
      })
    ).toEqual(["--head", "feature/x"])
    expect(
      expandArgv(["${input.head | optional('--head', input.head)}"], {
        input: {},
        secrets: {},
      })
    ).toEqual([])
  })

  it("supports multi-substitution literals", () => {
    expect(
      expandArgv(["release-${input.version}"], {
        input: { version: "1.2.3" },
        secrets: {},
      })
    ).toEqual(["release-1.2.3"])
  })
})

describe("defineCliDriver — end-to-end via runTool", () => {
  it("dispatches to a real subprocess (echo) and returns stdout", async () => {
    const tool = defineTool({
      id: "echo-tool",
      description: "echoes input",
      inputSchema: z.object({ msg: z.string() }),
      outputSchema: z.string(),
    })

    const provider = defineCliDriver({
      id: "echo-cli",
      name: "echo",
      description: "x",
      kind: "cli",
      bin: "echo",
      output: { defaultFormat: "text", exitCodes: { 0: "ok" } },
      implements: [
        {
          tool: "./tools/echo-tool/TOOL.md",
          version: "^1",
          metadata: { cli: { argv: ["${input.msg}"] } },
        },
      ],
    })

    const out = await runTool({
      tool,
      candidates: [provider],
      input: { msg: "hello" },
    })
    expect(typeof out).toBe("string")
    expect((out as string).trim()).toBe("hello")
  })

  it("maps non-zero exit codes to provider error semantics", async () => {
    const tool = defineTool({
      id: "false-tool",
      description: "always fails",
      inputSchema: z.object({}),
      outputSchema: z.unknown(),
    })

    const provider = defineCliDriver({
      id: "false-cli",
      name: "false",
      description: "x",
      kind: "cli",
      bin: "false",
      output: { exitCodes: { 0: "ok", 1: "auth_required" } },
      implements: [
        {
          tool: "./tools/false-tool/TOOL.md",
          version: "^1",
          metadata: { cli: { argv: [] } },
        },
      ],
    })

    await expect(
      runTool({ tool, candidates: [provider], input: {} })
    ).rejects.toMatchObject({ code: "auth_required" })
  })
})
