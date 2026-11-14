import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"
import {
  assertMastraCoreVersion,
  createAgentControllerHost,
  MIN_MASTRA_CORE_VERSION,
  UnsupportedMastraCoreError,
} from "../index.js"

describe("@mastra/core minimum version", () => {
  it("matches the peerDependency floor", () => {
    const pkg = createRequire(import.meta.url)("../../package.json") as {
      peerDependencies: Record<string, string>
    }
    expect(pkg.peerDependencies["@mastra/core"]).toBe(`>=${MIN_MASTRA_CORE_VERSION} <2`)
  })

  it("rejects an older install with a clear error", () => {
    expect(() => assertMastraCoreVersion("1.59.0")).toThrow(UnsupportedMastraCoreError)
    expect(() => assertMastraCoreVersion("1.59.9")).toThrow(/1\.60\.0 or newer/)
    expect(() => assertMastraCoreVersion("0.24.0")).toThrow(UnsupportedMastraCoreError)
  })

  it("accepts the floor and anything above it", () => {
    for (const v of ["1.60.0", "1.60.1", "1.66.0", "1.100.0", "2.0.0", "1.60.0-alpha.1"]) {
      expect(() => assertMastraCoreVersion(v)).not.toThrow()
    }
  })

  it("lets an unparseable version through", () => {
    expect(() => assertMastraCoreVersion("workspace")).not.toThrow()
  })

  it("createAgentControllerHost accepts the installed @mastra/core", () => {
    expect(() => createAgentControllerHost()).not.toThrow()
  })
})
