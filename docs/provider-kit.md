# `@agentproto/provider-kit` — Design

> **Formerly `@agentproto/adapter-kit`** — renamed in #245. The package name
> `@agentproto/adapter-kit` remains as a deprecated shim that re-exports
> `@agentproto/provider-kit` unchanged.

**Status:** Proposal · `feat/adapter-kit`  
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

The tool returns a JSON array of `AdapterEntry<TInfo>` objects. The `info`
field is omitted when `status === "supported"`.

### 4.2 Setup tool (`makeSetupTool`)

Two overloads — single-value (backwards-compat) and multi-field:

**Single-value form** — collects one secret string (e.g. an API key):

```
makeSetupTool(opts: {
  server:      McpServer
  toolName:    string
  description: string
  paramName:   string          // e.g. "api_key"
  paramDesc:   string
  onSetup:     (slug: string, value: string) => Promise<void>
}): void
```

**Multi-field form** — collects N named fields (plain text or sensitive):

```
SetupField {
  name:        string
  description: string
  sensitive?:  boolean         // default false; value is redacted in logs
}

makeSetupTool(opts: {
  server:      McpServer
  toolName:    string
  description: string
  fields:      SetupField[]
  onSetup:     (slug: string, values: Record<string, string>) => Promise<void>
}): void
```

Both forms write the creds via the injected `onSetup` callback — the kit
never touches the file system directly in MCP tools.

---

## 5. CLI wizard (`makeAdapterWizard`)

```
AdapterWizardStep<THandle, TCreds> {
  id:          string
  description: string
  /** Returns the accumulated creds object (may be partial after this step). */
  run: (handle: THandle, prev: Partial<TCreds>) => Promise<Partial<TCreds>>
}

makeAdapterWizard<THandle extends AdapterHandle, TCreds>(opts: {
  catalog:     AdapterCatalog
  resolver:    AdapterResolver<THandle>
  ledger:      SetupLedger
  steps:       AdapterWizardStep<THandle, TCreds>[]
  /** Renders a radio/select prompt; returns chosen slug. */
  select?:     (entries: AdapterEntry<unknown>[]) => Promise<string>
  /** Runs a step; defaults to step.run(handle, prev). Override in tests. */
  runStep?:    (step: AdapterWizardStep<THandle, TCreds>, handle: THandle, prev: Partial<TCreds>) => Promise<Partial<TCreds>>
  onComplete:  (slug: string, creds: TCreds) => Promise<void>
}): {
  /** Run the full wizard for a specific slug, or prompt user to choose. */
  run(slug?: string): Promise<void>
}
```

The wizard:
1. If `slug` is given, resolves it; otherwise calls `select()` with the full
   lister output.
2. Skips any step whose `id` is already in the ledger record.
3. Calls `onComplete` with the assembled `TCreds`.
4. Writes the ledger record (marks all steps as completed).

---

## 6. Packaging

- **Package name:** `@agentproto/provider-kit` (formerly `@agentproto/adapter-kit`)
- **Entry points:** `./status`, `./creds`, `./ledger`, `./list-resolve`,
  `./mcp-tools`, `./wizard` — all re-exported from the package root.
- **Zero runtime deps** beyond Node built-ins (`fs/promises`, `path`, `os`).
- **Peer deps:** `@modelcontextprotocol/sdk` (MCP types only, not bundled).
- **Exports are pure functions** — no singletons, no global state, fully
  injectable for testing.
