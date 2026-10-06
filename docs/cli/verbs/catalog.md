# `agentproto catalog`

```text
agentproto catalog build <entry.json|dir>... --out <apps.json>
                         [--base <apps.json>] [--check]
                         [--emit-ts <file.ts>] [--generated-at <iso>]
agentproto catalog verify <entry.json|dir>... [--json] [--allow-git]
                          [--offline-file <appId>=<path.agentapp>]...
```

> The publishing pipeline's merge and audit steps: `app pack --release
> --entry` writes per-bundle entry files, `catalog build` merges them into
> the published catalog, `catalog verify` proves an entry's bundle is
> exactly what the entry claims. The full story (hosting, GitHub Releases
> convention, the embedded first-party fallback) is in
> [distribute-an-app](../guides/distribute-an-app.md#5-publish-a-remote-catalog).

Both sub-verbs read each argument: a `.json` file of any name (as written
by `app pack --release --entry`, or an `entries/<appId>.json` of the
`agentproto/apps` repo) or a directory, walked recursively for `*.json`
files. Every entry is validated against `AppCatalogEntrySchema`; an invalid
entry exits `1` naming the file.

## `build`

Merges the entries over the base and writes a deterministic
`app-catalog/v1` document.

Merge rules, per `appId`: the incoming entry replaces the existing one when
its version is >= (per `compareCatalogVersions`; equal versions rewrite in
place), while an older incoming version prints a warning to stderr and the
existing entry stays. Without `--base`, the result contains exactly the
given entries (an app removed from the inputs disappears from the
catalog), so the same `appId` twice among the given entries is an error
(exit `1`) rather than a silent merge.

Output is deterministic: `{"schema": "app-catalog/v1", "generatedAt",
"entries"}` with entries sorted by `appId`, 2-space indent, and a trailing
newline. `generatedAt` is kept from `--base` when the entries did not
change (a no-op build produces no diff) and set to now otherwise. This is
what the `agentproto/apps` repo CI runs to regenerate
`catalog/v1/apps.json`.

| Flag | Default | Description |
|------|---------|-------------|
| `--out <apps.json>` | required | Where the merged catalog is written. |
| `--base <apps.json>` | empty | The catalog to merge over (typically the current published `apps.json`). A missing file is treated as empty. |
| `--check` | off | Write nothing; exit `1` when `--out` differs from the result (ignoring `generatedAt`). The CI drift guard. |
| `--emit-ts <file.ts>` | off | Also render the embedded first-party fallback (`packages/runtime/src/first-party-catalog.ts`) from the merged entries, via the same `renderFirstPartyCatalogTs` the `catalog:first-party` sync script uses. |
| `--generated-at <iso>` | now (or base's, unchanged) | Override `generatedAt`; used by tests for deterministic output. |

## `verify`

For each entry, runs the checks an install would run, without installing:

1. `source.kind` must be `agentapp` (`git` sources are refused: the public
   catalog is bundles only; `--allow-git` skips the bundle checks instead).
2. The bundle is downloaded from `source.url` (https only, the same
   timeout + size caps as `app_install`).
3. If `source.size` is declared, the downloaded file must be exactly that
   many bytes.
4. The bundle is unpacked into a temp dir, which verifies the aggregate
   SHA-256 over every file, and `manifest.sha256` must equal
   `source.sha256`.
5. The unpacked APP.md must have the same `id` as `appId`, the same
   `version` as `source.version`, and must NOT declare a `ui.build` step.
6. The unpacked app must pass `app validate`.

Exit `1` at the first failing entry by default, with a per-entry report;
`--json` runs every entry and prints the full report as JSON.

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | off | Print the full per-entry report (`{ok, entries}`) instead of human lines. |
| `--allow-git` | off | Accept `source.kind: "git"` entries, skipping the bundle checks. |
| `--offline-file <appId>=<path.agentapp>` | none | Repeatable. Substitute a local bundle for the download of that appId: testing without network. |
