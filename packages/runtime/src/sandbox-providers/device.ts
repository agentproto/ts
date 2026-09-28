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
 * Build the `device:<name>` sandbox provider for a specific target device.
 * `target` is whatever `HostRegistry.forwardHttp/forwardHttpStream` accepts
 * as `idOrName` — a fingerprint or the device's user-given name.
 */
export function createDeviceSandboxProvider(
  target: string,
  hostRegistry: HostRegistry,
): SandboxProvider {
  return {
    async boot(_spec: SandboxSpec, _opts: SandboxBootOpts): Promise<BootedSandbox> {
      const hosts = await hostRegistry.list()
      const known = hosts.some(h => h.fingerprint === target || h.name === target)
      if (!known) {
        throw new Error(
          `device sandbox: no paired host device matches "${target}" — run \`agentproto ` +
            "devices add <offer-url>\` here first (the offer must come from `agentproto pair " +
            "offer --host` run ON that device). Check `agentproto devices list` for known devices.",
        )
      }

      const bridge = await startDeviceSandboxBridge({ hostRegistry, target })
      return {
        mcpUrl: bridge.mcpUrl,
        sandboxId: `device-${target}-${randomUUID()}`,
        async stop(): Promise<void> {
          // Only the local relay — the remote device's daemon and its
          // session are NOT ours to tear down (see module doc).
          await bridge.close()
        },
      }
    },
  }
}
