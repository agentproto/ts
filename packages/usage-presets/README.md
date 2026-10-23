# @agentproto/usage-presets

Usage-named spawn presets. The caller names the WORK (`pr-fix`, `explore`,
`implement`, `review`, `deploy`) — never the model, auth profile, posture or
execution place. Each preset declares a complete `agent_start` configuration
and ordered, place-aware candidates; `resolveUsagePlan` turns one into a
ready spawn plan.

## Install

```bash
npm add @agentproto/usage-presets
```

## Usage

```ts
import { resolveUsagePlan } from "@agentproto/usage-presets"

const plan = resolveUsagePlan("pr-fix", { freeLocalInUse: 0 })
// plan.spawn is the complete agent_start input
```

House rules enforced by the resolver:

- Sensitive usages (`deploy`) never resolve to a free model and refuse a
  candidate list containing one (`SensitivityRefusalError`).
- At most `MAX_LOCAL_FREE_AGENTS` (2) free agents run as local subprocesses;
  past the cap the overflowing free agent is redirected to the sandbox and a
  warning explains why.

`candidates` are ordered and place-aware: the resolver picks the first entry
valid for the chosen place. The overflow redirect picks the first explicitly
sandbox-capable free candidate. Later entries are not retried automatically
on failure.

## License

Apache-2.0
