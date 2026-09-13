# @agentproto/model-routing

Reference implementation of **AIP-57 — MODEL-ROUTING**, described at
<https://agentproto.sh/docs/aip-57>.

> **Spec status.** AIP-57 is not yet vendored under `specs/resources/aip-57/`
> in this repo — that directory is synced from the upstream AgentProto spec
> corpus by `scripts/sync-specs.mjs` once a draft is published there. Until
> then, the normative text this package implements (§1–§7, quoted throughout
> the JSDoc in `src/`) lives only on the docs site linked above; treat this
> package's tests (`src/__tests__/`) as the executable cross-check in the
> meantime.

A pure, I/O-free primitive for resolving an AIP-42 `ModelRef` that is not a
literal provider/model pair to a concrete served model:

- **Pack** (§2) — a named, TOTAL map from a declared keyspace to a `Route`
  (or `null`).
- **Layers** (§3, §4) — `override > env > pack` precedence, always reporting
  which layer won a given resolution.
- **Null-as-gate** (§4) — `null` explicitly disables a key; a lower layer's
  catch-all cannot silently re-enable it, but an explicit higher-layer entry
  can.
- **Chains** (§5) — deterministic sticky selection across a population of
  candidate refs, keyed off a hash of the conversation's stable prefix (every
  system message + the first user message), never a clock or random source.
- **Fallbacks** (§6) — ordered failover rungs are carried as descriptive
  data only; `resolve` never acts on them (detection/retry stay a host
  concern).

No I/O, no clock, no randomness (§7).

```ts
import { definePack, resolve, envLayer } from "@agentproto/model-routing"

const pack = definePack({
  id: "default",
  label: "Default",
  keyspace: "model",
  routes: {
    fast: { model: "gpt-4o-mini", provider: "openai" },
    smart: { model: "claude-sonnet-5", provider: "anthropic" },
  },
})

const env = envLayer(process.env, ["fast", "smart"])
const resolved = resolve(pack, "fast", [env])
// resolved.source tells you which layer won: "override" | "env" | "pack"
```

## Chains (sticky selection)

```ts
import { defineChain, resolveThroughChain } from "@agentproto/model-routing"

const chain = defineChain({ id: "virtual-coder", chain: ["fast", "smart"] }, [])

const served = resolveThroughChain(chain, pack, request, [env])
// served.key is the real served route; served.virtualKey is "virtual-coder"
```

## Spec

See [AIP-57](https://agentproto.sh/docs/aip-57) for the canonical
specification.
