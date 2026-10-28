# @agentproto/memory

AIP-72 `memory/v1` reference implementation: define, validate, parse and
render memory items. A memory item is one small typed assertion (`user`,
`feedback`, `project`, `reference`) about a principal or its work, with a
lifecycle (`active`, then `superseded` or `archived`), stored as markdown
with YAML frontmatter.

Spec: <https://agentproto.sh/docs/aip-72>. This package covers the
document (sections 1 to 7) and the store (section 8); the per-harness
projection (section 9) lives with the hosts.

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

## Store

`MemoryStore` (alias `IMemoryStore`) is the section 8 port: `write`
(`propose` or `commit`), `read`, `list`, `search`, `supersede`, `archive`,
`dismiss`. `FilesMemoryStore` implements it over the reference layout:

```
<root>/items/<type>/<id>.md      one memory/v1 item per file
<root>/proposals/<sha256>.md     pending proposals, not items
```

```ts
import { FilesMemoryStore } from "@agentproto/memory"

const store = new FilesMemoryStore({ root: ".agentproto/memory" })
const rec = await store.write(item, { mode: "commit" }) // assigns an id
await store.archive(rec.item.id!, { ifRevision: rec.revision })
const hits = await store.search("pnpm") // in-force items by default
```

- `revision` is the SHA-256 of the file bytes. A commit that changes an
  item, `supersede` and `archive` need the current `ifRevision`, else they
  reject with `MemoryConflictError`; an equal re-write is a no-op.
- `supersede` and `archive` rewrite the `status` line only; no item file
  is ever deleted. Other failures: `MemoryNotFoundError`,
  `MemoryTransitionError` (e.g. `superseded` to `active`),
  `MemorySlugTakenError`, and `MemoryValidationError` naming the field.
- `search` matches title, description and body. Pass `knowledge` (any
  AIP-10 `IKnowledgeProvider`, typed structurally so this package does not
  depend on the knowledge engine) to merge its hits: a hit naming an item
  of the store (`metadata.memoryId` or its `sourceId`) is checked against
  the files, anything else comes back as `source: "knowledge"`.

## License

Apache-2.0. See [LICENSE](./LICENSE).
