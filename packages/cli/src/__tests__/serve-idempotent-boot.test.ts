/**
 * `agentproto serve` idempotent boot (serve.ts). The `serve` command wires
 * `bootGatewayIdempotent` with a real `/health` probe + a real `createGateway`;
 * both are injected here so the decision logic is exercised without a socket:
 *
 *   - a healthy incumbent on the port → `peer-up`, boot never attempted (exit 0)
 *   - a clean bind → `booted`
 *   - EADDRINUSE from a racing serve, winner healthy → `peer-up` (exit 0)
 *   - EADDRINUSE, nobody healthy → `failed` (exit 1)
 *   - any other boot error → `failed` (exit 1)
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GatewayHandle } from "@agentproto/runtime"
import {
  bucketsServedByOtherLiveDaemons,
  writeDaemonRegistryEntry,
  resolveBucketSlug,
  type RuntimeMeta,
} from "@agentproto/runtime"
import { findWorkspaceByPath } from "@agentproto/runtime/workspaces-config"

describe("resolveBucketSlug", () => {
  it("the served workspace and the other-daemons bucketOf mapper derive the SAME bucket for a workspace missing from wsConfig", async () => {
    // The re-attach pass treats a detached row as stranded unless its
    // bucket is served by another live daemon. The comparison is only
    // sound if `servedBucket` (serve.ts) and the mapper feeding
    // `bucketsServedByOtherLiveDaemons` use the one identical rule:
    // findWorkspaceByPath(wsConfig, …)?.slug → resolveBucketSlug. For a
    // workspace missing from wsConfig BOTH sides must resolve the same
    // pooled bucket (`default`) — divergent values would let this daemon
    // "rescue" a row another live daemon actually still serves.
    const prevHome = process.env.HOME
    const home = await mkdtemp(join(tmpdir(), "agp-bucket-agree-"))
    process.env.HOME = home
    try {
      const wsConfig = { workspaces: [] } // nothing found by path
      const registeredSlugs = new Set<string>() // matches an empty registry read
      const missingWorkspace = "/not/registered"
      const bucketOf = (path: string): string =>
        resolveBucketSlug(findWorkspaceByPath(wsConfig, path)?.slug, registeredSlugs)

      // serve.ts derives its own bucket with the same two functions
      const servedBucket = bucketOf(missingWorkspace)
      // A live other-daemon registry entry pointing at that same
      // missing-from-wsConfig workspace, as bucketsServedByOtherLiveDaemons sees it
      await writeDaemonRegistryEntry({
        workspace: missingWorkspace,
        port: 19789,
        bind: "127.0.0.1",
        pid: process.pid,
        startedAt: "2026-10-18T00:00:00.000Z",
        name: "agentproto-runtime",
        registered: [],
        token: "tok-abc",
      } satisfies RuntimeMeta)
      const otherLive = await bucketsServedByOtherLiveDaemons(11111, bucketOf)
      // Same slug on both sides: the other daemon's entry lands in
      // exactly the bucket serve.ts would call its own.
      expect([...otherLive]).toEqual([servedBucket])
      expect(servedBucket).toBe("default")
    } finally {
      process.env.HOME = prevHome
      await rm(home, { recursive: true, force: true })
    }
  })
})

import {
  bootGatewayIdempotent,
  probeHealthyDaemon,
} from "../commands/serve.js"

const HEALTH_URL = "http://127.0.0.1:18790"
const fakeGateway = { url: HEALTH_URL } as unknown as GatewayHandle

function addrInUse(): NodeJS.ErrnoException {
  const err = new Error("listen EADDRINUSE: address already in use") as NodeJS.ErrnoException
  err.code = "EADDRINUSE"
  return err
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("bootGatewayIdempotent", () => {
  it("preflight-healthy incumbent → peer-up, never binds", async () => {
    const boot = vi.fn(async () => fakeGateway)
    const outcome = await bootGatewayIdempotent({
      healthUrl: HEALTH_URL,
      probe: async () => true,
      boot,
    })
    expect(outcome).toEqual({ kind: "peer-up", url: HEALTH_URL })
    expect(boot).not.toHaveBeenCalled()
  })

  it("no incumbent + clean bind → booted", async () => {
    const outcome = await bootGatewayIdempotent({
      healthUrl: HEALTH_URL,
      probe: async () => false,
      boot: async () => fakeGateway,
    })
    expect(outcome.kind).toBe("booted")
    if (outcome.kind === "booted") expect(outcome.gateway).toBe(fakeGateway)
  })

  it("EADDRINUSE race, winner is healthy → peer-up (defer, exit 0)", async () => {
    // First probe (preflight) sees nothing; the racing serve wins the bind;
    // the re-probe after EADDRINUSE finds the winner healthy.
    const probe = vi
      .fn<(url: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const outcome = await bootGatewayIdempotent({
      healthUrl: HEALTH_URL,
      probe,
      boot: async () => {
        throw addrInUse()
      },
    })
    expect(outcome).toEqual({ kind: "peer-up", url: HEALTH_URL })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it("EADDRINUSE but nobody healthy on re-probe → failed (exit 1)", async () => {
    const outcome = await bootGatewayIdempotent({
      healthUrl: HEALTH_URL,
      probe: async () => false,
      boot: async () => {
        throw addrInUse()
      },
    })
    expect(outcome.kind).toBe("failed")
  })

  it("non-EADDRINUSE boot error → failed, no re-probe", async () => {
    const probe = vi.fn(async () => false)
    const outcome = await bootGatewayIdempotent({
      healthUrl: HEALTH_URL,
      probe,
      boot: async () => {
        throw new Error("workspace dir does not exist")
      },
    })
    expect(outcome.kind).toBe("failed")
    if (outcome.kind === "failed") {
      expect(outcome.message).toContain("workspace dir does not exist")
    }
    // Only the preflight probe ran — a generic failure is not a bind race.
    expect(probe).toHaveBeenCalledTimes(1)
  })
})

describe("probeHealthyDaemon", () => {
  it("returns true when /health answers 2xx", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }))
    expect(await probeHealthyDaemon(HEALTH_URL)).toBe(true)
    expect(fetchSpy).toHaveBeenCalledWith(
      `${HEALTH_URL}/health`,
      expect.objectContaining({ signal: expect.anything() }),
    )
  })

  it("returns false on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 503 }),
    )
    expect(await probeHealthyDaemon(HEALTH_URL)).toBe(false)
  })

  it("returns false when the connection is refused / times out", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("ECONNREFUSED"),
    )
    expect(await probeHealthyDaemon(HEALTH_URL)).toBe(false)
  })
})
