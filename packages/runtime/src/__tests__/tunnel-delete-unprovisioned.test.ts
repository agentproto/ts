import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { TunnelRegistry, type TunnelDescriptor } from "../tunnel-registry.js"
import { cloudflareProvisionedTunnelProvider } from "../remote-providers/cloudflare-provisioned.js"
import type { FetchLike } from "../remote-providers/cloudflare-api.js"

let tmp: string
const live: TunnelRegistry[] = []

function descriptor(overrides: Partial<TunnelDescriptor> = {}): TunnelDescriptor {
  return {
    id: "stuck-tunnel-id",
    name: "stuck",
    provider: "cloudflare-provisioned",
    targetHost: "127.0.0.1",
    targetPort: 8081,
    publicUrl: "",
    status: "error",
    pid: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    lastError:
      "cloudflare-provisioned is not configured: run setup_tunnel_provider with provisionerUrl",
    ...overrides,
  }
}

function registryWith(desc: TunnelDescriptor): TunnelRegistry {
  const persistPath = join(tmp, "tunnels.json")
  writeFileSync(
    persistPath,
    JSON.stringify({ savedAt: "2026-11-01T00:00:00.000Z", tunnels: [desc] }),
    "utf8",
  )
  const reg = new TunnelRegistry({
    persistPath,
    workspace: tmp,
    readCreds: async () => null,
  })
  live.push(reg)
  return reg
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tunnel-delete-unprovisioned-"))
})

afterEach(async () => {
  await Promise.all(live.splice(0).map(r => r.shutdown()))
  rmSync(tmp, { recursive: true, force: true })
})

describe("tunnel_delete with an unconfigured cloudflare-provisioned provider", () => {
  it("forgets a record that was never provisioned remotely, with no network call", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new Error("unexpected network call")
    })
    const provider = cloudflareProvisionedTunnelProvider(null, { fetch: fetchImpl })

    await expect(
      provider.destroy!({ key: "stuck-tunnel-id", hostnames: [] }),
    ).resolves.toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("refuses to forget a remotely provisioned tunnel, with no network call", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new Error("unexpected network call")
    })
    const provider = cloudflareProvisionedTunnelProvider(null, { fetch: fetchImpl })

    await expect(
      provider.destroy!({
        key: "stuck-tunnel-id",
        hostnames: ["stuck.example.com"],
        tunnelId: "tun-remote-1",
      }),
    ).rejects.toThrow(/remote tunnel tun-remote-1 still exists.*not configured.*setup_tunnel_provider/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("removes an unprovisioned local record from tunnel_list via registry.delete", async () => {
    const reg = registryWith(descriptor())
    expect(reg.list()).toHaveLength(1)

    await expect(reg.delete("stuck-tunnel-id")).resolves.toBe(true)
    expect(reg.get("stuck-tunnel-id")).toBeUndefined()
    expect(reg.list()).toHaveLength(0)
  })

  it("keeps a remotely provisioned descriptor when the provider is unconfigured", async () => {
    const reg = registryWith(descriptor({ tunnelId: "tun-remote-1" }))

    await expect(reg.delete("stuck-tunnel-id")).rejects.toThrow(
      /remote tunnel tun-remote-1 still exists.*not configured.*setup_tunnel_provider/,
    )
    expect(reg.get("stuck-tunnel-id")).toMatchObject({
      status: "stopped",
      lastError: expect.stringMatching(/remote tunnel tun-remote-1 still exists/),
    })
  })
})
