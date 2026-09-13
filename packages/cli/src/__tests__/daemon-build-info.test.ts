/**
 * `renderBuild` — the shared " (source, sha, built …)" suffix `daemon
 * start`/`status` append to the version line. The point of the field is
 * legibility of WHICH build a daemon runs (workspace dist vs published
 * tarball report the same version string), so the rendering must degrade
 * cleanly for daemons predating the field and for builds outside git.
 */

import { describe, it, expect } from "vitest"

import { renderBuild } from "../commands/daemon.js"

describe("renderBuild", () => {
  it("renders source, sha, and builtAt when all present", () => {
    expect(
      renderBuild({ sha: "abc1234", builtAt: "2026-08-14T12:00:00.000Z", source: "workspace" }),
    ).toBe(" (workspace, abc1234, built 2026-08-14T12:00:00.000Z)")
  })

  it("omits an empty sha (build ran outside git)", () => {
    expect(
      renderBuild({ sha: "", builtAt: "2026-08-14T12:00:00.000Z", source: "published" }),
    ).toBe(" (published, built 2026-08-14T12:00:00.000Z)")
  })

  it("is empty for a daemon predating the field", () => {
    expect(renderBuild(undefined)).toBe("")
    expect(renderBuild(null)).toBe("")
  })

  it("is empty when the object carries nothing renderable", () => {
    expect(renderBuild({})).toBe("")
    expect(renderBuild({ sha: "" })).toBe("")
  })
})
