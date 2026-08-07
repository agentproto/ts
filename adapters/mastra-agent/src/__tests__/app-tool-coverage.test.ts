/**
 * Proves that every tool id `@agentproto/apps`' code-team declares — both on
 * its agents (`agent.tools`) and on its `deliver-change` workflow's steps
 * (`step.tool`) — resolves against this adapter's workspace toolset. That's
 * the pluggable-registry contract: an app built for this adapter shouldn't
 * silently drop tools (see `packages/mastra/src/build-agent.ts` drop/throw
 * behavior when a tool ref doesn't resolve).
 *
 * content-team's `content.cover-*` tool ids are a known, deliberate gap —
 * they're an image-generation pipeline this adapter has no tools for — so
 * content-team is excluded here rather than faked.
 */
import { codeTeam } from "@agentproto/apps/code-team"
import { refKey } from "@agentproto/app-kit"
import { describe, expect, it } from "vitest"
import { makeWorkspaceTools } from "../workspace-tools.js"

/** A workflow `StepTool.tool` ref is `string | { entry: string }` — distinct
 *  shape from the AIP-27 `AnyRef` (`string | { ref | file | inline }`) that
 *  `refKey` handles, so it gets its own tiny extractor. */
function stepToolId(tool: string | { entry: string }): string {
  return typeof tool === "string" ? tool : tool.entry
}

describe("code-team tool ids resolve against the mastra-agent workspace toolset", () => {
  it("every agent tool + deliver-change workflow step tool has a matching workspace tool", () => {
    const tools = makeWorkspaceTools({ cwd: process.cwd(), allowExec: true })

    const agentToolIds = codeTeam.agents.flatMap((entry) =>
      (entry.agent.tools ?? []).map((ref) => refKey(ref)),
    )
    const workflowToolIds = codeTeam.workflows.flatMap((workflow) =>
      workflow.steps
        .filter((step) => step.kind === "tool")
        .map((step) => stepToolId((step as { tool: string | { entry: string } }).tool)),
    )

    const declaredIds = new Set([...agentToolIds, ...workflowToolIds])
    expect(declaredIds.size).toBeGreaterThan(0)
    for (const id of declaredIds) {
      expect(tools[id], `tool '${id}' should resolve in the mastra-agent workspace toolset`).toBeDefined()
    }
  })
})
