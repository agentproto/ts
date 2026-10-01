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
      const known = hosts.find(h => h.fingerprint === target || h.name === target)
      if (!known) {
        throw new Error(
          `device sandbox: no paired host device matches "${target}" — run \`agentproto ` +
            "devices add <offer-url>` here first (the offer must come from `agentproto pair " +
            "offer --host` run ON that device). Check `agentproto devices list` for known devices.",
        )
      }

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
