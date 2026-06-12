/**
 * The WORKFLOW.md path: author a manifest as a markdown source string (the
 * exact bytes that live on disk), compile it against a tool registry, run it.
 * Proves the seam that was missing — parse → handle → compile → run — so an
 * authored WORKFLOW.md actually executes instead of just validating.
 */

import { describe, it, expect } from "vitest"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { defineDriver, implementTool } from "@agentproto/driver"
import { compileWorkflowManifest, runWorkflow } from "../index.js"

const doubleTool = defineTool({
  id: "demo.double",
  description: "Double a number.",
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ n: z.number() }),
})
const addTenTool = defineTool({
  id: "demo.add-ten",
  description: "Add ten.",
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ n: z.number() }),
})
const provider = defineDriver({
  id: "math-builtin",
  name: "Math",
  description: "Trivial arithmetic.",
  kind: "builtin",
  implements: [
    { tool: "demo.double", version: "0.1.0" },
    { tool: "demo.add-ten", version: "0.1.0" },
  ],
  implementations: [
    implementTool(doubleTool, ({ input }) => ({ n: input.n * 2 })),
    implementTool(addTenTool, ({ input }) => ({ n: input.n + 10 })),
  ],
})
const tools = { "demo.double": doubleTool, "demo.add-ten": addTenTool }
const candidates = [provider]

const MANIFEST = `---
name: Double then add
id: double-add
description: Double the input, then add ten.
version: 0.1.0
inputs: {}
outputs: {}
steps:
  - id: d
    kind: tool
    tool: demo.double
    inputs:
      n: $input.n
  - id: a
    kind: tool
    tool: demo.add-ten
    inputs:
      n: $steps.d.n
---

# Double then add

Double the input, then add ten. Body prose is ignored by the runtime.
`

describe("compileWorkflowManifest", () => {
  it("compiles + runs a WORKFLOW.md source end to end", async () => {
    const compiled = compileWorkflowManifest(MANIFEST, { tools, candidates })
    const { output } = await runWorkflow({ workflow: compiled, input: { n: 5 } })
    // 5 → double 10 → add ten 20
    expect((output as { n: number }).n).toBe(20)
  })

  it("surfaces the frontmatter diagnostic on an invalid manifest", () => {
    const bad = `---
name: Missing id
description: No id field, so the schema rejects it.
version: 0.1.0
inputs: {}
outputs: {}
steps: []
---
`
    expect(() => compileWorkflowManifest(bad, { tools, candidates })).toThrow(
      /parseWorkflowManifest/,
    )
  })

  it("surfaces the compiler diagnostic when a tool id is unregistered", () => {
    const unknownTool = `---
name: Unknown tool
id: unknown-tool
description: References a tool not in the registry.
version: 0.1.0
inputs: {}
outputs: {}
steps:
  - id: s
    kind: tool
    tool: demo.missing
    inputs:
      n: $input.n
---
`
    expect(() =>
      compileWorkflowManifest(unknownTool, { tools, candidates }),
    ).toThrow(/no tool registered for 'demo.missing'/)
  })
})
