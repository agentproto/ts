# @agentproto/collect

Building blocks for collecting public posts, articles and metrics with
provenance. This first release is the data layer only. It is pure: no
filesystem, no network, one runtime dependency (`zod`).

## What is in it

- **Schemas** (zod, with inferred types): `CollectItem`, `Observation`,
  `Actor` (with audience readings), `Pickup`, `Recipe`, `RunReport`,
  `Coverage`.
- **Ids**: `itemId(source, nativeId)` gives `source:nativeId`;
  `itemIdFromUrl(source, url)` hashes the canonical URL when a platform gives
  no id.
- **`canonicalUrl(url)`**: lowercase host, no fragment, no credentials, no
  default port, tracking parameters removed (`utm_*`, `fbclid`, `gclid`,
  `mc_cid`, `mc_eid`, `ref_src`, `igshid`, ...; `si` on YouTube hosts only), remaining
  parameters sorted, no trailing slash. It only normalises http(s); any other
  input comes back trimmed and unchanged. The result is a dedup key: keep the
  original URL too, and pass the final URL (redirects are not followed).
- **`textFingerprint(text)`**: SHA-256 of the text after case, whitespace and
  punctuation normalisation. Hashing goes through Web Crypto
  (`crypto.subtle`), so it is async and needs no Node built-in. Text that normalises to nothing
  returns `undefined` (no content id).
- **`STORE_SCHEMA_VERSION`**: version of the stored shapes.
- **`CollectStore`**: the port the engine writes to (raws by content hash,
  items, observations, actors, pickups, a seen index, run records, a writer
  lock), and `memoryStore()` implementing it. Reads are streaming `Reader`s
  that expose a `skipped` count of unreadable lines.
- **`@agentproto/collect/node`**: `initStore(path)` / `openStore(path)`, the
  same port on disk (Node built-ins only). See "On-disk store" below.

## Rules baked into the schemas

- A counter that is not available is absent from `metrics` and listed in
  `missing` with a reason. It is never zero.
- An item may have no subject and no author audience.
- An unknown audience is a reading with an `unknown` reason, never a zero.
  Karma stays typed `karma`.

```ts
import { CollectItem, canonicalUrl, itemIdFromUrl, textFingerprint } from "@agentproto/collect"

const url = canonicalUrl("https://Example.com/a/?utm_source=x#top") // https://example.com/a
const id = await itemIdFromUrl("web", url)
const contentId = await textFingerprint("Some article text")
CollectItem.parse({ id, source: "web", kind: "article", contentId, firstSeenAt: new Date().toISOString() })
```

## License

Apache-2.0

## On-disk store

```ts
import { initStore, openStore } from "@agentproto/collect/node"

const store = await initStore("./data") // creates it, or opens it if it exists
const lock = await store.acquireLock()
try {
  // ... write
} finally {
  await lock.release()
}
```

```
<store>/
  collect.json                 { "schemaVersion": 1 }
  raw/<connector>/<yyyy-mm>/<sha256>.<ext>.gz
  raw/index.jsonl              one line per fetch (url, date, status, transport, run, failure cause)
  items/<source>.jsonl         last line for an id wins
  observations/<source>.jsonl  append-only
  actors/<source>.jsonl        append-only
  pickups.jsonl                append-only
  seen.idx                     one dedup key per line (id:, url:, content:)
  runs/<runId>/                recipe.json, tasks.jsonl, sampling.jsonl, events.jsonl, report.json
```

- **Raws** are gzip, named by the SHA-256 of the body. The same bytes for the
  same connector and month land on the same path and are written once; the
  index line is appended on every fetch, failures included.
- **Reads** skip lines that are not JSON or fail schema validation and count
  them in `reader.skipped`; they never throw.
- **Lock**: `collect.lock`, created with `O_EXCL`, holding pid, host, timestamp
  and a token. A second `acquireLock()` throws `StoreLockedError`. A lock is
  stale when it was written on this host by a pid that no longer exists; a
  stale lock is broken automatically. A lock from another host, or an
  unreadable lock file, is never broken: remove it by hand.
- **Writes** inside a process go through one queue, so appends never
  interleave. One writer per store is assumed across processes: take the lock.
- **Versions**: `openStore` accepts the current schema version and refuses a
  newer one with `StoreVersionError`. For an older one it runs
  `options.migrations` (`{ [fromVersion]: ({ root }) => Promise<void> }`, each
  step moves N to N + 1) and rewrites `collect.json`; a missing step throws
  `StoreMigrationError`.
- `rebuildSeenIndex()` rewrites `seen.idx` from the current item of each id.
