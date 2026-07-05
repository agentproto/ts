import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TunnelRegistry, type TunnelDescriptor } from "../tunnel-registry.js"
import type { RemoteProvider, ProviderStartOptions } from "../remote-providers/types.js"

/**
 * Build a mock RemoteProvider. `startUrl` is the publicUrl it resolves with.
 * Pass `failStart: true` to make start() reject.
 */
function makeMockProvider(opts: {
  startUrl?: string
  failStart?: boolean
} = {}): RemoteProvider & {
  startCalled: number
  stopCalled: number
} {
  let startCalled = 0
  let stopCalled = 0

  return {
    id: "quick",
    startCalled: 0,
    stopCalled: 0,
    async start(_opts: ProviderStartOptions) {
      startCalled++
      ;(this as { startCalled: number }).startCalled = startCalled
      if (opts.failStart) throw new Error("mock start failure")
      return { publicUrl: opts.startUrl ?? "https://test.trycloudflare.com", pid: 12345 }
    },
    async stop() {
      stopCalled++
      ;(this as { stopCalled: number }).stopCalled = stopCalled
    },
  }
}

/**
 * Build a TunnelRegistry wired with a mock provider factory so no real
 * cloudflared binary is needed.
 */
function makeRegistry(tmp: string, providerOverride?: RemoteProvider) {
  const persistPath = join(tmp, "tunnels.json")
  // Monkey-patch the private factory via a subclass trick is brittle;
  // instead we use dependency-inversion via the `_providerFactory` seam
  // we'll add to TunnelRegistry for tests. Since TunnelRegistry is in
  // our own package we can test it with a lighter approach: export the
  // factory type and accept it as an option in a test-only constructor
  // parameter. We use a local wrapper here to keep production code clean.
  const reg = new (class extends TunnelRegistry {
    protected override async pickProviderForTest(): Promise<RemoteProvider> {
      return providerOverride ?? makeMockProvider()
    }
  })({ persistPath, workspace: tmp })
  return { reg, persistPath }
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function createOne(
  reg: TunnelRegistry,
  opts: { targetPort?: number; name?: string } = {},
): Promise<TunnelDescriptor> {
  return reg.create({
    targetPort: opts.targetPort ?? 3000,
    ...(opts.name ? { name: opts.name } : {}),
  })
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("TunnelRegistry", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tunnel-reg-test-"))
    // Prevent real cloudflared from being invoked — the tests use mock providers
    // injected via the subclass seam, but assertCloudflaredOnPath is called
    // inside quickTunnelProvider.start(); we never reach that path in tests
    // since the mock overrides start().
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  // ── create ──────────────────────────────────────────────────────────────────

  it("create returns a descriptor with active status and public URL", async () => {
    const mock = makeMockProvider({ startUrl: "https://abc.trycloudflare.com" })
    const { reg } = makeRegistry(tmp, mock)

    const desc = await reg.create({ targetPort: 4000 })

    expect(desc.status).toBe("active")
    expect(desc.publicUrl).toBe("https://abc.trycloudflare.com")
    expect(desc.targetPort).toBe(4000)
    expect(desc.targetHost).toBe("127.0.0.1")
    expect(desc.pid).toBe(12345)
    expect(desc.provider).toBe("quick")
    expect(desc.id).toBeTruthy()
    expect(desc.createdAt).toBeTruthy()
  })

  it("create stores descriptor in the registry", async () => {
    const { reg } = makeRegistry(tmp)
    const desc = await createOne(reg)

    const fetched = reg.get(desc.id)
    expect(fetched).toBeDefined()
    expect(fetched?.id).toBe(desc.id)
  })

  it("create with name stores the friendly slug", async () => {
    const { reg } = makeRegistry(tmp)
    const desc = await createOne(reg, { name: "my-service" })

    expect(desc.name).toBe("my-service")
  })

  it("create rejects duplicate active name", async () => {
    const { reg } = makeRegistry(tmp)
    await createOne(reg, { name: "conflict" })

    await expect(createOne(reg, { name: "conflict" })).rejects.toThrow(
      /already in use/,
    )
  })

  it("create marks descriptor as error when provider start() throws", async () => {
    const mock = makeMockProvider({ failStart: true })
    const { reg } = makeRegistry(tmp, mock)

    await expect(reg.create({ targetPort: 9999 })).rejects.toThrow("mock start failure")

    // The errored descriptor should still be in the registry
    const list = reg.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.status).toBe("error")
    expect(list[0]?.lastError).toContain("mock start failure")
  })

  // ── list ─────────────────────────────────────────────────────────────────────

  it("list returns all descriptors", async () => {
    const { reg } = makeRegistry(tmp)
    await createOne(reg, { targetPort: 3000 })
    await createOne(reg, { targetPort: 4000 })

    const list = reg.list()
    expect(list).toHaveLength(2)
    expect(list.map(t => t.targetPort)).toEqual(expect.arrayContaining([3000, 4000]))
  })

  it("list returns copies — mutation does not affect registry", async () => {
    const { reg } = makeRegistry(tmp)
    const desc = await createOne(reg)

    const list = reg.list()
    ;(list[0] as TunnelDescriptor).status = "stopped"

    // Registry-internal copy untouched
    expect(reg.get(desc.id)?.status).toBe("active")
  })

  // ── get / findByIdOrName ─────────────────────────────────────────────────────

  it("get returns undefined for unknown id", () => {
    const { reg } = makeRegistry(tmp)
    expect(reg.get("no-such-id")).toBeUndefined()
  })

  it("findByIdOrName resolves by id", async () => {
    const { reg } = makeRegistry(tmp)
    const desc = await createOne(reg)

    const found = reg.findByIdOrName(desc.id)
    expect(found?.id).toBe(desc.id)
  })

  it("findByIdOrName resolves by name", async () => {
    const { reg } = makeRegistry(tmp)
    const desc = await createOne(reg, { name: "vite-preview" })

    const found = reg.findByIdOrName("vite-preview")
    expect(found?.id).toBe(desc.id)
  })

  it("findByIdOrName returns undefined for unknown name", () => {
    const { reg } = makeRegistry(tmp)
    expect(reg.findByIdOrName("no-such-name")).toBeUndefined()
  })

  // ── stop ─────────────────────────────────────────────────────────────────────

  it("stop marks descriptor as stopped", async () => {
    const { reg } = makeRegistry(tmp)
    const desc = await createOne(reg)

    const ok = await reg.stop(desc.id)

    expect(ok).toBe(true)
    expect(reg.get(desc.id)?.status).toBe("stopped")
    expect(reg.get(desc.id)?.stoppedAt).toBeTruthy()
  })

  it("stop by name works", async () => {
    const { reg } = makeRegistry(tmp)
    const desc = await createOne(reg, { name: "my-tunnel" })

    const ok = await reg.stop("my-tunnel")

    expect(ok).toBe(true)
    expect(reg.get(desc.id)?.status).toBe("stopped")
  })

  it("stop returns false for unknown id", async () => {
    const { reg } = makeRegistry(tmp)
    const ok = await reg.stop("no-such-id")
    expect(ok).toBe(false)
  })

  it("stop is idempotent on already-stopped tunnel", async () => {
    const { reg } = makeRegistry(tmp)
    const desc = await createOne(reg)

    await reg.stop(desc.id)
    const ok = await reg.stop(desc.id)

    expect(ok).toBe(true)
    expect(reg.get(desc.id)?.status).toBe("stopped")
  })

  // ── shutdown ──────────────────────────────────────────────────────────────────

  it("shutdown stops all active tunnels", async () => {
    const { reg } = makeRegistry(tmp)
    const a = await createOne(reg, { targetPort: 3000 })
    const b = await createOne(reg, { targetPort: 4000 })

    await reg.shutdown()

    expect(reg.get(a.id)?.status).toBe("stopped")
    expect(reg.get(b.id)?.status).toBe("stopped")
  })

  // ── persistence / GHOST on reload ────────────────────────────────────────────

  it("loads historical descriptors from tunnels.json on boot", () => {
    const persistPath = join(tmp, "tunnels.json")
    writeFileSync(
      persistPath,
      JSON.stringify({
        savedAt: "2026-01-01T00:00:00Z",
        tunnels: [
          {
            id: "tun_aaaaaaaa",
            provider: "quick",
            targetHost: "127.0.0.1",
            targetPort: 3000,
            publicUrl: "https://old.trycloudflare.com",
            status: "stopped",
            pid: null,
            createdAt: "2026-01-01T00:00:00Z",
            stoppedAt: "2026-01-01T01:00:00Z",
          },
        ],
      }),
    )

    const { reg } = makeRegistry(tmp)
    const list = reg.list()

    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe("tun_aaaaaaaa")
    expect(list[0]?.status).toBe("stopped")
  })

  it("marks formerly-active tunnels as stopped on reload (GHOST pattern)", () => {
    const persistPath = join(tmp, "tunnels.json")
    writeFileSync(
      persistPath,
      JSON.stringify({
        savedAt: "2026-01-01T00:00:00Z",
        tunnels: [
          {
            id: "tun_bbbbbbbb",
            provider: "quick",
            targetHost: "127.0.0.1",
            targetPort: 5000,
            publicUrl: "https://ghost.trycloudflare.com",
            status: "active",
            pid: 99999,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    )

    const { reg } = makeRegistry(tmp)
    const desc = reg.findByIdOrName("tun_bbbbbbbb")

    expect(desc).toBeDefined()
    expect(desc?.status).toBe("stopped")
    expect(desc?.pid).toBeNull()
    expect(desc?.stoppedAt).toBeTruthy()
  })

  it("marks formerly-starting tunnels as stopped on reload", () => {
    const persistPath = join(tmp, "tunnels.json")
    writeFileSync(
      persistPath,
      JSON.stringify({
        savedAt: "2026-01-01T00:00:00Z",
        tunnels: [
          {
            id: "tun_cccccccc",
            provider: "quick",
            targetHost: "127.0.0.1",
            targetPort: 6000,
            publicUrl: "",
            status: "starting",
            pid: null,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    )

    const { reg } = makeRegistry(tmp)
    const desc = reg.get("tun_cccccccc")
    expect(desc?.status).toBe("stopped")
  })

  it("persists tunnels.json after create", async () => {
    const persistPath = join(tmp, "tunnels.json")
    const { reg } = makeRegistry(tmp)

    await createOne(reg)

    // Wait for the debounced write (1.5s) — flush immediately via shutdown
    await reg.shutdown()

    expect(existsSync(persistPath)).toBe(true)
    const raw = JSON.parse(
      require("fs").readFileSync(persistPath, "utf8"),
    ) as { tunnels: TunnelDescriptor[] }
    expect(raw.tunnels).toHaveLength(1)
  })

  // ── named provider + autostart ───────────────────────────────────────────────

  it("create with provider named requires hostname and tunnelId", async () => {
    const { reg } = makeRegistry(tmp)
    await expect(
      reg.create({ targetPort: 3040, provider: "named" }),
    ).rejects.toThrow(/requires both "hostname" and "tunnelId"/)
    await expect(
      reg.create({ targetPort: 3040, provider: "named", hostname: "h.example.com" }),
    ).rejects.toThrow(/requires both "hostname" and "tunnelId"/)
  })

  it("create named stores hostname/tunnelId/autostart on the descriptor", async () => {
    const { reg } = makeRegistry(tmp)
    const desc = await reg.create({
      targetPort: 3040,
      provider: "named",
      hostname: "guilde-local.example.com",
      tunnelId: "guilde",
      autostart: true,
    })

    expect(desc.provider).toBe("named")
    expect(desc.hostname).toBe("guilde-local.example.com")
    expect(desc.tunnelId).toBe("guilde")
    expect(desc.autostart).toBe(true)
    expect(desc.status).toBe("active")
  })

  it("restoreOnBoot relaunches a ghosted autostart named tunnel", async () => {
    const persistPath = join(tmp, "tunnels.json")
    writeFileSync(
      persistPath,
      JSON.stringify({
        savedAt: "2026-01-01T00:00:00Z",
        tunnels: [
          {
            id: "tun_named",
            name: "guilde",
            provider: "named",
            targetHost: "127.0.0.1",
            targetPort: 3040,
            publicUrl: "https://guilde-local.example.com",
            status: "active",
            pid: 4242,
            createdAt: "2026-01-01T00:00:00Z",
            autostart: true,
            hostname: "guilde-local.example.com",
            tunnelId: "guilde",
          },
        ],
      }),
    )

    const mock = makeMockProvider({ startUrl: "https://guilde-local.example.com" })
    const { reg } = makeRegistry(tmp, mock)

    // Ghosted to stopped on load…
    expect(reg.get("tun_named")?.status).toBe("stopped")

    await reg.restoreOnBoot()

    expect(reg.get("tun_named")?.status).toBe("active")
    expect(reg.get("tun_named")?.publicUrl).toBe("https://guilde-local.example.com")
    expect(mock.startCalled).toBe(1)
  })

  it("restoreOnBoot skips quick tunnels (would get a new URL)", async () => {
    const persistPath = join(tmp, "tunnels.json")
    writeFileSync(
      persistPath,
      JSON.stringify({
        savedAt: "2026-01-01T00:00:00Z",
        tunnels: [
          {
            id: "tun_quick_auto",
            provider: "quick",
            targetHost: "127.0.0.1",
            targetPort: 3000,
            publicUrl: "https://old.trycloudflare.com",
            status: "active",
            pid: 9999,
            createdAt: "2026-01-01T00:00:00Z",
            autostart: true,
          },
        ],
      }),
    )

    const mock = makeMockProvider()
    const { reg } = makeRegistry(tmp, mock)

    await reg.restoreOnBoot()

    // Quick autostart is intentionally not relaunched.
    expect(reg.get("tun_quick_auto")?.status).toBe("stopped")
    expect(mock.startCalled).toBe(0)
  })

  it("restoreOnBoot leaves non-autostart tunnels stopped", async () => {
    const persistPath = join(tmp, "tunnels.json")
    writeFileSync(
      persistPath,
      JSON.stringify({
        savedAt: "2026-01-01T00:00:00Z",
        tunnels: [
          {
            id: "tun_no_auto",
            provider: "named",
            targetHost: "127.0.0.1",
            targetPort: 3040,
            publicUrl: "https://h.example.com",
            status: "active",
            pid: 1,
            createdAt: "2026-01-01T00:00:00Z",
            hostname: "h.example.com",
            tunnelId: "h",
          },
        ],
      }),
    )

    const mock = makeMockProvider()
    const { reg } = makeRegistry(tmp, mock)

    await reg.restoreOnBoot()

    expect(reg.get("tun_no_auto")?.status).toBe("stopped")
    expect(mock.startCalled).toBe(0)
  })
})

// ── credsForDescriptor: named-tunnel credentialsFile shadowing ────────────────

/** Test subclass exposing the protected creds merge for direct assertion. */
class CredsProbeRegistry extends TunnelRegistry {
  async probe(desc: TunnelDescriptor): Promise<Record<string, string>> {
    return this.credsForDescriptor(desc)
  }
}

function namedDesc(
  overrides: Partial<TunnelDescriptor>,
): TunnelDescriptor {
  return {
    id: "tun_x",
    provider: "cloudflare-named",
    targetHost: "127.0.0.1",
    targetPort: 18790,
    publicUrl: "",
    status: "starting",
    pid: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

describe("TunnelRegistry.credsForDescriptor — named credentialsFile", () => {
  // Provider-level default captured at setup_tunnel_provider time (e.g. a
  // different service's named tunnel — the postiz-vs-agentproto trap).
  const stored = {
    hostname: "postiz.example.com",
    tunnelId: "STORED-ID",
    credentialsFile: "/creds/STORED-ID.json",
  }
  const reg = new CredsProbeRegistry({
    readCreds: async () => stored,
  })

  it("drops the stored credentialsFile when the descriptor targets a different tunnelId with no explicit creds", async () => {
    const creds = await reg.probe(
      namedDesc({ hostname: "other.example.com", tunnelId: "OTHER-ID" }),
    )
    expect(creds.tunnelId).toBe("OTHER-ID")
    // → provider falls back to ~/.cloudflared/OTHER-ID.json
    expect(creds.credentialsFile).toBeUndefined()
  })

  it("keeps the stored credentialsFile when the descriptor targets the same tunnelId (single-tunnel BYO)", async () => {
    const creds = await reg.probe(namedDesc({ tunnelId: "STORED-ID" }))
    expect(creds.tunnelId).toBe("STORED-ID")
    expect(creds.credentialsFile).toBe("/creds/STORED-ID.json")
  })

  it("honors an explicit descriptor credentialsFile even on a different tunnelId", async () => {
    const creds = await reg.probe(
      namedDesc({
        tunnelId: "OTHER-ID",
        credentialsFile: "/creds/OTHER-ID.json",
      }),
    )
    expect(creds.tunnelId).toBe("OTHER-ID")
    expect(creds.credentialsFile).toBe("/creds/OTHER-ID.json")
  })
})
