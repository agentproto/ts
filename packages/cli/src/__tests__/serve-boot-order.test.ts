/**
 * Boot order contract: reaction receipt reconciliation runs after sandbox
 * reattach and before the eager resume pass.
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("serve.ts boot order", () => {
  it("runs reattach, then reaction reconciliation, then eager resume", () => {
    const text = readFileSync(new URL("../commands/serve.ts", import.meta.url), "utf8")
    const reattach = text.indexOf("reattachSandboxSessionsOnBoot(")
    const reconcile = text.indexOf("reconcileReactionsOnBoot(")
    const resume = text.indexOf("resumeSessionsOnBoot(")
    expect(reattach).toBeGreaterThan(-1)
    expect(reconcile).toBeGreaterThan(-1)
    expect(resume).toBeGreaterThan(-1)
    expect(reattach).toBeLessThan(reconcile)
    expect(reconcile).toBeLessThan(resume)
  })
})
