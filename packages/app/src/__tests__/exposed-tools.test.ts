import { describe, it, expect } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import matter from "gray-matter"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"
import { defineApp } from "../define-app.js"
import { loadAppHandle } from "../load-app.js"
import { checkExposedTools, exposedToolName, parseExposedTools, resolveExposedTools } from "../exposed-tools.js"

const soloAgent = () =>
  defineAgent({
    schema: "agent/v1",
    id: "solo",
    description: "Solo agent.",
    model: "claude-sonnet-5",
    workflows: [{ ref: "do-it" }],
  })
const doIt = () =>
  defineWorkflow({
    id: "do-it",
    name: "Do it",
    description: "Does it.",
    version: "0.1.0",
    inputs: {},
    outputs: {},
    steps: [{ id: "s", kind: "tool", tool: "noop" }],
  })

interface BundledToolSpec {
  readonly id: string
  readonly tags?: readonly string[]
  readonly mutates?: readonly string[]
}

async function writeTool(dir: string, spec: BundledToolSpec): Promise<void> {
  const path = join(dir, ".agentproto", "tools", spec.id, "TOOL.md")
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(
    path,
    matter.stringify("", {
      schema: "agentproto/tool/v1",
      id: spec.id,
      name: spec.id,
      description: `Tool ${spec.id}.`,
      version: "1.0.0",
      inputs: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      },
      outputs: { type: "object", properties: {} },
      ...(spec.tags ? { tags: spec.tags } : {}),
      ...(spec.mutates ? { mutates: spec.mutates } : {}),
    }),
    "utf8",
  )
}

/** Emit a valid app, bundle the given tools, splice extra frontmatter lines into APP.md. */
async function loadWith(extra: string[], tools: BundledToolSpec[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "app-kit-exposed-tools-"))
  try {
    const { appPath } = await defineApp({
      id: "@test/exposed",
      agents: [{ agent: soloAgent(), body: "Solo." }],
      workflows: [doIt()],
    }).emit(dir)
    for (const t of tools) await writeTool(dir, t)
    await mkdir(join(dir, ".agentproto", "ui"), { recursive: true })
    await writeFile(join(dir, ".agentproto", "ui", "index.html"), "<html></html>", "utf8")
    const src = await readFile(appPath, "utf8")
    await writeFile(appPath, src.replace(/^---\n/, `---\n${extra.join("\n")}\n`))
    return await loadAppHandle(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const exposesYaml = (prefix: string, tools: string[][], uiTools: string[]): string[] => [
  "exposes:",
  `  prefix: ${prefix}`,
  "  tools:",
  ...tools.map(lines => lines.map((l, i) => (i === 0 ? `    - ${l}` : `      ${l}`)).join("\n")),
  "ui:",
  "  path: .agentproto/ui/index.html",
  `  tools: [${uiTools.join(", ")}]`,
]

describe("exposedToolName", () => {
  it("drops the private prefix and joins with the explicit one", () => {
    expect(exposedToolName("jobkit", { id: "jobkit.pipeline.kit_begin" })).toBe("jobkit_pipeline_kit_begin")
    expect(exposedToolName("bureau", { id: "bureau.status" })).toBe("bureau_status")
    expect(exposedToolName("jobkit", { id: "jobkit_list" })).toBe("jobkit_list")
  })

  it("never lets ':' or '/' through for an imported id", () => {
    const name = exposedToolName("bureau", { id: "imported:bureau/browser_list_instances", mcpName: "list_instances" })
    expect(name).toBe("bureau_list_instances")
    expect(name).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  it("applies the prefix to mcpName and tolerates it already carrying the prefix", () => {
    expect(exposedToolName("jobkit", { id: "jobkit.leads.upsert", mcpName: "jobkit_leads_up" })).toBe(
      "jobkit_leads_up",
    )
    expect(exposedToolName("jobkit", { id: "jobkit.leads.upsert", mcpName: "leads_up" })).toBe("jobkit_leads_up")
  })

  it("refuses an imported id without mcpName instead of guessing", () => {
    expect(() => exposedToolName("bureau", { id: "imported:bureau/x" })).toThrow(/mcpName/)
  })
})

describe("parseExposedTools", () => {
  const fail = (m: string) => new Error(m)
  const entry = (over: Record<string, unknown> = {}) => ({
    id: "bureau.status",
    access: "read",
    description: "Bureau status.",
    ...over,
  })

  it("accepts a well-formed block and reports the computed names", () => {
    const parsed = parseExposedTools([entry()], "bureau", fail)
    expect(parsed.prefix).toBe("bureau")
    expect(parsed.tools).toEqual([entry()])
  })

  it("rejects a prefix with '_' or a bad shape, and requires one when tools is non-empty", () => {
    expect(() => parseExposedTools([entry()], "job_kit", fail)).toThrow(/prefix/)
    expect(() => parseExposedTools([entry()], "J", fail)).toThrow(/prefix/)
    expect(() => parseExposedTools([entry()], undefined, fail)).toThrow(/prefix/)
  })

  it("rejects a prefix that is the first segment of a daemon tool", () => {
    expect(() =>
      parseExposedTools([entry()], "app", fail, { daemonToolNames: ["app_run", "session_list"] }),
    ).toThrow(/reserved/)
    expect(() => parseExposedTools([entry()], "bureau", fail, { daemonToolNames: ["app_run"] })).not.toThrow()
  })

  it("rejects a daemon tool id", () => {
    expect(() =>
      parseExposedTools([entry({ id: "app_run" })], "bureau", fail, { daemonToolNames: ["app_run"] }),
    ).toThrow(/daemon tool/)
  })

  it("rejects id or mcpName starting with 'approval'", () => {
    expect(() => parseExposedTools([entry({ id: "approval_request" })], "bureau", fail)).toThrow(/approval/)
    expect(() => parseExposedTools([entry({ mcpName: "approval_x" })], "bureau", fail)).toThrow(/approval/)
  })

  it("accepts an approval.* segment after the app namespace (jobkit.approval.status)", () => {
    expect(() => parseExposedTools([entry({ id: "jobkit.approval.status" })], "jobkit", fail)).not.toThrow()
  })

  it("rejects an internal name collision, whatever produced it", () => {
    expect(() =>
      parseExposedTools([entry({ id: "bureau.a.b" }), entry({ id: "bureau.a_b" })], "bureau", fail),
    ).toThrow(/same MCP name/)
    expect(() => parseExposedTools([entry(), entry()], "bureau", fail)).toThrow(/duplicate/)
  })

  it("lets an imported id through at any access class, with an explicit mcpName", () => {
    const imp = { id: "imported:bureau/x", access: "read", description: "d", mcpName: "x" }
    expect(() => parseExposedTools([imp], "bureau", fail)).not.toThrow()
    expect(parseExposedTools([{ ...imp, access: "write" }], "bureau", fail).tools[0]?.access).toBe("write")
    expect(
      parseExposedTools([{ ...imp, access: "approve", approvalArg: "approvalId" }], "bureau", fail).tools[0]?.access,
    ).toBe("approve")
    expect(() => parseExposedTools([{ ...imp, mcpName: undefined }], "bureau", fail)).toThrow(/mcpName/)
    expect(() => parseExposedTools([{ ...imp, mcpName: "a/b" }], "bureau", fail)).toThrow(/mcpName/)
  })

  it("checkExposedTools keeps the valid entries and lists each refused one with its reason", () => {
    const out = checkExposedTools(
      [
        entry({ id: "bureau.status" }),
        { id: "imported:bureau/browser_click", access: "write", description: "d" },
        entry({ id: "bureau.status" }),
        entry({ id: "bureau.ok", description: "" }),
        { id: "imported:bureau/browser_navigate", access: "write", description: "d", mcpName: "navigate" },
      ],
      "bureau",
      fail,
    )
    expect(out.tools.map(t => t.id)).toEqual(["bureau.status", "imported:bureau/browser_navigate"])
    expect(out.refused.map(r => [r.index, r.id])).toEqual([
      [1, "imported:bureau/browser_click"],
      [2, "bureau.status"],
      [3, "bureau.ok"],
    ])
    expect(out.refused[0]?.reason).toMatch(/mcpName/)
    expect(out.refused[1]?.reason).toMatch(/duplicate/)
    expect(out.refused[2]?.reason).toMatch(/description/)
    // A list-level fault still throws.
    expect(() => checkExposedTools([entry()], undefined, fail)).toThrow(/prefix/)
  })

  it("restricts approvalArg to access: approve, and requires a short description", () => {
    expect(() => parseExposedTools([entry({ approvalArg: "nonce" })], "bureau", fail)).toThrow(/approvalArg/)
    expect(() =>
      parseExposedTools([entry({ access: "approve", approvalArg: "nonce" })], "bureau", fail),
    ).not.toThrow()
    expect(() => parseExposedTools([entry({ description: "" })], "bureau", fail)).toThrow(/description/)
    expect(() => parseExposedTools([entry({ description: "x".repeat(301) })], "bureau", fail)).toThrow(/300/)
    expect(() => parseExposedTools([entry({ access: "admin" })], "bureau", fail)).toThrow(/access/)
    expect(() => parseExposedTools([entry({ acess: "read" })], "bureau", fail)).toThrow(/unknown key/)
  })

  it("rejects a name longer than 64 characters", () => {
    expect(() => parseExposedTools([entry({ id: `bureau.${"a".repeat(60)}` })], "bureau", fail)).toThrow(/64/)
  })

  describe("exposes.resources", () => {
    const imp = { id: "imported:bureau/browser_screenshot", access: "read", description: "d", mcpName: "screenshot" }
    const uris = ["ui://bureau/screenshot", "ui://bureau/recording"]

    it("accepts distinct ui:// URIs next to an imported entry", () => {
      expect(parseExposedTools([imp], "bureau", fail, {}, uris).resources).toEqual(uris)
      expect(parseExposedTools([imp], "bureau", fail).resources).toBeUndefined()
    })

    it("rejects a non-ui:// URI, a duplicate and a wrong type", () => {
      expect(() => parseExposedTools([imp], "bureau", fail, {}, ["https://bureau/screenshot"])).toThrow(/ui:\/\//)
      expect(() => parseExposedTools([imp], "bureau", fail, {}, ["ui://"])).toThrow(/ui:\/\//)
      expect(() => parseExposedTools([imp], "bureau", fail, {}, [uris[0], uris[0]])).toThrow(/duplicate/)
      expect(() => parseExposedTools([imp], "bureau", fail, {}, "ui://bureau/screenshot")).toThrow(/array/)
      expect(() => parseExposedTools([imp], "bureau", fail, {}, [{ uri: uris[0] }])).toThrow(/ui:\/\//)
    })

    it("survives an APP.md load, and a bad URI fails the load", async () => {
      const handle = await loadWith([
        "exposes:",
        "  prefix: bureau",
        "  tools:",
        "    - { id: imported:bureau/browser_screenshot, access: read, description: d, mcpName: screenshot }",
        `  resources: [${uris.join(", ")}]`,
      ])
      expect(handle.exposes.resources).toEqual(uris)
      await expect(
        loadWith([
          "exposes:",
          "  prefix: bureau",
          "  tools:",
          "    - { id: imported:bureau/browser_screenshot, access: read, description: d, mcpName: screenshot }",
          "  resources: [https://example.com/x]",
        ]),
      ).rejects.toThrow(/ui:\/\//)
    })

    it("needs an imported entry to relay from", () => {
      expect(() => parseExposedTools([entry()], "bureau", fail, {}, uris)).toThrow(/imported/)
      expect(() => parseExposedTools(undefined, undefined, fail, {}, uris)).toThrow(/imported/)
    })
  })
})

describe("resolveExposedTools", () => {
  it("takes the real schema from the TOOL.md unless the entry overrides it", () => {
    const inputs = { type: "object", properties: { q: { type: "string" } } }
    const override = { type: "object", properties: { z: { type: "number" } } }
    const resolved = resolveExposedTools(
      {
        prefix: "bureau",
        tools: [
          { id: "bureau.a", access: "read", description: "A." },
          { id: "bureau.b", access: "read", description: "B.", inputSchema: override },
        ],
      },
      [
        { id: "bureau.a", tags: [], mutates: [], inputs },
        { id: "bureau.b", tags: [], mutates: [], inputs },
      ],
    )
    expect(resolved.map(r => [r.name, r.inputs])).toEqual([
      ["bureau_a", inputs],
      ["bureau_b", override],
    ])
  })
})
