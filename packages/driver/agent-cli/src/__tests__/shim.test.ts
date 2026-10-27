import { describe, expect, it } from "vitest"
import * as oldPackage from "../index.js"
import * as newPackage from "@agentproto/harness"
import * as oldManifest from "../manifest/index.js"
import * as newManifest from "@agentproto/harness/manifest"

describe("@agentproto/driver-agent-cli shim", () => {
  it("re-exports defineAgentCli as the harness defineHarness object", () => {
    expect(oldPackage.defineAgentCli).toBe(newPackage.defineHarness)
  })

  it("re-exports the manifest entry point unchanged", () => {
    expect(oldManifest.parseAgentCliManifest).toBe(newManifest.parseAgentCliManifest)
    expect(oldManifest.agentCliFromManifest).toBe(newManifest.agentCliFromManifest)
  })
})
