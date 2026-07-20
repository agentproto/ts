import { describe, expect, it } from "vitest"
import { defineDriver, implementTool } from "@agentproto/driver"
import { defineTool } from "@agentproto/tool"
import { z } from "zod"
import { parseToolArgv, printToolOutput, toCliCommand, zodToFlags } from "../index.js"

const echo = defineTool({
  id: "test.echo",
  description: "Echo typed values for the CLI projection tests.",
  inputSchema: z.object({
    title: z.string().describe("A display title"),
    count: z.number().int().default(1),
    draft: z.boolean().optional(),
    label: z.array(z.string()).optional(),
    mode: z.enum(["fast", "safe"]),
  }),
  outputSchema: z.object({ title: z.string(), count: z.number(), draft: z.boolean().optional() }),
})

const driver = defineDriver({
  id: "test.echo-driver",
  name: "Test echo driver",
  description: "Runs the projected CLI test contract.",
  kind: "builtin",
  implements: [{ tool: echo.id, version: "*" }],
  implementations: [implementTool(echo, ({ input }) => ({
    title: input.title,
    count: input.count,
    ...(input.draft === undefined ? {} : { draft: input.draft }),
  }))],
})

describe("zodToFlags", () => {
  it("projects object fields with optionality, enums and repeatable arrays", () => {
    expect(zodToFlags(echo.inputSchema)).toMatchObject({
      kind: "object",
      flags: [
        { flag: "title", kind: "string", required: true },
        { flag: "count", kind: "number", required: false },
        { flag: "draft", kind: "boolean", required: false },
        { flag: "label", kind: "string", repeatable: true },
        { flag: "mode", kind: "enum", choices: ["fast", "safe"] },
      ],
    })
  })

  it("parses typed flags without applying schema defaults itself", () => {
    expect(parseToolArgv(echo.inputSchema, [
      "--title", "Hello", "--count", "2", "--draft", "--label", "one", "--label", "two", "--mode", "safe",
    ])).toEqual({ title: "Hello", count: 2, draft: true, label: ["one", "two"], mode: "safe" })
    expect(parseToolArgv(echo.inputSchema, ["--title", "Hello", "--no-draft", "--mode", "fast"])).toEqual({
      title: "Hello", draft: false, mode: "fast",
    })
  })
})

describe("toCliCommand", () => {
  it("runs the parsed contract through runTool and lets Zod apply defaults", async () => {
    const command = toCliCommand({ tool: echo, candidates: [driver] })
    expect(command.usage).toContain("test.echo")
    await expect(command.run(command.parse(["--title", "Hello", "--mode", "safe"]))).resolves.toEqual({
      title: "Hello",
      count: 1,
    })
  })

  it("prints JSON by default and only makes text raw when explicitly requested", () => {
    expect(printToolOutput({ ok: true })).toBe('{"ok":true}')
    expect(printToolOutput({ ok: true }, { pretty: true })).toBe('{\n  "ok": true\n}')
    expect(printToolOutput("body", { raw: true })).toBe("body")
  })
})
