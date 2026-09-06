import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadAppHandle } from "@agentproto/app-kit"
import { sessionsPanelApp } from "../sessions-panel/index.js"
import { agentsOverviewApp } from "../agents-overview/index.js"
import { bureauSessionsApp } from "../bureau-sessions/index.js"
import { sessionStoryApp } from "../session-story/index.js"
import { liveSessionApp } from "../live-session/index.js"

const PANELS = [
  { slug: "sessions-panel", handle: sessionsPanelApp },
  { slug: "agents-overview", handle: agentsOverviewApp },
  { slug: "bureau-sessions", handle: bureauSessionsApp },
  { slug: "session-story", handle: sessionStoryApp },
  { slug: "live-session", handle: liveSessionApp },
]

describe("builtin panel AppHandles — emit + loadAppHandle round trip", () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  for (const { slug, handle } of PANELS) {
    it(`${slug}: emits and reloads as a zero-agent, UI-carrying app`, async () => {
      const root = await mkdtemp(join(tmpdir(), `apps-builtin-panel-${slug}-`))
      dirs.push(root)

      await handle.emit(root)
      const loaded = await loadAppHandle(root)

      expect(loaded.agents).toEqual([])
      expect(loaded.id).toBe(handle.id)
      expect(loaded.ui?.html).toBe(handle.ui?.html)
      expect(loaded.ui?.title).toBe(handle.ui?.title)
    })
  }
})
