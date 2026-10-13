---
"@agentproto/runtime": patch
---

An OpenCode console org auth profile (`source: "opencode-console"` with an org sub-account) is now eligible for the opencode adapter on the `opencode` (Zen) route as well as `opencode-go`, injecting the same console token and org config. Because Zen bills the org's pay-as-you-go wallet, the Zen route admits such a profile only when it has an explicit `models.mode: "allow"` list containing the route-qualified id (e.g. `opencode/nemotron-3-ultra-free`); uncurated org profiles and plain api-key profiles stay single-route.
