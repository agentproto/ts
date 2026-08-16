import { describe, expect, it } from "vitest"

import {
  buildReleaseBarText,
  buildReleaseBarTooltip,
  releaseBarIcon,
  type ReleaseBarInput,
} from "./statusBarRelease.logic.js"

function input(over: Partial<ReleaseBarInput> = {}): ReleaseBarInput {
  return {
    state: "current",
    localVersion: "0.14.0",
    latest: "0.14.0",
    extensionVersion: "0.10.0",
    build: { source: "workspace", sha: "dde599ed", builtAt: "2026-08-16T19:31:31.871Z" },
    ...over,
  }
}

describe("releaseBarIcon", () => {
  it("maps behind → arrow-up, current → check, workspace → tools", () => {
    expect(releaseBarIcon("behind")).toBe("arrow-up")
    expect(releaseBarIcon("current")).toBe("check")
    expect(releaseBarIcon("workspace")).toBe("tools")
  })
  it("returns null for unknown (nothing painted)", () => {
    expect(releaseBarIcon("unknown")).toBeNull()
  })
})

describe("buildReleaseBarText", () => {
  it("discreet when current", () => {
    expect(buildReleaseBarText(input())).toBe("v0.14.0")
  })
  it("announces an available update when behind", () => {
    expect(buildReleaseBarText(input({ state: "behind", latest: "0.15.0" }))).toBe("update v0.15.0 dispo")
  })
  it("shows nothing when behind but latest unknown", () => {
    expect(buildReleaseBarText(input({ state: "behind", latest: null }))).toBeNull()
  })
  it("frames a workspace build as a rebuild", () => {
    expect(buildReleaseBarText(input({ state: "workspace" }))).toBe("v0.14.0 rebuild")
  })
  it("paints nothing for unknown", () => {
    expect(buildReleaseBarText(input({ state: "unknown" }))).toBeNull()
  })
})

describe("buildReleaseBarTooltip", () => {
  it("lists the versions and build for a current tarball", () => {
    const tip = buildReleaseBarTooltip(
      input({ state: "current", build: { source: "tarball", sha: "abc123", builtAt: "2026-08-16T00:00:00.000Z" } }),
    )
    expect(tip).toContain("Local CLI: **0.14.0**")
    expect(tip).toContain("Daemon build: tarball · abc123 · built 2026-08-16T00:00:00.000Z")
    expect(tip).toContain("Extension: v0.10.0")
    expect(tip).toContain("Click to check daemon health.")
  })

  it("announces the available version when behind", () => {
    const tip = buildReleaseBarTooltip(input({ state: "behind", latest: "0.15.0" }))
    expect(tip).toContain("A newer release is available: **v0.15.0**")
  })

  it("says the update is a rebuild for a workspace build", () => {
    const tip = buildReleaseBarTooltip(input({ state: "workspace", latest: "0.15.0" }))
    expect(tip).toContain("Latest published: **v0.15.0**")
    expect(tip).toContain("git pull")
  })

  it("tolerates a missing extension version and build", () => {
    const tip = buildReleaseBarTooltip(
      input({ extensionVersion: null, build: null, state: "current" }),
    )
    expect(tip).toContain("Local CLI: **0.14.0**")
    expect(tip).not.toContain("Extension:")
    expect(tip).not.toContain("Daemon build:")
  })

  it("still shows the local version when unknown", () => {
    const tip = buildReleaseBarTooltip(input({ state: "unknown" }))
    expect(tip).toContain("Local CLI: **0.14.0**")
  })
})