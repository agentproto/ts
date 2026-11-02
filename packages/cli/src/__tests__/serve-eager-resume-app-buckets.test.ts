/**
 * Boot cross-process gate for the eager resume / continue-interrupted passes
 * (serve.ts). A row is served by THIS daemon when its workspace bucket is the
 * served one OR when no OTHER live daemon serves that bucket.
 *
 * Regression: those passes used a strict `bucket === servedBucket` gate, so a
 * pinned `keepAlive` brain homed in an app bucket (`app-agentik-pygmalion`,
 * `~/.pygmalion`) that no other daemon serves stayed `daemon-restart`-dead
 * after a reboot until something prompted it. The sandbox re-attach pass
 * already used the correct rule.
 */

import { describe, expect, it } from "vitest"
import { runEagerResumePass, type SessionDescriptor } from "@agentproto/runtime"
import { makeIsServed } from "../commands/serve.js"

const registeredSlugs = new Set(["agentik-studio", "app-agentik-pygmalion"])

function daemonRestartRow(workspaceSlug: string): SessionDescriptor {
  return {
    id: `sess_${workspaceSlug}`,
    kind: "agent-cli",
    workspaceSlug,
    command: "claude --resume abc",
    pid: null,
    status: "exited",
    startedAt: "2026-11-01T00:00:00.000Z",
    lastActivityAt: "2026-11-01T00:10:00.000Z",
    lastTurnEndedAt: "2026-11-01T00:10:00.000Z",
    adapterSlug: "claude-code",
    adapterSessionId: "abc",
    cwd: "/tmp/pygmalion",
    archived: false,
    endedReason: "daemon-restart",
    keepAlive: true,
    pinned: true,
  } as SessionDescriptor
}

function registryFor(rows: SessionDescriptor[]): {
  resumed: string[]
  registry: {
    list: () => SessionDescriptor[]
    resumeOnBoot: (id: string) => Promise<{ status: "resumed" }>
  }
} {
  const resumed: string[] = []
  return {
    resumed,
    registry: {
      list: () => rows,
      resumeOnBoot: async (id: string) => {
        resumed.push(id)
        return { status: "resumed" as const }
      },
    },
  }
}

describe("makeIsServed", () => {
  const servedBucket = "agentik-studio"

  it("serves a row in an app bucket that no other live daemon serves", () => {
    const isServed = makeIsServed({
      registeredSlugs,
      servedBucket,
      otherLiveBuckets: new Set(),
    })
    expect(isServed(daemonRestartRow("app-agentik-pygmalion"))).toBe(true)
  })

  it("leaves a row in a bucket another live daemon serves", () => {
    const isServed = makeIsServed({
      registeredSlugs,
      servedBucket,
      otherLiveBuckets: new Set(["app-agentik-pygmalion"]),
    })
    expect(isServed(daemonRestartRow("app-agentik-pygmalion"))).toBe(false)
  })

  it("serves its own bucket even when a peer claims the same bucket, but leaves a peer-served app bucket", () => {
    const isServed = makeIsServed({
      registeredSlugs,
      servedBucket,
      otherLiveBuckets: new Set([servedBucket, "app-agentik-pygmalion"]),
    })
    expect(isServed(daemonRestartRow("agentik-studio"))).toBe(true)
    expect(isServed(daemonRestartRow("app-agentik-pygmalion"))).toBe(false)
  })

  it("serves an unregistered workspace pooled into default when nobody else serves it", () => {
    const isServed = makeIsServed({
      registeredSlugs,
      servedBucket,
      otherLiveBuckets: new Set(["default"]),
    })
    expect(isServed(daemonRestartRow("not-registered"))).toBe(false)
  })
})

describe("eager resume-on-boot with the boot gate", () => {
  it("resumes a keepAlive daemon-restart row in an app bucket nobody else serves", async () => {
    const { resumed, registry } = registryFor([daemonRestartRow("app-agentik-pygmalion")])
    const summary = await runEagerResumePass({
      registry,
      concurrency: 1,
      isServed: makeIsServed({
        registeredSlugs,
        servedBucket: "agentik-studio",
        otherLiveBuckets: new Set(),
      }),
    })
    expect(resumed).toEqual(["sess_app-agentik-pygmalion"])
    expect(summary.resumed).toBe(1)
  })

  it("does not resume that row when another live daemon serves its bucket", async () => {
    const { resumed, registry } = registryFor([daemonRestartRow("app-agentik-pygmalion")])
    const summary = await runEagerResumePass({
      registry,
      concurrency: 1,
      isServed: makeIsServed({
        registeredSlugs,
        servedBucket: "agentik-studio",
        otherLiveBuckets: new Set(["app-agentik-pygmalion"]),
      }),
    })
    expect(resumed).toEqual([])
    expect(summary.candidates).toBe(0)
  })
})
