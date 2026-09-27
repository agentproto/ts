/**
 * devices — how many devices are paired with this daemon
 * (`~/.agentproto/pairings.json`), and whether any of them looks abandoned:
 * never seen since it was paired, or not seen in 30+ days (DEVICES-PLAN
 * PR-A). Unrelated to the `clients` step, which checks MCP *coding-client*
 * registration, not device pairing.
 */

import type { DeviceSnapshot, OnboardingStep, StepCheck } from "../types.js"
import { errorMessage } from "./_util.js"

const STALE_MS = 30 * 86_400_000

export const devicesStep: OnboardingStep = {
  id: "devices",
  title: "Devices",
  required: false,
  async detect(ctx) {
    let devices: DeviceSnapshot[]
    try {
      devices = await ctx.sources.loadDevices()
    } catch (err) {
      return [
        { id: "devices.count", title: "Paired devices", status: "warn", detail: `not checked: ${errorMessage(err)}` },
      ]
    }
    if (devices.length === 0) {
      return [
        {
          id: "devices.count",
          title: "Paired devices",
          status: "skipped",
          detail: "none paired — run `agentproto pair offer`",
        },
      ]
    }

    const checks: StepCheck[] = [
      {
        id: "devices.count",
        title: "Paired devices",
        status: "ok",
        detail: `${devices.length} device(s)`,
        data: { count: devices.length },
      },
    ]
    const now = ctx.now()
    for (const d of devices) {
      const lastSeenMs = Date.parse(d.lastSeen)
      const staleMs = Number.isFinite(lastSeenMs) ? now - lastSeenMs : null
      if (staleMs === null || staleMs <= STALE_MS) continue
      const neverSeen = d.lastSeen === d.createdAt
      checks.push({
        id: `devices.stale.${d.fingerprint}`,
        title: d.name,
        status: "warn",
        detail: `${neverSeen ? "never seen since paired" : "not seen"} in over 30 days`,
        fix: `agentproto pair revoke ${d.name}`,
        data: { fingerprint: d.fingerprint, lastSeen: d.lastSeen },
      })
    }
    return checks
  },
}
