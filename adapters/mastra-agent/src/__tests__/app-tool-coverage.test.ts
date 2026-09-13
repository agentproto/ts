/**
 * Proves that every tool id `@agentproto/apps`' code-team and media-viewer
 * apps declare — on agents (`agent.tools`) and, for code-team, its
 * `deliver-change` workflow's steps (`step.tool`) — resolves against this
 * adapter's workspace toolset. That's the pluggable-registry contract: an
 * app built for this adapter shouldn't silently drop tools (see
 * `packages/mastra/src/build-agent.ts` drop/throw behavior when a tool ref
 * doesn't resolve).
 *
 * media-viewer's `cataloger` agent is the app that shipped the original bug
 * this test guards against: its AGENT.md mixes both tool-id vocabularies
 * (`list_dir`/`read_file` alongside `file_info`), and `file_info` had no
 * matching workspace tool — it silently dropped, so the model never saw it
 * even though AGENT.md declared it.
 *
 * content-team's `content.cover-*` tool ids and mail-triage's `mailbox_*`
 * tool ids are known, deliberate gaps — an image-generation pipeline and a
 * mailbox integration this adapter has no tools for — so both apps are
 * excluded here rather than faked. (A declared-but-unresolved tool no longer
 * silently drops, though — see `default-agent.ts`'s `resolveTool` and
 * `makeUnwiredToolStub`: it still resolves, to a stub that fails fast and
 * clearly instead of hanging.)
 */
import { codeTeam } from "@agentproto/apps/code-team"
import { mediaViewer } from "@agentproto/apps/media-viewer"
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

describe("media-viewer tool ids resolve against the mastra-agent workspace toolset", () => {
  it("every agent tool has a matching workspace tool (regression: file_info used to silently drop)", () => {
    const tools = makeWorkspaceTools({ cwd: process.cwd(), allowExec: true })

    const declaredIds = new Set(
      mediaViewer.agents.flatMap((entry) => (entry.agent.tools ?? []).map((ref) => refKey(ref))),
    )
    expect(declaredIds.size).toBeGreaterThan(0)
    expect(declaredIds.has("file_info")).toBe(true)
    for (const id of declaredIds) {
      expect(tools[id], `tool '${id}' should resolve in the mastra-agent workspace toolset`).toBeDefined()
    }
  })
})
