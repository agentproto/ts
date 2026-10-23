import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  getModelList,
  resetModelListSource,
  ZERO_COST_LIST_ID,
} from "../model-list-store.js"
import { registerModelListTools } from "../model-list-tools.js"

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>
  isError?: true
}>

const handlers = new Map<string, Handler>()

const server = {
  tool(name: string, _description: string, _shape: unknown, handler: Handler) {
    handlers.set(name, handler)
  },
} as unknown as McpServer

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agentproto-model-list-tools-"))
  process.env.HOME = home
  resetModelListSource()
  handlers.clear()
  registerModelListTools(server)
})

afterEach(async () => {
  if (process.env.HOME === home) delete process.env.HOME
  resetModelListSource()
  await rm(home, { recursive: true, force: true })
})

function save(args: Record<string, unknown>) {
  const handler = handlers.get("model_list_save")
  if (!handler) throw new Error("model_list_save not registered")
  return handler(args)
}

describe("model_list_save reference validation", () => {
  it("refuses an unknown nested list and writes nothing", async () => {
    const result = await save({
      id: "bad",
      include: [{ kind: "list", id: "missing" }],
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('unknown model list "missing"')
    expect(await getModelList("bad")).toBeUndefined()
  })

  it("refuses a cycle and keeps the previous version of the list", async () => {
    expect((await save({ id: "a", ids: ["custom/a"] })).isError).toBeUndefined()
    expect(
      (await save({ id: "b", include: [{ kind: "list", id: "a" }] })).isError,
    ).toBeUndefined()

    const result = await save({
      id: "a",
      include: [{ kind: "list", id: "b" }],
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain("cycle")
    expect(await getModelList("a")).toEqual({ id: "a", ids: ["custom/a"] })
  })

  it("refuses to widen or replace the zero-cost entitlement list", async () => {
    const result = await save({
      id: ZERO_COST_LIST_ID,
      ids: ["opencode/gpt-5.1-codex"],
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toMatch(/built-in and cannot be edited/)
    expect(await getModelList(ZERO_COST_LIST_ID)).toEqual({
      id: ZERO_COST_LIST_ID,
      label: "Zero-cost models",
      include: [{ kind: "tag", value: "price:zero" }],
    })
  })
})
