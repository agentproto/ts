import { describe, it, expect } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import matter from "gray-matter"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"
import { defineApp } from "../define-app.js"
import { loadAppHandle } from "../load-app.js"

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

describe("exposes.tools through loadAppHandle / defineApp", () => {
  const read = (id: string) => [`id: ${id}`, "access: read", `description: "Reads ${id}."`]

  it("loads exposes.prefix and exposes.tools onto the handle", async () => {
    const app = await loadWith(exposesYaml("jobkit", [read("jobkit.list")], ["jobkit.list"]), [{ id: "jobkit.list" }])
    expect(app.exposes.prefix).toBe("jobkit")
    expect(app.exposes.tools).toEqual([
      { id: "jobkit.list", access: "read", description: "Reads jobkit.list." },
    ])
  })

  it("leaves an app without exposes.tools exactly as before", async () => {
    const app = await loadWith([])
    expect(app.exposes).toEqual({ agents: [], workflows: [] })
  })

  it("refuses access: read on a tool tagged mutator or write", async () => {
    for (const tag of ["mutator", "write"]) {
      await expect(
        loadWith(exposesYaml("jobkit", [read("jobkit.save")], ["jobkit.save"]), [{ id: "jobkit.save", tags: [tag] }]),
      ).rejects.toThrow(/access: read.*(mutator|write)|(mutator|write).*access: read/)
    }
  })

  it("refuses access: read on a tool that declares mutates", async () => {
    await expect(
      loadWith(exposesYaml("jobkit", [read("jobkit.save")], ["jobkit.save"]), [
        { id: "jobkit.save", mutates: ["fs"] },
      ]),
    ).rejects.toThrow(/mutates/)
  })

  it("accepts access: write on a tool tagged mutator", async () => {
    const app = await loadWith(
      exposesYaml("jobkit", [["id: jobkit.save", "access: write", 'description: "Saves."']], ["jobkit.save"]),
      [{ id: "jobkit.save", tags: ["mutator"] }],
    )
    expect(app.exposes.tools?.[0]?.access).toBe("write")
  })

  it("refuses an id that is not a bundled TOOL.md", async () => {
    await expect(
      loadWith(exposesYaml("jobkit", [read("jobkit.ghost")], ["jobkit.ghost"]), []),
    ).rejects.toThrow(/jobkit\.ghost.*TOOL\.md/)
  })

  it("loads an exposed id that is not in ui.tools (the daemon dispatches exposes.tools itself)", async () => {
    const app = await loadWith(exposesYaml("jobkit", [read("jobkit.list")], ["jobkit.other"]), [{ id: "jobkit.list" }])
    expect(app.exposes.tools?.map(t => t.id)).toEqual(["jobkit.list"])
  })

  it("refuses an approval* id", async () => {
    await expect(
      loadWith(exposesYaml("jobkit", [read("approval_request")], ["approval_request"]), []),
    ).rejects.toThrow(/approval/)
  })

  it("refuses two entries that compute the same MCP name", async () => {
    await expect(
      loadWith(
        exposesYaml("jobkit", [read("jobkit.a.b"), read("jobkit.a_b")], ["jobkit.a.b", "jobkit.a_b"]),
        [{ id: "jobkit.a.b" }, { id: "jobkit.a_b" }],
      ),
    ).rejects.toThrow(/same MCP name/)
  })

  it("defineApp accepts the same block and freezes it", () => {
    const app = defineApp({
      agents: [{ agent: soloAgent(), body: "Solo." }],
      workflows: [doIt()],
      exposes: { prefix: "bureau", tools: [{ id: "imported:bureau/x", access: "read", description: "d", mcpName: "x" }] },
      ui: { html: "<html></html>", tools: ["imported:bureau/x"] },
    })
    expect(Object.isFrozen(app.exposes.tools)).toBe(true)
    expect(app.exposes.prefix).toBe("bureau")
  })

  it("round-trips through emit and load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "app-kit-exposed-tools-emit-"))
    try {
      const exposes = {
        prefix: "bureau",
        tools: [{ id: "imported:bureau/x", access: "read" as const, description: "d", mcpName: "x" }],
      }
      await defineApp({
        id: "@test/roundtrip",
        agents: [{ agent: soloAgent(), body: "Solo." }],
        workflows: [doIt()],
        exposes,
        ui: { html: "<html></html>", tools: ["imported:bureau/x"] },
      }).emit(dir)
      const loaded = await loadAppHandle(dir)
      expect(loaded.exposes).toEqual({ agents: [], workflows: [], ...exposes })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
