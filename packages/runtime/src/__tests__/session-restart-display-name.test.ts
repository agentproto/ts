/**
 * A restarted session must keep the predecessor's display name. The restart
 * copied `label` but not `title`/`renamedByUser`, so the successor re-derived
 * its title from the RESUME prompt ("Reprise après redémarrage du démon…")
 * and that title outranked the carried label in `sessionDisplayName`.
 */
import { describe, it, expect } from "vitest"

import { restartAgentSession } from "../session-restart-core.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { sessionDisplayName } from "../session-title.js"

let n = 0
const fake = (): AgentSessionLike => ({
  sessionId: `acp_dn_${n++}`,
  // eslint-disable-next-line require-yield
  async *send(): AsyncIterable<AgentStreamEvent> {
    return
  },
  async cancel() {},
  async close() {},
})
const resolver: AgentAdapterResolver = async () => ({
  async startSession() {
    return fake()
  },
  commandPreview: "mock-adapter",
})
const opts = { forceAgentResume: true, loadDefaultsConfig: async () => undefined }

describe("restart carries the display name", () => {
  it("keeps a human-renamed label as the display name", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const prev = registry.spawnAgent({
      workspaceSlug: "default", cwd: "/tmp", agentSession: fake(), adapterSlug: "hermes",
      label: "orchestrator-agent-pm-shopbot", title: "Old auto title",
    })
    registry.renameSession(prev.id, { label: "orchestrator-agent-pm-shopbot" })
    const { desc } = await restartAgentSession(registry, resolver, registry.get(prev.id)!, opts)
    expect(desc.renamedByUser).toBe(true)
    expect(sessionDisplayName(desc)).toBe("orchestrator-agent-pm-shopbot")
  })

  it("keeps the original derived title, not the resume prompt's", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const prev = registry.spawnAgent({
      workspaceSlug: "default", cwd: "/tmp", agentSession: fake(), adapterSlug: "hermes",
      label: "spawn-slug", title: "Fix the WhatsApp spam",
    })
    const { desc } = await restartAgentSession(registry, resolver, registry.get(prev.id)!, opts)
    expect(desc.title).toBe("Fix the WhatsApp spam")
    expect(sessionDisplayName(desc)).toBe("Fix the WhatsApp spam")
  })
})
