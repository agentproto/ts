/**
 * LIVE Cloudflare check for the managed tunnel engine — SKIPPED unless all
 * of these are set (never in CI):
 *
 *   AGENTPROTO_CF_LIVE=1
 *   CF_LIVE_API_TOKEN      Account:Cloudflare Tunnel:Edit + Zone:DNS:Edit + Zone:Read
 *   CF_LIVE_ACCOUNT_ID
 *   CF_LIVE_ZONE           e.g. example.com
 *   CF_LIVE_HOSTNAME       e.g. agentproto-live-check.example.com (must not exist yet)
 *
 * Creates a tunnel + CNAME, replays (no duplicates), then deletes both.
 * Does not run cloudflared. The token is read from the env by reference.
 */

import { describe, expect, it } from "vitest"
import { makeTokenResolver } from "../remote-providers/cloudflare-managed-config.js"
import { ManagedTunnelEngine } from "../remote-providers/cloudflare-managed-engine.js"
import { CloudflareApi, type FetchLike } from "../remote-providers/cloudflare-api.js"

const env = process.env
const live =
  env.AGENTPROTO_CF_LIVE === "1" &&
  !!env.CF_LIVE_API_TOKEN &&
  !!env.CF_LIVE_ACCOUNT_ID &&
  !!env.CF_LIVE_ZONE &&
  !!env.CF_LIVE_HOSTNAME

describe.skipIf(!live)("cloudflare-managed (LIVE)", () => {
  it("reconcile → replay → destroy against the real API", async () => {
    const fetchImpl = globalThis.fetch as unknown as FetchLike
    const engine = new ManagedTunnelEngine({
      zones: [{ zone: env.CF_LIVE_ZONE!, accountId: env.CF_LIVE_ACCOUNT_ID!, tokenRef: "env:CF_LIVE_API_TOKEN" }],
      resolveToken: makeTokenResolver(),
      fetch: fetchImpl,
    })
    const spec = { key: `live-check-${Date.now()}`, hostnames: [env.CF_LIVE_HOSTNAME!] }
    try {
      const a = await engine.reconcile(spec, "http://127.0.0.1:65535")
      const b = await engine.reconcile(spec, "http://127.0.0.1:65535")
      expect(b.tunnelId).toBe(a.tunnelId)
      expect(b.created).toBe(false)
    } finally {
      await engine.destroy(spec)
    }
    const api = new CloudflareApi({ token: env.CF_LIVE_API_TOKEN!, fetch: fetchImpl })
    const zoneId = await api.findZoneId(env.CF_LIVE_ZONE!, env.CF_LIVE_ACCOUNT_ID!)
    expect(await api.listDnsRecords(zoneId!, env.CF_LIVE_HOSTNAME!)).toEqual([])
  }, 120_000)
})
