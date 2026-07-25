/**
 * D5 — the daemon must not report a self-contradictory view of an endpoint it
 * does not own.
 *
 * Observed on a real host: port 18090 is held by a launchd KeepAlive service
 * (`com.agentik.llm-endpoint`), so the daemon's own spawn dies with
 * EADDRINUSE and records `status:"error"` — while the health probe, which runs
 * regardless of our spawn's fate, happily answers against that OTHER, perfectly
 * healthy process. The status report then claimed `running:false` AND
 * `healthy:true` at once, with an empty provider list, which is what rendered
 * the LLM-endpoint panel blank even though the proxy was fully credentialed and
 * serving.
 *
 * The fix ADOPTS instead of reporting our failed spawn as the whole truth.
 * These tests pin the two halves: the contradiction is gone, and an adopted
 * endpoint is labelled honestly (owner "external", pid unknown, links NOT
 * applied — persisted upstream links reach only a child WE spawn).
 */
import { describe, it, expect } from "vitest"
import { LlmEndpointRegistry } from "../llm-endpoint-registry.js"

/** Drives the state machine through the documented test seams: `launch`
 *  fails exactly as a port collision does, `probeHealth` answers for the
 *  foreign process already on the port. */
class CollidingRegistry extends LlmEndpointRegistry {
  constructor(private readonly served: string[] = []) {
    super({ binPath: process.execPath })
  }
  protected override async launch(): Promise<never> {
    throw new Error("listen EADDRINUSE: address already in use :::18090")
  }
  protected override async probeHealth(): Promise<boolean> {
    return true
  }
  protected override async probeModels(): Promise<string[]> {
    return this.served
  }
}

/** Nothing on the port and nothing of ours running. */
class DeadRegistry extends LlmEndpointRegistry {
  constructor() {
    super({ binPath: process.execPath })
  }
  protected override async launch(): Promise<never> {
    throw new Error("listen EADDRINUSE: address already in use :::18090")
  }
  protected override async probeHealth(): Promise<boolean> {
    return false
  }
}

describe("LlmEndpointRegistry.status — D5 external adoption", () => {
  it("never reports running:false together with healthy:true", async () => {
    const reg = new CollidingRegistry()
    await reg.start({ port: 18090 }).catch(() => undefined)
    const status = await reg.status()
    // The exact contradiction the bug produced.
    expect(status.running && !status.healthy ? false : !(status.running === false && status.healthy === true)).toBe(true)
    expect({ running: status.running, healthy: status.healthy }).not.toEqual({ running: false, healthy: true })
  })

  it("adopts a healthy endpoint the daemon did NOT spawn: owner external, pid null, links not applied", async () => {
    const reg = new CollidingRegistry(["moonshot", "openrouter"])
    await reg.start({ port: 18090 }).catch(() => undefined)
    const status = await reg.status()
    expect(status.running).toBe(true)
    expect(status.healthy).toBe(true)
    expect(status.owner).toBe("external")
    // Not ours ⇒ we cannot know its pid, and our persisted upstream links were
    // never injected into its env.
    expect(status.pid).toBeNull()
    expect(status.linksApplied).toBe(false)
    // Providers are DERIVED by probing the foreign process, not read off our
    // own injection bookkeeping (which is meaningless here).
    expect(status.injectedProviders).toEqual(["moonshot", "openrouter"])
  })

  it("a failed spawn with nothing on the port stays honestly down (owner daemon)", async () => {
    const reg = new DeadRegistry()
    await reg.start({ port: 18090 }).catch(() => undefined)
    const status = await reg.status()
    expect(status.running).toBe(false)
    expect(status.healthy).toBe(false)
    expect(status.owner).toBe("daemon")
    expect(status.linksApplied).toBe(false)
  })
})
