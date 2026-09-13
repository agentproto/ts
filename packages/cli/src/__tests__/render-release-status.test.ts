/**
 * `renderReleaseStatus` — the `release:` fold in `agentproto daemon status`
 * (WP-C). Pure given an injected check runner, so we can assert the mapping
 * from a decided release state to the human status line without a daemon,
 * a home dir, or the network.
 */

import { describe, expect, it } from "vitest"

import { renderReleaseStatus } from "../commands/daemon.js"

/** A fake check runner returning the state we want to render. */
function withState(state: "current" | "behind" | "unknown" | "workspace", latest: string | null) {
  return async () => ({ state, latest, fromCache: false, localVersion: "0.14.0" })
}

describe("renderReleaseStatus", () => {
  it("renders 'up to date' for a current tarball", async () => {
    const s = await renderReleaseStatus("0.14.0", "tarball", withState("current", "0.14.0"))
    expect(s).toBe("up to date")
  })

  it("renders 'v<latest> available' when behind", async () => {
    const s = await renderReleaseStatus("0.14.0", "tarball", withState("behind", "0.15.0"))
    expect(s).toBe("v0.15.0 available")
  })

  it("renders 'unknown' when the check is unknown (offline-safe)", async () => {
    const s = await renderReleaseStatus("0.14.0", "tarball", withState("unknown", null))
    expect(s).toBe("unknown")
  })

  it("renders 'up to date' for a workspace build at the published version", async () => {
    const s = await renderReleaseStatus("0.15.0", "workspace", withState("workspace", "0.15.0"))
    expect(s).toBe("up to date")
  })

  it("renders 'v<latest> available' for a workspace build behind", async () => {
    const s = await renderReleaseStatus("0.14.0", "workspace", withState("workspace", "0.15.0"))
    expect(s).toBe("v0.15.0 available")
  })

  it("renders 'unknown' when there is no local version", async () => {
    const s = await renderReleaseStatus(null, "tarball", withState("unknown", null))
    expect(s).toBe("unknown")
  })

  it("renders 'up to date' when a workspace build is ahead of npm (local-only work)", async () => {
    const s = await renderReleaseStatus("0.16.0", "workspace", withState("workspace", "0.15.0"))
    expect(s).toBe("up to date")
  })
})