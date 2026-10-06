# `agentproto catalog`

```text
agentproto catalog build <entry.json|dir>... --out <apps.json>
                         [--base <apps.json>] [--check]
                         [--emit-ts <file.ts>] [--generated-at <iso>]
```

> The publishing pipeline's merge step: `app pack --release --entry` writes
> per-bundle entry files, `catalog build` merges them into the published
> catalog. The full story (hosting, GitHub Releases convention, the
> embedded first-party fallback) is in
> [distribute-an-app](../guides/distribute-an-app.md#5-publish-a-remote-catalog).

Build the published app catalog: read each argument (a `*.entry.json` file
as written by `app pack --release --entry`, or a directory scanned
non-recursively for `*.entry.json`), validate every entry against
`AppCatalogEntrySchema`, merge them over the base catalog, and write a
deterministic `app-catalog/v1` document. An invalid entry exits `1` naming
the file.

Merge rules, per `appId`: the incoming entry replaces the existing one when
its version is >= (per `compareCatalogVersions`; equal versions rewrite in
place), while an older incoming version prints a warning to stderr and the
existing entry stays.

Output is deterministic: `{"schema": "app-catalog/v1", "generatedAt",
"entries"}` with entries sorted by `appId`, 2-space indent, and a trailing
newline. `generatedAt` is kept from `--base` when the entries did not
change (a no-op build produces no diff) and set to now otherwise.

| Flag | Default | Description |
|------|---------|-------------|
| `--out <apps.json>` | required | Where the merged catalog is written. |
| `--base <apps.json>` | empty | The catalog to merge over (typically the current published `apps.json`). A missing file is treated as empty. |
| `--check` | off | Write nothing; exit `1` when `--out` differs from the result (ignoring `generatedAt`). The CI drift guard. |
| `--emit-ts <file.ts>` | off | Also render the embedded first-party fallback (`packages/runtime/src/first-party-catalog.ts`) from the merged entries, via the same `renderFirstPartyCatalogTs` the `catalog:first-party` sync script uses. |
| `--generated-at <iso>` | now (or base's, unchanged) | Override `generatedAt`; used by tests for deterministic output. |
