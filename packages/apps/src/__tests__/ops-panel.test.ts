import { describe, it, expect } from "vitest"
import { opsPanel, WATCHDOG_LABEL, WATCHDOG_TICK_LABEL, WATCHDOG_TICK_SCHEDULE, MANAGER_LABEL } from "../ops-panel/index.js"
import { OPS_PANEL_TOOLS } from "../ops-panel/ui.js"

const fakeModel = { provider: "test", id: "test-model" }

describe("ops-panel app", () => {
  it("exposes stable app identity fields", () => {
    expect(opsPanel.id).toBe("@agentproto/ops-panel")
    expect(opsPanel.name).toBe("Ops Panel")
    expect(opsPanel.version).toBe("0.1.0")
  })

  it("bundles the watchdog and manager agents", () => {
    expect(opsPanel.agents.map((a) => a.agent.id)).toEqual([
      "@agentproto/session-watchdog",
      "@agentproto/sessions-manager",
    ])
  })

  it("keeps the watchdog observe-only: no kill, no spawn, no prompt tool", () => {
    const wd = opsPanel.agents.find((a) => a.agent.id === "@agentproto/session-watchdog")!.agent
    expect(wd.tools).toEqual([
      "session_list",
      "session_events_poll",
      "session_flag_status",
      "session_archive",
      "session_gc",
    ])
    for (const forbidden of ["agent_kill", "agent_start", "agent_prompt"]) {
      expect(wd.tools).not.toContain(forbidden)
    }
  })

  it("gives the manager drive tools but never a kill", () => {
    const mgr = opsPanel.agents.find((a) => a.agent.id === "@agentproto/sessions-manager")!.agent
    expect(mgr.tools).toContain("agent_prompt")
    expect(mgr.tools).toContain("session_restart")
    expect(mgr.tools).not.toContain("agent_kill")
  })

  it("builds both agents, bodies becoming real Mastra instructions", async () => {
    const built = await opsPanel.toMastraAgents({ resolveModel: () => fakeModel })
    expect(Object.keys(built).sort()).toEqual([
      "@agentproto/session-watchdog",
      "@agentproto/sessions-manager",
    ])
    expect(built["@agentproto/session-watchdog"]!.instructions).toContain("session_events_poll")
    expect(built["@agentproto/sessions-manager"]!.instructions).toContain("conversation_read")
  })

  it("ships the ops UI panel with the daemon tools it calls", () => {
    expect(opsPanel.ui).toBeDefined()
    expect(opsPanel.ui!.title).toBe("Ops Panel")
    expect(opsPanel.ui!.tools).toEqual([...OPS_PANEL_TOOLS])
    expect(opsPanel.ui!.html.length).toBeGreaterThan(0)
  })

  it("embeds the special-session launch config the panel spawns by", () => {
    expect(WATCHDOG_LABEL).toBe("Session Watchdog")
    expect(MANAGER_LABEL).toBe("Sessions Manager")
    expect(WATCHDOG_TICK_LABEL).toBe("watchdog-tick")
    expect(WATCHDOG_TICK_SCHEDULE).toBe("*/5 * * * *")
    for (const needle of [WATCHDOG_LABEL, MANAGER_LABEL, WATCHDOG_TICK_LABEL]) {
      expect(opsPanel.ui!.html).toContain(needle)
    }
  })
})
