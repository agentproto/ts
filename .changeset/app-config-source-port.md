---
"@agentproto/app-config": minor
---

Injectable I/O source port (`ConfigSource`) — every filesystem call site in the kit
(app/item file reads, the items-glob directory walks, contract read/write, schema
emit) now routes through a source you can swap. Defaults to the real filesystem, so
nothing changes when you don't pass one. Inject at `defineAppConfig({ source })` or
per call on `load(root, { source })` (per call wins), and ship your config entirely
from memory with the new `memorySource(files, root)` — an already-parsed or
synthetic collection no longer needs a second resolution path. Gate rules and scope
functions get the same guarded port on their context (`ctx.source`): `readFile`,
`listDir`, and `probe` (file / dir / missing) relative to the resolved root, with
the same `..`-escape `AppConfigError` guard as `readArtifact` — so a rule can list
directories and treat "missing" as a finding instead of an error. `ResolvedItem`
also now carries the matched raw `items[]` entry (`entry`, null for file-only
items), so consumers no longer recover it through `entryIndex`.
