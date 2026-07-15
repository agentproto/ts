# `@agentproto/provider-kit` — Design

> Formerly `@agentproto/adapter-kit`; renamed in #245. The `@agentproto/adapter-kit`
> name lives on as a deprecated re-export shim. Concepts below are unchanged.

**Status:** Shipped · `@agentproto/provider-kit` 0.2.0
**Author:** Design task, 2026-06-22
**Scope:** One shared primitive for adapter selection, status, creds, and MCP introspection
**Deliverable:** This document only — no code is created or modified.

---

## 1. Problem statement

Three adapter families exist (or are proposed) in the agentproto runtime.
Each reinvents the same pattern with slight variations:

| Concern | agent-CLI | browser | tunnel (proposed) |
|---|---|---|---|
| Static catalog | ✓ `catalog.ts` | ✗ (injected map) | ✗ (injected map) |
| 3-level status | ✓ `supported→available→ready` | ✗ (binary: exists/not) | ✓ (proposed) |
| Setup ledger | ✓ `~/.agentproto/setup/<slug>.json` | ✗ | ✓ (proposed) |
| Creds store | ✓ (per-step secret prompts) | ✗ | ✓ (proposed, mode 0600) |
| Injected resolver | ✓ `resolveAgentAdapter` | ✓ `resolveBrowserAdapter` | ✓ (proposed) |
| MCP list tool | ✓ `list_adapters` | ✓ `list_adapter_browsers` | ✓ `list_tunnel_adapters` |
| MCP setup tool | ✗ (CLI only) | ✗ | ✓ `setup_tunnel_provider` |
| CLI wizard | ✓ `agentproto setup <slug>` | ✗ | ✓ (proposed radio chooser) |

`@agentproto/provider-kit` extracts the common skeleton into one package that
all three families parameterise via TypeScript generics. Each family provides
its own `TInfo` shape and `THandle` type; the kit owns everything else.

---

## 2. Core types

All types are generic over `TInfo` — the per-family descriptor that is safe
to surface in MCP tool results, UI lists, and logs. `TInfo` **never** contains
credentials, secrets, or API keys.

```
AdapterStatus
  = "supported"   // catalog knows it; package not importable (not installed)
  | "available"   // package resolves; no setup ledger, or adapter needs no setup
  | "ready"       // package resolves + setup ledger present (or no creds needed)
```

### 2.1 Catalog entry (static, per-family)

```
AdapterCatalogEntry {
  slug:        string          // lower-kebab, e.g. "claude-code", "ngrok"
  name:        string          // display name
  description: string          // one-liner safe for MCP tool hints
  packageName: string          // npm package that provides the handle
  hint?:       string          // short tag for picker UX (e.g. "openai · ACP")
}

AdapterCatalog = readonly AdapterCatalogEntry[]
```

### 2.2 Runtime entry (catalog + live status + info)

```
AdapterEntry<TInfo> {
  // — from catalog —
  slug:        string
  name:        string
  description: string
  packageName: string
  hint?:       string
  // — from runtime resolution —
  status:      AdapterStatus
  version:     string          // "not installed" when status=supported
  info?:       TInfo           // absent when status=supported
}
```

### 2.3 Per-adapter check contract

Every adapter handle exposes a single async check operation the kit calls to
determine its runtime status. The kit does **not** call `check()` directly —
it calls the injected resolver and observes success/failure. The setup ledger
check is the kit's responsibility (see §2.5).

```
AdapterHandle {
  readonly slug:        string
  readonly name:        string
  readonly version:     string
  readonly description: string
  /** True when the adapter requires a creds/setup pass before use. */
  readonly requiresSetup: boolean
  /** Probe whether the adapter is locally operational (binary present,
   *  API reachable, etc.) without requiring creds to be present.
   *  Returns true = binary/service reachable, false = not available.
   *  Always async — I/O is expected (dynamic import, fs.access, HTTP probe). */
  check(): Promise<boolean>
}
```

`THandle` extends `AdapterHandle`. Families add their own fields on top
(e.g. `commands`, `models`, `defaultPort`, `ensure()`).

### 2.4 Creds store

One generic implementation, keyed by family name + slug. File lives at
`~/.agentproto/<family>-creds/<slug>.json`, created with mode `0600`.
The value is never logged, never included in `TInfo`, never returned
from any MCP tool. The store only leaks the boolean "does this creds
file exist", used by the status engine (§2.6).

```
CredsStore<TCreds> {
  /** Returns null when no creds file exists. */
  read(slug: string): Promise<TCreds | null>
  /** Writes with mode 0600; creates parent dir if absent. */
  write(slug: string, creds: TCreds): Promise<void>
  /** True when the creds file exists (for status computation — no value returned). */
  exists(slug: string): Promise<boolean>
}

makeCredsStore<TCreds>(opts: {
  family:     string   // e.g. "tunnel", "agent-cli"
  home?:      string   // defaults to AGENTPROTO_HOME ?? ~/.agentproto
}): CredsStore<TCreds>
```

### 2.5 Setup ledger

The ledger records that interactive setup completed for a slug. Its
presence is what promotes an adapter from `available` → `ready` (when
`requiresSetup=true`). The agent-CLI family already uses this shape at
`~/.agentproto/setup/<slug>.json` — the kit formalises it and makes it
injectable.

```
SetupLedger {
  exists(slug: string): Promise<boolean>
  /** Writes a JSON record {slug, completedAt, steps:[...]} with mode 0600. */
  write(slug: string, record: SetupLedgerRecord): Promise<void>
  read(slug: string): Promise<SetupLedgerRecord | null>
}

SetupLedgerRecord {
  slug:        string
  completedAt: string   // ISO-8601
  steps:       { id: string; completedAt: string }[]
}

makeSetupLedger(opts?: { home?: string }): SetupLedger
```

### 2.6 Status engine

The status engine is a pure function (no side effects beyond I/O reads)
that the kit calls when building `AdapterEntry` lists.

```
computeStatus(opts: {
  resolved:     boolean          // did resolveAdapter() succeed?
  requiresSetup: boolean         // from the handle
  ledgerExists:  boolean         // from SetupLedger.exists()
  credsExist?:   boolean         // from CredsStore.exists() (optional)
}): AdapterStatus
```

Logic:
- `!resolved` → `"supported"`
- `resolved && !requiresSetup` → `"ready"` (no setup needed)
- `resolved && requiresSetup && (ledgerExists || credsExist)` → `"ready"`
- `resolved && requiresSetup && !ledgerExists && !credsExist` → `"available"`

---

## 3. List / resolve primitives

The kit exports factory functions that families use to build their injected
list/resolve functions. Nothing is hardcoded — the runtime package continues
to import zero concrete adapters.

### 3.1 Resolver factory

```
AdapterResolver<THandle> = (slug: string) => Promise<THandle | null>

makeAdapterResolver<THandle>(opts: {
  /** Try to load the handle for a slug. Throw = not installed.
   *  Conventionally: dynamic import of @<scope>/adapter-<slug>. */
  load: (slug: string) => Promise<THandle>
}): AdapterResolver<THandle>
```

### 3.2 Lister factory

```
AdapterLister<TInfo> = () => Promise<AdapterEntry<TInfo>[]>

makeAdapterLister<THandle extends AdapterHandle, TInfo>(opts: {
  catalog:   AdapterCatalog
  resolver:  AdapterResolver<THandle>
  ledger:    SetupLedger
  credsStore?: CredsStore<unknown>   // optional; credsExist fed into status engine
  /** Extract the TInfo from a resolved handle. Never include secrets. */
  toInfo:    (handle: THandle) => TInfo
}): AdapterLister<TInfo>
```

The lister:
1. Iterates the catalog in order.
2. For each entry: calls resolver, calls `ledger.exists()`, optionally
   `credsStore.exists()`, calls `computeStatus()`.
3. Appends any handles discovered by the node_modules walker (for
   agent-CLI) or injected map (for browser) that aren't in the catalog.
4. Returns sorted: catalog entries first (in catalog order), then extras
   sorted by slug.

---

## 4. MCP tool factories

### 4.1 List tool (`makeListTool`)

Generates an MCP tool that exposes the adapter list. Used for all three
families. The tool name, description, and lister are all injected.

```
makeListTool<TInfo>(opts: {
  server:      McpServer
  toolName:    string          // e.g. "list_adapters", "list_adapter_browsers"
  description: string
  lister:      AdapterLister<TInfo>
}): void
```

The generated tool takes no parameters and returns a JSON array of
`AdapterEntry<TInfo>` objects — status included, creds never included.

### 4.2 Setup tool (`makeSetupTool`)

Generates an MCP tool for the families that need remote setup (tunnel,
and optionally agent-CLI in future). The `value` parameter is flagged
sensitive — the MCP server must never log it.

```
makeSetupTool<TCreds>(opts: {
  server:      McpServer
  toolName:    string          // e.g. "setup_tunnel_provider", "setup_agent_cli"
  description: string
  /** Slugs for which setup is accepted (drawn from catalog). */
  validSlugs:  readonly string[]
  /** Called after validation; implementation writes creds + ledger. */
  onSetup: (slug: string, creds: TCreds) => Promise<{ ok: boolean; hint?: string }>
}): void
```

Generated tool schema:

```
{
  slug:  z.string().describe("Adapter slug to configure"),
  value: z.string().describe("Credential value (API key, token, …)")
         // marked sensitive — never echoed in tool results or logs
}
```

The `value` param carries whatever the family needs (API token, path,
JSON blob). The `onSetup` callback owns validation and interpretation.
The tool result **never** echoes the value back, only `{ ok, slug, hint? }`.

---

## 5. Wizard factory (CLI interactive)

For interactive CLI use: a radio chooser that lets the user pick an adapter
from the catalog, then runs per-family setup steps.

```
AdapterWizardStep {
  id:          string
  kind:        "prompt" | "cmd" | "external"
  label:       string
  /** When "prompt": the value is written to CredsStore or env. */
  secret?:     boolean
}

makeAdapterWizard<THandle extends AdapterHandle, TCreds>(opts: {
  catalog:     AdapterCatalog
  resolver:    AdapterResolver<THandle>
  ledger:      SetupLedger
  credsStore?: CredsStore<TCreds>
  /** Provide setup steps for a resolved handle. */
  getSteps:    (handle: THandle) => AdapterWizardStep[]
}): {
  /** Interactive picker: shows a radio list of catalog entries, then
   *  runs setup steps for the chosen slug. Skips ledger-completed
   *  steps unless force=true. */
  run(opts?: { force?: boolean; dryRun?: boolean; only?: string[] }): Promise<number>
}
```

This replaces the bespoke logic in `packages/cli/src/commands/setup.ts` and
the proposed `setup_tunnel` wizard. Each family instantiates one wizard with
its own `getSteps` callback; the picker UX and ledger write are shared.

---

## 6. Package shape

### 6.1 Proposed `package.json`

```json
{
  "name": "@agentproto/provider-kit",
  "version": "0.1.0",
  "description": "Generic adapter catalog, status, creds, and MCP tool primitives",
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./types": "./dist/types.js",
    "./creds": "./dist/creds-store.js",
    "./ledger": "./dist/ledger.js",
    "./list-resolve": "./dist/list-resolve.js",
    "./mcp-tools": "./dist/mcp-tools.js",
    "./wizard": "./dist/wizard.js",
    "./discover": "./dist/discover.js"
  },
  "peerDependencies": {
    "@modelcontextprotocol/sdk": ">=1.0.0",
    "zod": ">=3.0.0"
  }
}
```

### 6.2 Source layout

```
packages/provider-kit/src/
  types.ts          — AdapterStatus, AdapterCatalogEntry, AdapterEntry,
                      AdapterHandle, SetupLedgerRecord
  creds-store.ts    — makeCredsStore<TCreds> (mode 0600, never leaks value)
  ledger.ts         — makeSetupLedger, SetupLedger
  status.ts         — computeStatus (pure function)
  list-resolve.ts   — makeAdapterResolver, makeAdapterLister
  mcp-tools.ts      — makeListTool, makeSetupTool
  wizard.ts         — makeAdapterWizard
  index.ts          — re-exports all public surface
```

### 6.3 Public exports summary

```typescript
// types
export type {
  AdapterStatus, AdapterCatalogEntry, AdapterCatalog,
  AdapterEntry, AdapterHandle, SetupLedgerRecord,
  AdapterResolver, AdapterLister,
}

// creds
export { makeCredsStore }
export type { CredsStore }

// ledger
export { makeSetupLedger }
export type { SetupLedger }

// status
export { computeStatus }

// list / resolve
export { makeAdapterResolver, makeAdapterLister }

// MCP tools
export { makeListTool, makeSetupTool }

// discovery
export {
  collectAgentprotoNamespaceRoots,
  discoverAdapterPackages,
}

// wizard
export { makeAdapterWizard }
export type { AdapterWizardStep }
```

---

## 7. Three-family mapping

| | **agent-CLI** | **browser** | **tunnel** |
|---|---|---|---|
| **`THandle` extends** | `AdapterHandle` + `AgentCliHandle` fields (commands, models, protocol, streaming, setup[]) | `AdapterHandle` + `BrowserAdapterHandle` fields (defaultPort, healthPath, ensure()) | `AdapterHandle` + `TunnelProviderHandle` fields (capabilities, start(), stop()) |
| **`TInfo` shape** | `AgentAdapterInfo` (slug, name, version, description, protocol, streaming, commands, models, status, hint) | `BrowserAdapterInfo` (id, name, description, defaultPort) | `TunnelAdapterInfo` (slug, name, description, capabilities[], supportsNamedDomains, managedByCloud) |
| **Creds + wizard** | Yes — per-step secret prompts + `runSetup` wizard. Ledger at `~/.agentproto/setup/<slug>.json` | No | Yes — API token/account-id per provider. Creds at `~/.agentproto/tunnel-creds/<slug>.json` (mode 0600) |
| **Setup ledger** | ✓ (already exists) | ✗ | ✓ (new, via kit) |
| **Status computation** | Async: resolve + ledger.exists() | Binary: adapter in injected map or not (promote to 3-level optional) | Async: resolve + credsStore.exists() |
| **MCP list tool** | `list_adapters` (already exists, migrates to kit) | `list_adapter_browsers` (migrates to kit) | `list_tunnel_adapters` (new, via kit) |
| **MCP setup tool** | No (CLI-only today; can add via kit later) | No | `setup_tunnel_provider` (new, via kit, `value` param sensitive) |
| **CLI wizard** | `agentproto setup <slug>` → migrates `runSetup` to use kit wizard | No | `agentproto setup-tunnel` → new, uses kit wizard |
| **What migrates** | `catalog.ts` → uses `AdapterCatalogEntry`; `resolve.ts` → uses `makeAdapterLister`; `listAdaptersWithCatalog` replaced by kit lister; `setup.ts` `runSetup` core delegated to kit wizard | `resolveBrowserAdapter` / `listBrowserAdapters` wired via kit resolver/lister; no wizard | All new; fully on kit from day one |
| **What stays family-specific** | `AgentCliHandle` type, `setup-prompts.ts` step runner, node_modules walker | `ensure()` logic, health probe in `browser_status`, non-blocking cold start | `start()` / `stop()` tunnel lifecycle, provider-specific creds validation, cloud-token scoping |

---

## 8. Explicit boundary

### Kit owns

- `AdapterStatus` enum and `computeStatus()` logic
- `AdapterCatalogEntry` / `AdapterCatalog` / `AdapterEntry<TInfo>` generic types
- `AdapterHandle` base interface (slug, name, version, description, requiresSetup, check())
- `CredsStore<TCreds>` — file I/O, mode 0600, never leaks value
- `SetupLedger` — existence check, read, write
- `makeAdapterResolver` / `makeAdapterLister` factories
- `makeListTool` / `makeSetupTool` MCP tool factories
- `makeAdapterWizard` CLI interactive picker + step runner

### Stays family-specific

- **agent-CLI**: `AgentCliHandle` type, `AgentCliCommand`, `setup-prompts.ts`
  step runner (handles `cmd` / `prompt` / `oauth` / `external` step kinds),
  node_modules walker (`collectAgentprotoNamespaceRoots`), `AgentCliParticipant`
  wiring in `builtins.ts`
- **browser**: `BrowserAdapterHandle.ensure()` contract, health probe logic,
  `wasAlreadyRunning` / `initialWaitMs` cold-start semantics, `stop_browser` /
  `list_browsers` / `browser_status` tools (only `list_adapter_browsers` comes
  from the kit factory)
- **tunnel**: `TunnelProvider.start()` / `.stop()` lifecycle, per-provider creds
  validation (`cloudflare-named` needs account-id + scoped token; `ngrok` needs
  auth-token), cloud-token scoping, reverse-proxy config, autostart-on-boot

---

## 9. Non-breaking migration approach

The kit is a **new additive package**. Families adopt it incrementally —
existing tests keep passing at every step.

### Phase 1 — Publish `@agentproto/provider-kit` (no consumers yet)

The package is published with the types and primitives defined above. No
family imports it yet. CI only checks that the package builds.

### Phase 2 — agent-CLI adopts the kit

1. `resolve.ts`: replace `listAdaptersWithCatalog` body with a call to
   `makeAdapterLister` from the kit. The returned shape is compatible with
   the existing `AdapterInfo & { status, hint }` type (extend `AdapterEntry`).
2. `catalog.ts`: `CatalogEntry` becomes a type alias for `AdapterCatalogEntry`
   (re-export for existing consumers).
3. `setup.ts`: `runSetup` delegates step iteration to `makeAdapterWizard`'s
   internal runner, keeping its CLI flags (`--force`, `--dry-run`, `--only`)
   as pass-throughs.
4. `list_adapters` MCP tool: replace its bespoke lister call with the kit
   lister. Output shape unchanged.

**Invariant**: existing `listAdaptersWithCatalog` callers and the
`list_adapters` MCP response schema do not change.

### Phase 3 — browser adapts (optional, lower priority)

`registerBrowserTools` gains an optional `lister: AdapterLister<BrowserAdapterInfo>`
param. When provided, `list_adapter_browsers` uses it (kit path). When absent,
falls back to the existing injected `listBrowserAdapters` function (legacy path).
The browser family's `BrowserAdapterHandle` adds `requiresSetup = false` and a
trivial `check()` that returns true when the adapter is present in the injected
map — so it satisfies `AdapterHandle` without behavioural change.

### Phase 4 — tunnel uses the kit from day one

The tunnel family is not yet implemented. Its `TunnelProvider` handle is defined
to extend `AdapterHandle` from the start. `setup_tunnel_provider` is generated
via `makeSetupTool`. No migration needed.

---

## 10. Open questions

These are non-trivial design forks. Each option is listed with a recommended
default; the recommendation is not final — the architect decides.

### OQ-1: Should creds live in the kit core or per-family?

**Option A — Kit core (recommended default).**
`CredsStore<TCreds>` is a generic file-backed store. Each family supplies its
`TCreds` type and a `family` string for the path prefix. The kit owns the
0600-write logic once. The downside: the kit gains an implicit contract that
"all families store creds in the same place". Alternative approaches (keychain,
env vars, vault) would require replacing `CredsStore` entirely per family.

**Option B — Per-family.**
Each family owns its own creds path logic. The kit only defines the
`CredsStore<TCreds>` interface (not the implementation). Families are free to
use the file-backed implementation or swap it out. More flexible; less DRY.

*Recommendation: Option A for v0. Add an escape hatch: `makeCredsStore` is
exported but not mandatory — families can inject any `CredsStore<TCreds>`
impl into `makeAdapterLister`.*

### OQ-2: Sync vs async for `check()` and `computeStatus`

**Option A — Always async (recommended default).**
Agent-CLI's status check is I/O (dynamic import + fs.access). Browser's
`ensure()` is async. Tunnel's `check()` is proposed as async. A sync override
complicates the generic interface for no real gain — the kit's lister is already
async.

**Option B — Sync for capability flags, async for I/O.**
`AdapterHandle.requiresSetup` (sync bool) drives the status engine; `check()`
is only called when detailed health info is needed. This keeps `computeStatus`
a pure sync function fed with booleans.

*Recommendation: Option B — `computeStatus` stays a pure sync function fed
pre-resolved booleans (resolved, ledgerExists, credsExist). `check()` on the
handle is async and optional — used by health probes, not by the standard list
flow. This avoids making every list call pay for N async health checks.*

### OQ-3: One catalog per kit vs one per family

**Option A — One per family (recommended default).**
`AdapterCatalog` is the shared type; each family defines its own
`AGENT_CLI_CATALOG`, `TUNNEL_CATALOG`, etc. The kit owns the type, not the
data. This is already the current approach for agent-CLI.

**Option B — A unified cross-family catalog.**
A `type` discriminant (e.g. `"agent-cli" | "browser" | "tunnel"`) lets one
catalog enumerate all families. The `install` picker could then show a unified
type-then-slug flow.

*Recommendation: Option A for now. The unified catalog is a UX feature
(`agentproto install` picker) that can be composed from the per-family catalogs
at the CLI layer without merging the data sources.*

### OQ-4: `makeListTool` vs `makeSetupTool` vs one `makeAdapterTools` composite

**Option A — Keep separate (recommended default).**
Not every family needs a setup tool (browser has none). Bundling them into one
`makeAdapterTools` call would require optional params that hurt discoverability.
Separate named factories are explicit.

**Option B — One composite `makeAdapterTools`.**
Convenience factory that calls both, with `setupTool?: SetupToolOpts` being
optional. Callers that don't need setup simply omit it.

*Recommendation: Option A. The composite can always be added as a convenience
wrapper once the shapes stabilise.*

### OQ-5: Should `AdapterHandle.check()` run during `makeAdapterLister` or be a separate health-probe call?

If `check()` runs during listing, every `list_adapters` call spawns N async
health probes. For agent-CLI today the "check" is just a dynamic import + file
stat — fast. For tunnel providers it could be an HTTP call to an external API.

*Recommendation: `check()` is NOT called during listing. The lister resolves
status from: (a) can the handle be imported/resolved? (b) does the ledger or
creds file exist? That's sufficient for `supported|available|ready`. A
separate `health_probe` MCP tool (or `browser_status`-equivalent) calls
`check()` on demand for a single slug.*

### Binary-backed families

Some adapter families ship in-process — their handles are always resolvable
because the adapter code is already loaded in the same Node.js runtime
(e.g. tunnel providers, browser adapters). In these families the `supported`
status is effectively unreachable: every catalog entry resolves, so every
adapter shows as `available` or `ready` even when its backing binary
(e.g. `cloudflared`, `ngrok`) is missing from `PATH`.

This is a deliberate consequence of OQ-5: `handle.check()` is never called
during listing, because doing so would make every `list_adapters` call pay
for N async health probes — potentially slow HTTP calls to external APIs.

The recommended pattern for families that need binary-presence visibility:

1. **Separate on-demand health probe** — an MCP tool (or the existing
   `browser_status`/tunnel-health equivalent) that calls `handle.check()`
   for a single slug on demand. This is the default approach; it keeps
   listing fast and gives the UI a way to check a specific adapter.

2. **Opt into `checkDuringListing`** — set `checkDuringListing: true` in
   `makeAdapterLister` opts. Each resolved handle runs `await handle.check()`;
   if it returns `false`, the entry gets `checkFailed: true`. The status enum
   and `computeStatus()` are unchanged — this is an additive signal that
   `status` is `ready`/`available` but the backing binary is not on `PATH`.
   The cost is one async probe per resolved adapter per list call.

Which approach to use is a per-family decision. The kit itself remains
generic — no family-specific binary-path logic lives in `provider-kit`.

---

## Appendix A: Status transition diagram

```
                 ┌─────────────────────────────────────────────────┐
  (catalog only) │                  "supported"                     │
                 │  package not importable / not installed          │
                 └───────────────────┬─────────────────────────────┘
                                     │ resolveAdapter() succeeds
                                     ▼
                 ┌─────────────────────────────────────────────────┐
                 │                  "available"                     │
                 │  handle resolves; requiresSetup=true;            │
                 │  no ledger + no creds file                       │
                 └───────────────────┬─────────────────────────────┘
                                     │ wizard completes
                                     │ (ledger written or creds stored)
                       OR: requiresSetup=false
                                     ▼
                 ┌─────────────────────────────────────────────────┐
                 │                   "ready"                        │
                 │  package resolves; setup complete (or not needed)│
                 └─────────────────────────────────────────────────┘
```

---

## Appendix B: Creds security contract

The following constraints apply everywhere in the kit and must be upheld by
all family implementations:

1. `CredsStore.read()` returns the full creds object — callers must not pass
   it to any log, MCP tool result, or descriptor field.
2. `makeSetupTool` marks the `value` parameter with `{ sensitive: true }` in
   the Zod schema annotation; the MCP server must not echo it back.
3. Creds files are written with `fs.writeFile(path, json, { mode: 0o600 })`.
4. `AdapterEntry<TInfo>` and `TInfo` must not contain any field whose value
   was drawn from the creds store. Family `toInfo` callbacks are responsible
   for this contract; the kit does not enforce it at runtime (no deep scan).
5. The `SetupLedger` records timestamps and step ids only — never cred values.
