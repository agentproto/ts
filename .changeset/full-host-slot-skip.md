---
"@agentproto/sandbox-computer": patch
---

With `egressIp: "auto"` and an egress health view, a create that names a pool slot and is refused for capacity on that slot's host now moves to a slot on a different host, then to plain `auto`, instead of sleeping the whole fleet-capacity window on the full host. `ComputerApiError` exposes the fleet's refusal `reason`.
