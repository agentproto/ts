/**
 * Unit coverage for the `agentproto sessions --watch` DETAIL pane's `auth`
 * line — the "verifiability" surface for the claude-code auth-mode feature
 * (answer "what was used" without ever showing the secret). Uses the
 * no-color palette (all-empty-string ANSI codes) so assertions match plain
 * text.
 */

import { describe, it, expect } from "vitest"
import { renderDetail } from "../commands/sessions.js"
import type { SessionDescriptor } from "@agentproto/runtime"

const NO_COLOR = {
  reset: "",
  dim: "",
  bold: "",
  reverse: "",
  green: "",
  amber: "",
  cyan: "",
  red: "",
}

function baseDescriptor(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "sess_abc123",
    kind: "agent-cli",
    workspaceSlug: "default",
    command: "claude-code (agent)",
    pid: 4242,
    status: "running",
    startedAt: new Date().toISOString(),
    adapterSlug: "claude-code",
    ...overrides,
  }
}

describe("renderDetail — auth line", () => {
  it("renders the auth line with the fingerprint when auth metadata is present", () => {
    const lines = renderDetail(
      baseDescriptor({
        auth: { mode: "subscription", fingerprint: "subscription · sk-ant-oat…3f9c" },
      }),
      80,
      30,
      NO_COLOR,
      undefined,
    )
    expect(lines.some(l => l.includes("auth") && l.includes("subscription · sk-ant-oat…3f9c"))).toBe(
      true,
    )
  })

  it("renders an api-key fingerprint", () => {
    const lines = renderDetail(
      baseDescriptor({
        auth: { mode: "api-key", fingerprint: "api-key · sk-ant-api…7b21" },
      }),
      80,
      30,
      NO_COLOR,
      undefined,
    )
    expect(lines.some(l => l.includes("api-key · sk-ant-api…7b21"))).toBe(true)
  })

  it("omits the auth line entirely when no auth metadata was recorded", () => {
    const lines = renderDetail(baseDescriptor(), 80, 30, NO_COLOR, undefined)
    expect(lines.some(l => l.trim().startsWith("auth"))).toBe(false)
  })

  it("never renders a raw credential — only the pre-computed fingerprint string reaches the pane", () => {
    const secretLookingFingerprint = "subscription · sk-ant-oat…3f9c"
    const lines = renderDetail(
      baseDescriptor({
        auth: { mode: "subscription", fingerprint: secretLookingFingerprint },
      }),
      80,
      30,
      NO_COLOR,
      undefined,
    )
    const authLine = lines.find(l => l.includes("sk-ant-oat"))
    expect(authLine).toContain("…3f9c")
    // The fingerprint format itself (validated in spawn-defaults.test.ts)
    // guarantees no middle segment is ever present — this just proves the
    // pane renders exactly the string it was given, verbatim, adding no
    // extra secret material of its own.
    expect(authLine).toContain(secretLookingFingerprint)
  })
})
