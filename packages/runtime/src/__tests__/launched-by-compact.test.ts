/**
 * `session_list`'s compact row carries the derived `launchedBy` text: present
 * when any provenance field is set, and ABSENT (not `undefined`) when none is,
 * so the compact shape stays byte-for-byte the old one for root sessions.
 */

import { describe, it, expect } from "vitest"
import { compactSessionItem } from "../session-tools.js"
import type { SessionDescriptor } from "../sessions.js"

const base: SessionDescriptor = {
  id: "sess_child",
  kind: "agent-cli",
  workspaceSlug: "default",
  command: "claude-code",
  pid: 1,
  status: "running",
  startedAt: "2026-01-01T00:00:00Z",
}

describe("compactSessionItem launchedBy", () => {
  it("carries the derived text for a child session", () => {
    expect(compactSessionItem({ ...base, parentSessionId: "sess_parent", origin: "pygmalion" })).toMatchObject({
      launchedBy: "session sess_parent via pygmalion",
    })
  })

  it("carries the origin text when only origin is set", () => {
    expect(compactSessionItem({ ...base, origin: "cron" }).launchedBy).toBe("cron")
  })

  it("omits the key when no provenance field is set", () => {
    expect(compactSessionItem(base)).not.toHaveProperty("launchedBy")
  })

  it("omits the key when every provenance field is an empty string", () => {
    expect(
      compactSessionItem({ ...base, parentSessionId: "", callerSessionId: "", operatorLabel: "", origin: "" }),
    ).not.toHaveProperty("launchedBy")
  })
})
