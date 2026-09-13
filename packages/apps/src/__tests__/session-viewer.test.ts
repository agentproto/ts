import { describe, it, expect } from "vitest"
import { sessionViewer } from "../session-viewer/index.js"

const fakeModel = { provider: "test", id: "test-model" }

describe("session-viewer app", () => {
  it("exposes stable app identity fields", () => {
    expect(sessionViewer.id).toBe("@agentproto/session-viewer")
    expect(sessionViewer.name).toBe("Session Viewer")
    expect(sessionViewer.version).toBe("0.1.0")
  })

  it("bundles the single narrator agent bound to the narrate-session workflow", () => {
    expect(sessionViewer.agents.map((a) => a.agent.id)).toEqual(["@agentproto/session-narrator"])
    expect(sessionViewer.workflows.map((w) => w.id)).toEqual(["narrate-session"])
    for (const { agent } of sessionViewer.agents) {
      expect(agent.workflows).toContainEqual({ ref: "narrate-session" })
    }
  })

  it("builds the agent, its body becoming real Mastra instructions", async () => {
    const built = await sessionViewer.toMastraAgents({ resolveModel: () => fakeModel })
    expect(Object.keys(built)).toEqual(["@agentproto/session-narrator"])
    expect(built["@agentproto/session-narrator"]!.instructions).toContain("conversation_read")
  })

  it("gives the narrator read-only conversation tools, never a spawn/kill/resume one", () => {
    const narrator = sessionViewer.agents[0]!.agent
    expect(narrator.tools).toEqual(["conversation_read", "session_list"])
  })

  it("narrates a session through a single agent step (narrate-session)", () => {
    const wf = sessionViewer.workflows[0]!
    expect(wf.steps.map((s) => `${s.id}:${s.kind}`)).toEqual(["narrate:agent"])
    const refs = wf.steps.map((s) => (s as { agent?: { ref: string } }).agent?.ref)
    expect(refs).toEqual(["@agentproto/session-narrator"])
  })

  it("ships a conversation-viewer UI panel with the daemon tools it calls", () => {
    expect(sessionViewer.ui).toBeDefined()
    expect(sessionViewer.ui!.title).toBe("Session Viewer")
    expect(sessionViewer.ui!.tools).toEqual(["session_list", "conversation_read"])
    expect(sessionViewer.ui!.html.length).toBeGreaterThan(0)
  })
})
