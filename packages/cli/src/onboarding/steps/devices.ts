/**
 * devices — how many devices are paired with this daemon
 * (`~/.agentproto/pairings.json`), and whether any of them looks abandoned:
 * never seen since it was paired, or not seen in 30+ days (DEVICES-PLAN
 * PR-A). Unrelated to the `clients` step, which checks MCP *coding-client*
 * registration, not device pairing.
 */

import type { DeviceSnapshot, OnboardingStep, StepCheck } from "../types.js"
import { errorMessage } from "./_util.js"
import { HOST_HANDSHAKE_REMEDIATION_HINT } from "@agentproto/runtime"

const STALE_MS = 30 * 86_400_000
/** How recent a host's `lastProbeAt` must be for its `lastError` to count as
 *  a LIVE failure (BOOTSTRAP P3 item 4) — older than this and the hint is
 *  stale data, not an active problem. Catches the WIN11 field case (the
 *  background probe beats every few seconds / backs off to minutes) while
 *  not flagging a one-off failure from a device that has been offline for
 *  a week. */
const HOST_CHANNEL_FAIL_RECENT_MS = 30 * 60_000

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
    // Host devices: a still-probing host whose latest dial/handshake failed
    // gets the one-line re-pair remediation (BOOTSTRAP P3 item 4) — the
    // classically silent failure mode of an old host registration after a
    // Windows reboot.
    for (const d of devices) {
      if (!d.hostLastError) continue
      const probeMs = d.hostLastProbeAt ? Date.parse(d.hostLastProbeAt) : NaN
      if (!Number.isFinite(probeMs) || now - probeMs > HOST_CHANNEL_FAIL_RECENT_MS) continue
      checks.push({
        id: `devices.host-channel.${d.fingerprint}`,
        title: d.name,
        status: "warn",
        detail: `host channel failing: ${trimChannelError(d)}`,
        fix: HOST_HANDSHAKE_REMEDIATION_HINT,
        data: { fingerprint: d.fingerprint, hostLastError: d.hostLastError },
      })
    }
    return checks
  },
}

function trimChannelError(d: DeviceSnapshot): string {
  const error = d.hostLastError ?? ""
  return error.length > 120 ? error.slice(0, 117) + "…" : error
}
