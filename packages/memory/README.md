# @agentproto/memory

AIP-72 `memory/v1` reference implementation: define, validate, parse and
render memory items. A memory item is one small typed assertion (`user`,
`feedback`, `project`, `reference`) about a principal or its work, with a
lifecycle (`active`, then `superseded` or `archived`), stored as markdown
with YAML frontmatter.

Spec: <https://agentproto.sh/docs/aip-72>. This package covers the
document only; a store port and per-harness projection come later.

## Usage

```ts
import {
  defineMemory,
  parseMemory,
  renderMemory,
  validateMemory,
} from "@agentproto/memory"

// Writer path: canonical fields required, throws MemoryValidationError
// (with `.field` and `.issues`) on any invalid field.
const item = defineMemory({
  schema: "memory/v1",
  slug: "cite-sources",
  kind: "feedback",
  type: "feedback",
  title: "Cite sources",
  updated_at: "2026-10-13T11:30:00.000Z",
  polarity: "do",
  provenance: { source: "converse", at: "2026-10-13T11:00:00.000Z" },
  body: "Always cite sources.\n",
})

const md = renderMemory(item) // every string double-quoted
const doc = parseMemory(md) // YAML 1.2 core, does not validate

// Reader path: legacy items (id, name, type) are accepted.
const { ok, errors, warnings } = validateMemory(doc)
// errors: [{ path: "provenance.sessionId", message, rule: "schema" }, ...]
```

`defineMemory` fills in only `status: "active"` (a writer creates an item
active) and an absent `body` as `""`. Lifecycle helpers: `memoryStatus`,
`isAllowedStatusTransition`, `isInForce`.

## License

Apache-2.0. See [LICENSE](./LICENSE).
