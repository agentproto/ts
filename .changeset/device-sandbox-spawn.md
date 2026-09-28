---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

`device` sandbox provider (DEVICES-PLAN PR-D): a paired HOST device (reverse pairing, `HostRegistry`) is now usable as an `agent_start({ sandbox: "device:<name>" })` target, spawning and proxying an agent session on that device's own daemon exactly like `sandbox: "e2b"` proxies a cloud box today — prompt/output/events/kill all work from the driving daemon, and the session shows up in `session_list` with its device.

On the receiving device, this is opt-in and off by default: `agentproto devices allow-spawn on|off` (`features.deviceSpawnAllow`) gates a new `/device-spawn/*` route family, reachable only over a pairing the other side registered as a host (`pair offer --host` + `devices add`) — mirrors `devices share-inference`'s gate shape. A device's own filesystem is unrelated to the driving daemon's, so a spawn with no explicit `cwd` is no longer forwarded as a host-shaped path that would ENOENT remotely; the box's own `agent_start` resolves its own default instead (new `SandboxProviderHandle.omitCwdWhenImplicit` flag, additive for every other provider).
