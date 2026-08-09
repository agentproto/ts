import { describe, it, expect } from "vitest"
import { mediaViewer } from "../media-viewer/index.js"

const fakeModel = { provider: "test", id: "test-model" }

describe("media-viewer app", () => {
  it("exposes stable app identity fields", () => {
    expect(mediaViewer.id).toBe("@agentproto/media-viewer")
    expect(mediaViewer.name).toBe("Media Viewer")
    expect(mediaViewer.version).toBe("0.1.0")
  })

  it("bundles the single cataloger agent bound to the scan-media workflow", () => {
    expect(mediaViewer.agents.map((a) => a.agent.id)).toEqual(["@agentproto/media-cataloger"])
    expect(mediaViewer.workflows.map((w) => w.id)).toEqual(["scan-media"])
    for (const { agent } of mediaViewer.agents) {
      expect(agent.workflows).toContainEqual({ ref: "scan-media" })
    }
  })

  it("builds the agent, its body becoming real Mastra instructions", async () => {
    const built = await mediaViewer.toMastraAgents({ resolveModel: () => fakeModel })
    expect(Object.keys(built)).toEqual(["@agentproto/media-cataloger"])
    expect(built["@agentproto/media-cataloger"]!.instructions).toContain("structured JSON catalog")
  })

  it("gives the cataloger the filesystem tools it needs to scan media", () => {
    const cataloger = mediaViewer.agents[0]!.agent
    expect(cataloger.tools).toEqual(["list_dir", "read_file", "file_info"])
  })

  it("scans a folder for media through a single agent step (WP scan-media)", () => {
    const wf = mediaViewer.workflows[0]!
    expect(wf.steps.map((s) => `${s.id}:${s.kind}`)).toEqual(["catalog:agent"])
    const refs = wf.steps.map((s) => (s as { agent?: { ref: string } }).agent?.ref)
    expect(refs).toEqual(["@agentproto/media-cataloger"])
  })
})
