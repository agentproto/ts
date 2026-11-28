# @agentproto/collect

Building blocks for collecting public posts, articles and metrics with
provenance. The root entry is pure: no filesystem, no network, one runtime
dependency (`zod`). Only the `@agentproto/collect/node` entry touches the
filesystem (Node built-ins only).

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
- **Engine**: `createCollector({ store, transports, secrets, connectors, clock?, random? })`
  with `run(recipe, { signal, onEvent, runId? })` and `resume(runId)`. A
  connector (`defineConnector`, `registerConnector`) plans tasks, fetches
  through the transports it declares (`api`, `http`, `browser`, tried in
  order), and parses stored raws. 401/403/429, an empty body or a thrown
  `blocked`/`empty` error moves a task to the next transport (the report
  records the escalation); other statuses are `http` failures with no
  fallback. A challenge page is a hard stop: the raw is kept, there is no
  fallback, no new request is started for the connector for the rest of the run (requests
  already in flight finish) and its queued tasks are `skipped` with reason
  `challenge`.
  The whole root plan is written first in one atomic `plan.jsonl`. The engine
  stores every raw, parses and validates every raw of a task before writing
  anything, dedups on native id and canonical URL (the same exact text under two URLs keeps two items that share one `contentId`; the seen index maps
  each key to the item that owns it, so observations and links resolve to the
  owner), writes, then marks the task `done` with its counters. Observations
  and pickups carry `runId` and `taskId`, so a task redone after a crash does
  not double-count (readers drop the identical copy). A connector with no usable
  transport or a missing secret is `skipped` and the run goes on.
  Scheduling: a bounded pool (`recipe.workers`, default 8) for api/http
  attempts and a browser lane of one; each attempt is queued in the lane of its
  own transport, so a fallback moves the task between lanes. Every request goes
  through a per-host FIFO gate shared by all connectors (zero delay included).
  The host gate covers the `http` and `api` transports. The browser lane is
  serialised and paced by the connector delay (on `open` and `fetchInPage`);
  requests a page makes by itself are outside the engine.
  Start order is guaranteed per lane (by global order key) and non-browser
  tasks start first; there is no global order across the two lanes, by design.
  Each engine-written observation and pickup carries a `recordKey` (hash of run,
  task, raw hash and position in the parse output): readers keep the first
  record of a key, so a task redone after a crash that fetches the same bytes never double-counts (a page whose bytes changed is a new raw and a new reading) while
  distinct readings with equal values are all kept. Each task start is recorded
  once (`started`) and charges the cap budget, so a crash after a start still
  counts. Resuming a run with no plan file plans it again from the frozen recipe.
  Also a per-connector cap, one writer, and the store lock held for the whole
  run and released last. One collector drives one store (the store lock makes a
  second run wait). A store failure surfaces as a `CollectRunError` after the
  active work has settled.
  `resume(runId)` reloads the frozen recipe, the plan and the task log, never
  refetches a `done` task, and redoes `pending`, `failed` and `skipped` ones in
  their recorded global order. Caps are restored from the task states: a
  retried failed task takes no new budget.
  `computeCoverage(store, connectors)` gives the coverage cells;
  `withPrimaryMetric` counts only a declared primary counter. The transports are
  contracts only here (`HttpTransport`, `BrowserTransport`, `SecretsPort`,
  `TransportError`); implementations are supplied by the caller.
- **Not implemented yet**: `Recipe.sampling` (bands, per-domain cap, seed) is
  accepted by the schema but ignored by the engine (it emits a `warning`
  event); it comes in a follow-up PR.

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

- **Raws** are gzip, named by the SHA-256 of the body (the input bytes are
  copied before hashing). The same bytes for the same connector and month land
  on the same path and are written once; an existing file is verified (gunzip
  and hash) and rewritten if it is corrupt, in which case `stored` is `true`.
  The index line is appended on every fetch, failures included. Refs are
  parsed strictly (`parseRawRef`): anything but
  `raw/<connector>/<yyyy-mm>/<sha256>.<ext>.gz` is rejected.
- **Source filter**: items, observations and actors are filed by the prefix of
  their id (`hn` for `hn:1`, also for an actor ref). The `source` argument of
  `items()`, `observations()` and `actors()` means that prefix, in both stores.
- **Reads** skip lines that are not JSON or fail schema validation and count
  them in `reader.skipped`; they never throw. Only a missing file counts as
  empty; any other I/O error is raised. `getItem(id)` streams one source file
  and keeps the last match. A full `items()` read keeps the last line per id
  and buffers the unique ids of the files it reads in a map; run `compact`
  (planned) to keep files small.
- **Torn appends**: before the first append to a log file in a process (inside
  the write queue), a file whose last byte is not a newline gets a newline, so
  a torn tail stays a single skipped line. A torn `seen.idx` tail is ignored
  on load and removed once the lock is held.
- **Lock**: `collect.lock` is written to a unique tmp file and hard-linked into
  place, so it never exists empty; `EEXIST` means held, and a second
  `acquireLock()` throws `StoreLockedError`. A lock is stale when it was
  written on this host by a pid that is not alive (`pidAlive`, default
  `process.kill(pid, 0)`); a stale lock is broken automatically: the file is
  renamed to `collect.lock.stale-<token>` (one process wins the rename), read
  again, and only removed if it is still the dead holder's pid and token;
  otherwise it is linked back and the store is reported locked. A lock from
  another host, or an unreadable one, is never broken: remove it by hand.
  Taking the lock reloads the seen index from disk.
- **Writes** inside a process go through one queue, so appends never
  interleave; `seenAdd` persists before it updates the in-memory set and
  `rebuildSeenIndex` runs entirely inside the queue. One writer per store is
  assumed across processes: take the lock. Writing a task, sampling line,
  event or report for a run that was not created throws.
- **Versions**: `openStore` accepts the current schema version and refuses a
  newer one with `StoreVersionError`. For an older one it takes the lock
  (`StoreLockedError` if held), reads the version again, runs
  `options.migrations` (`{ [fromVersion]: ({ root }) => Promise<void> }`, each
  step moves N to N + 1) and rewrites `collect.json` after each step. A
  migration can be interrupted and run again, so write it to be idempotent. A
  missing step throws `StoreMigrationError`. `initStore` creates `collect.json`
  with an exclusive create, so concurrent calls are safe.
- `rebuildSeenIndex()` rewrites `seen.idx` from the current item of each id.

## HTTP and API transports (`@agentproto/collect/node`)

```ts
import { createApiTransport, createHttpTransport } from "@agentproto/collect/node"

const http = createHttpTransport({ minIntervalMs: 0 }) // the engine already gates each host
const api = createApiTransport({ http, secrets, auth: { type: "bearer", secret: "SERVICE_KEY" } })
const collector = createCollector({ store, transports: { http, api }, connectors })
```

`createHttpTransport(options)` is `fetch` with a policy, Node built-ins only:

- **Timeout** per attempt (`timeoutMs`, default 30 s; a request's own `timeoutMs` wins).
- **Retries** (`maxAttempts`, default 3) on network errors, 429 and 5xx, with
  exponential backoff and jitter (`baseDelayMs`, `maxBackoffMs`; `random` and
  `clock` are injectable). POST and PATCH are not retried unless
  `retryUnsafeMethods`.
- **`Retry-After`** (seconds or HTTP date) replaces the backoff on 429 and 503.
  Above `maxRetryAfterMs` (default 30 s) the request gives up at once with
  cause `http` and status 429 (or 503), which the engine treats as a fallback.
- **Redirects** are followed by hand (at most `maxRedirects`); `url` in the
  response is the final one. Credential headers are dropped when a hop
  changes origin.
- **User-Agent** is `agentproto-collect` unless you set `userAgent` or a request header.
- **Size cap** (`maxBytes`, default 10 MiB): a 2xx body over the cap, declared
  or streamed, aborts the transfer with cause `http` and the response status
  (not retried, no fallback: a bigger page is not a transport problem). A
  non-2xx body is truncated to the cap instead.
- **Per-host limiter** (`minIntervalMs`, default 1000, 0 turns it off). The
  engine already gates every host by the connector's `pace.delayMs`, and that
  gate runs first, so with both on the waits overlap instead of adding up (the
  transport only waits for what is left of its own interval). Inside the
  engine, set `minIntervalMs: 0` and let the connector pace; standalone, keep
  the default.

Errors are always `TransportError`, with the failed body and extension kept
for the raw store:

| Situation | `cause` | Engine reaction |
|---|---|---|
| 401, 403 | `blocked` | falls back |
| 429 (retries used up or `Retry-After` too long) | `http`, status 429 | falls back |
| verification page | `challenge` | stops the connector |
| 2xx with no body | `empty` | falls back |
| DNS, reset, TLS, timeout, abort | `network` | no fallback |
| other 4xx, 5xx after retries, size cap | `http` | final |

A page is a verification page when it carries `cf-mitigated: challenge`, or
when its HTML (first 64 KiB) matches one of a short list of generic markers
(titles such as "Just a moment" or "Attention required", "verify you are
human", widget names such as reCAPTCHA, hCaptcha or Turnstile) and the status
is 403, 429 or 503, or the status is 2xx and the page is under 50 KiB. Long
pages and non-HTML content types are never flagged. The markers are
heuristics: a page they miss is stored as a normal response.

`createApiTransport({ http, secrets, auth })` adds the secret on every request:
`{ type: "bearer" | "header" | "query" }` (`name` for header and query,
`prefix` for header). A missing or empty secret throws `MissingSecretError`
before any request and the engine records the task as `skipped`. The secret
value never leaves the transport: error messages, urls and bodies are rebuilt
with it replaced by `[redacted]`, a query-parameter secret is removed from the
returned `url`, and the underlying error object is dropped.
