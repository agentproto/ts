/**
 * `device` sandbox provider (DEVICES-PLAN PR-D) — makes a paired HOST
 * device (reverse pairing, `HostRegistry`) usable as an `agent_start({
 * sandbox: "device:<name>" })` target, spawning + proxying a session on
 * that device's own daemon exactly the way `sandbox: "e2b"` proxies a
 * cloud box today.
 *
 * Unlike every other provider in this family (`local`, e2b, Box — all of
 * which boot or reach an ACTUAL sandboxed machine this daemon owns and
 * tears down), `device`'s "box" is another user's own paired daemon: we
 * never own its lifecycle. `boot()` only starts a local loopback relay
 * (`device-sandbox-bridge.ts`) onto it; `stop()` only closes that relay —
 * it never touches the remote device's own daemon process, which keeps
 * running (and keeps the spawned session alive) independently of us.
 */

import { randomUUID } from "node:crypto"
import type { BootedSandbox, SandboxBootOpts, SandboxProvider, SandboxSpec } from "@agentproto/sandbox"
import type { HostRegistry } from "../host-registry.js"
import { startDeviceSandboxBridge } from "../device-sandbox-bridge.js"

/**
 * Classify a spawn's sandbox target as a paired REMOTE DEVICE (`device:<fp>`
 * / `device:<name>`) — the case `spawnAgentSession` must not compose
 * controller-local workspace contracts onto (BOOTSTRAP P5 / agentproto/ts
 * #1637: the controller's own AGENTS.md pointer, resolved at the
 * CONTROLLER's cwd, rode into the remote prompt and ENOENT'd there — a Mac
 * `/Volumes/...` path read as `C:\Volumes\...` on Windows). `sandbox` is the
 * caller's raw `agent_start.sandbox` value as `spawnAgentSession` sees it
 * before `bootSandboxAgentSession` resolves a provider: the bare-string
 * form (`"device:<fp>"`) or the inline-spec object form (`{ provider:
 * "device:<fp>" }`). The device family is identified by its `device:` slug
 * prefix — every other provider (`local`, `e2b`, `box`, `modal`,
 * `daytona`) is either a same-machine target or a box this daemon
 * provisions, neither of which makes a controller-resolved path unreadable.
 */
export function isDeviceSandboxTarget(
  sandbox: string | { provider?: string } | undefined,
): boolean {
  const slug = typeof sandbox === "string" ? sandbox : sandbox?.provider ?? ""
  return slug.startsWith("device:")
}

/** How long `boot()` waits for a live `/health` answer from a device that
 *  is not already known online before calling it offline. A paired host
 *  that answers at all answers in well under this; a sleeping laptop never
 *  does, and the caller (a placement policy) wants that verdict fast. */
export const DEVICE_LIVENESS_PROBE_TIMEOUT_MS = 10_000

/**
 * The target device did not answer — asleep, shut down, or off the network.
 * Carries `code: "device_offline"` so `agent_start` reports a typed failure a
 * caller can branch on (fall back to a sandbox, queue the task, ask the
 * user) instead of parsing a transport error out of a generic boot failure.
 */
export class DeviceOfflineError extends Error {
  readonly code = "device_offline" as const
  constructor(
    readonly target: string,
    readonly lastSeen: string | undefined,
    cause: unknown,
  ) {
    super(
      `device sandbox: paired host device "${target}" is offline (no answer to a liveness probe` +
        `${lastSeen ? `; last seen ${lastSeen}` : ""}) — ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    this.name = "DeviceOfflineError"
  }
}

export function isDeviceOfflineError(err: unknown): err is DeviceOfflineError {
  return (
    err instanceof DeviceOfflineError ||
    (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "device_offline")
  )
}

/**
 * Prove the device answers before handing the caller a bridge onto it.
 * `isOnline` alone can't decide this: it only stays true for a grace window
 * after the last successful dial, and a manually paired host isn't polled in
 * the background — so "not known online" just means "not dialled lately",
 * and gets one live `GET /health` (bounded by
 * {@link DEVICE_LIVENESS_PROBE_TIMEOUT_MS}) before it counts as offline.
 */
async function assertDeviceReachable(
  hostRegistry: HostRegistry,
  host: { fingerprint: string; lastSeen?: string },
  target: string,
  probeTimeoutMs: number,
): Promise<void> {
  if (hostRegistry.isOnline(host.fingerprint)) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const res = await Promise.race([
      hostRegistry.forwardHttp(host.fingerprint, { method: "GET", path: "/health" }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${probeTimeoutMs} ms`)), probeTimeoutMs)
      }),
    ])
    if (res.status >= 500) throw new Error(`/health answered ${res.status}`)
  } catch (err) {
    throw new DeviceOfflineError(target, host.lastSeen, err)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Build the `device:<name>` sandbox provider for a specific target device.
 * `target` is whatever `HostRegistry.forwardHttp/forwardHttpStream` accepts
 * as `idOrName` — a fingerprint or the device's user-given name.
 */
export function createDeviceSandboxProvider(
  target: string,
  hostRegistry: HostRegistry,
  opts: { probeTimeoutMs?: number } = {},
): SandboxProvider {
  return {
    async boot(_spec: SandboxSpec, _opts: SandboxBootOpts): Promise<BootedSandbox> {
      const hosts = await hostRegistry.list()
      const known = hosts.find(h => h.fingerprint === target || h.name === target)
      if (!known) {
        throw new Error(
          `device sandbox: no paired host device matches "${target}" — run \`agentproto ` +
            "devices add <offer-url>` here first (the offer must come from `agentproto pair " +
            "offer --host` run ON that device). Check `agentproto devices list` for known devices.",
        )
      }

      await assertDeviceReachable(
        hostRegistry,
        known,
        target,
        opts.probeTimeoutMs ?? DEVICE_LIVENESS_PROBE_TIMEOUT_MS,
      )

      const bridge = await startDeviceSandboxBridge({ hostRegistry, target })
      return {
        mcpUrl: bridge.mcpUrl,
        sandboxId: `device-${target}-${randomUUID()}`,
        device: { fingerprint: known.fingerprint },
        async stop(): Promise<void> {
          // Only the local relay — the remote device's daemon and its
          // session are NOT ours to tear down (see module doc).
          await bridge.close()
        },
      }
    },
  }
}
