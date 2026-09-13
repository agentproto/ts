# @agentproto/knowledge-cascade

A global knowledge pack shadowed by per-scope override/extend/whiteout, over
plain file trees.

Override/extend/remove is by **path identity**, not typed-item merging: a
higher layer re-authoring `entries/foo.md` shadows the lower layer's copy
(override), a new path is additive (extend), and `entries/foo.md.whiteout`
removes it (remove). No entry bodies are parsed to resolve a mount — listing
a directory never reads content.

The cascade mechanics (`OverlayFs`, `StackResolver`, `buildOverlayFromStack`,
`FsPort`, `MemFs`, `ReadOnlyFs`) live in [`@agentproto/corpus`](../corpus)
and are re-exported here unchanged. This package adds a standalone-first
surface on top:

- `DiskFs` — a `node:fs`-backed `FsPort`, for mounting a directory as a
  cascade layer.
- `packFs({ root })` — mount a pack directory read-only (`DiskFs` wrapped in
  `ReadOnlyFs`).
- `mountCascade({ base, lens?, constraints? })` — compose a precedence-ordered
  stack of layers into one mounted overlay, without going through the
  `LayerProvider`/`StackResolver` dynamic-binding machinery (`corpus`'s
  `buildOverlayFromStack` does the same thing from a resolved
  `StackResolution`, if a host wants dynamic per-request layer selection
  instead of a hand-configured stack).

## Standalone-app wiring

An app with no backend/registry can ship a **global pack** inside its own
bundle and keep **local overrides** in its per-app durable data plane:

```ts
import { packFs, mountCascade, DiskFs } from "@agentproto/knowledge-cascade"

// Global pack: read-only, ships inside the app bundle.
//   <appDir>/packs/core/entries/**.md
const globalPack = packFs({ root: `${appDir}/packs/core` })

// Local overrides: writable, lives in the app's data plane.
//   <dataDir>/knowledge/entries/**.md
const localOverrides = new DiskFs({ root: `${dataDir}/knowledge` })

const cascade = mountCascade({ base: localOverrides, lens: [globalPack] })

await cascade.readFile("entries/greeting.md") // local override if present, else the pack's
```

Semantics, walking `entries/**` over `cascade`:

| Local file | Effect |
|---|---|
| `entries/greeting.md` (same path as the pack) | **override** — shadows the pack's copy |
| `entries/local-only.md` (new path) | **extend** — additive, alongside the pack's entries |
| `entries/policy.md.whiteout` | **remove** — the pack's `entries/policy.md` disappears from the cascade |

Writes (`writeFile`/`appendFile`/`lock`) always target `base` — the packs
stay pristine no matter how many scopes mount them.

For a non-shadowable floor (a policy pack no override should be able to
shadow or whiteout), pass it as `constraints` instead of `lens` — it mounts
above `base`, read-only, so neither an override nor a `.whiteout` can touch
it:

```ts
const cascade = mountCascade({
  base: localOverrides,
  lens: [globalPack],
  constraints: [policyPack],
})
```

## What this package does not do

- No typed-item merging — override/extend/remove operates on plain paths,
  not AIP-18 `Item`/`Schema` content. That is the corpus curation layer's
  job, not the cascade's.
- No recursive listing built on top of an `app_data_*` MCP tool — the app
  data plane is just files on disk (`app_data_read`/`app_data_write` are the
  agent-facing convenience, not the only access path); `DiskFs` reads the
  tree directly with `node:fs`.
