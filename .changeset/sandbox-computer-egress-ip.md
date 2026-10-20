---
"@agentproto/sandbox": minor
"@agentproto/sandbox-computer": minor
"@agentproto/computer-api": minor
---

Add AIP-36 v1.3 egress IP selection and capacity errors to the computer sandbox provider: `config.egressIp` / spec-level `network.egressIp` (`"shared"`, `"auto"`, `"dedicated"`, or a pool slot id) is validated and forwarded at create when not shared, `BootedSandbox.egressIp` reports the controller's `{id, publicIp} | null` on boot and connect, and controller failures map to typed `ComputerSandboxError` codes including `sandbox_capacity` with `resource`/`requested`/`available`/`retryAfterMs`.

The provider validates the controller's `egressIp` field with the typed `@agentproto/computer-api` contract, so a malformed `egressIp` in a controller response fails the call instead of being ignored.
