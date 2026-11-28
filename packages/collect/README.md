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
  fallback. A verification (challenge) page seen by `http` or `api` moves the
  task to the next transport too, and fails it with cause `challenge` when none
  remains. A challenge seen by the `browser` is a hard stop: the raw is kept,
  there is no fallback, no new request is started for the connector for the
  rest of the run (requests already in flight are aborted) and its queued tasks are `skipped` with reason
  `challenge`.
  The whole root plan is written first in one atomic `plan.jsonl`. The engine
  stores every raw, parses and validates every raw of a task before writing
  anything, dedups on native id and canonical URL (the same exact text under two URLs keeps two items that share one `contentId`; the seen index maps
  each key to the item that owns it, so observations and links resolve to the
  owner), writes, then marks the task `done` with its counters. Observations
  and pickups carry `runId` and `taskId`, so a task redone after a crash does
  not double-count (readers drop the identical copy). A connector with no usable
  transport is `skipped` and the run goes on. A transport that throws
  `MissingSecretError` hands the task to the next declared transport; when none
  remains the task is `skipped` with reason `missing_secret:<NAME>` (the
  secret's name only) and a connector whose tasks were all skipped that way is
  reported `skipped`.
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
- `Recipe.sampling` is applied by the engine (see "Recipe sampling" below).

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
- **`Retry-After`** replaces the backoff on 429 and 503. It is a
  non-negative integer number of seconds or an HTTP date (IMF-fixdate, RFC 850
  or asctime); anything else is ignored. Above `maxRetryAfterMs` (default
  30 s) the request gives up at once with cause `http` and the response status.
  Only a 429 then falls back to the next transport; a 503 is a final `http`
  failure.
- **Redirects** are followed by hand (at most `maxRedirects`); `url` in the
  response is the final one. `Authorization`, `Cookie`, `Proxy-Authorization`
  and the credential headers set by `createApiTransport` are dropped when a
  hop changes origin; a request whose credential is in the URL (query
  authentication) refuses such a hop with a `blocked` error. A redirect that
  turns a POST into a GET drops the body and its `Content-*` headers.
- **User-Agent** is `agentproto-collect` unless you set `userAgent` or a request header.
- **Size cap** (`maxBytes`, default 10 MiB): a 2xx body over the cap, declared
  or streamed, aborts the transfer with cause `http` and the response status
  (not retried, no fallback: a bigger page is not a transport problem). A
  non-2xx body is truncated to the cap instead.
- **Limiter** (`minIntervalMs`, default 1000, 0 turns it off): one pacing
  point at the send boundary. It paces the first send, every retry and every
  redirect hop to the same host, and a wait in its queue ends when the request
  is aborted. The engine gates the start of each task by the connector's
  `pace.delayMs`, so the first send of a task is paced by both; the two
  overlap (the later deadline wins) and do not add up. Retries and redirect
  hops never go back through the engine, so only this limiter paces them, even
  inside the engine: set `minIntervalMs` to the gap you want between those
  extra sends (0 leaves them unpaced). Used alone, keep the default.
- **Error responses**: once the headers arrived, the status and `Retry-After`
  are kept; a body that stalls or resets is cut short and the response still
  classifies by status. A cancellation by the caller always wins.
- Options are validated: a non-finite, negative or out-of-range value throws a
  `RangeError`.

Errors are always `TransportError`, with the failed body and extension kept
for the raw store:

| Situation | `cause` | Engine reaction |
|---|---|---|
| 401, 403 | `blocked` | falls back |
| 429 (retries used up or `Retry-After` too long) | `http`, status 429 | falls back |
| 503 (same) and other 5xx | `http`, status 5xx | final |
| verification page | `challenge` | falls back; stops the connector only when the browser met it |
| 2xx with no body | `empty` | falls back |
| DNS, reset, TLS, timeout, abort | `network` | no fallback |
| other 4xx, 5xx after retries, size cap | `http` | final |

A response is a verification page only with real evidence: the header
`cf-mitigated: challenge`; or a status of 403, 429 or 503 together with an
interstitial marker in the first 64 KiB of HTML (titles such as "Just a
moment" or "Attention required", "verify you are human", "checking your
browser", or a verification widget such as reCAPTCHA, hCaptcha or Turnstile);
or a page that is nothing but the interstitial (under 4 KiB, a marker or
widget, under 120 characters of visible text). A normal page that embeds a
widget or quotes a verification phrase is content, and non-HTML content types
are never flagged. These are heuristics: a page they miss is stored as a
normal response.

`createApiTransport({ http, secrets, auth })` adds the secret on every request:
`{ type: "bearer" | "header" | "query" }` (`name` for header and query,
`prefix` for header). A missing or empty secret throws `MissingSecretError`
before any request; the engine tries the next declared transport, else skips
the task with `missing_secret:<NAME>`. The secret value never leaves the
transport: every occurrence (raw, percent-encoded and form-encoded) is
replaced by `[redacted]` in the body bytes and headers of successful
responses, and in the message, url and body of errors; a query-parameter
secret is removed from the returned `url`, and the underlying error object is
dropped.

## Recipe sampling

`recipe.sampling` thins the candidate items a connector's `parse` returns from
listing or search tasks. Tasks of `kind: "read"` (an item fetched by URL) are
never sampled. Without a `sampling` block nothing changes.

```yaml
sampling:
  bands:
    - { metric: views, min: 0, max: 999, quota: 50 }
    - { min: 1000, max: 99999, quota: 50 }   # metric omitted: the connector's primary counter
  keepMissingMetric: false
  perDomainCap: 2
  seed: 42
```

Steps, in this order, for each candidate:

1. **Bands.** The candidate falls in the first band whose range contains its
   counter value (`min` and `max` are both inclusive; either may be omitted).
   The value comes from the observations the same parse returned for that item.
   A candidate with no value for any band's counter is dropped with rule
   `no_metric`, or kept outside every band when `keepMissingMetric` is true.
   A candidate with a value that fits no band is dropped as `out_of_bands`.
   A band keeps at most `quota` candidates (`band_quota` otherwise).
2. **Per-domain cap.** At most `perDomainCap` kept items per host. The host is
   the lower-cased hostname with a leading `www.` stripped (no public-suffix
   list) of the item's canonical URL; for a `submission` it is the host of
   `links.target` when that is a URL, else of the first `outboundLinks` entry,
   so a submission counts against the article's site, not the aggregator's.
   Beyond the cap the candidate is dropped as `domain_cap`. A candidate that
   fails a rule does not use up the quota or cap of the other rule.
3. **Seed.** When a quota or cap forces a choice, `seed` makes it
   deterministic: within each task's candidates, a mulberry32 shuffle seeded
   from `seed` and the task decides the order (candidates sorted by stable id
   first), so the same recipe, seed and candidates give the same selection
   whatever order the connector listed them in. Without a seed the first seen
   in plan order is kept.

Quotas, caps and the seed are all per connector: two connectors in one recipe
each have their own band counters and their own per-domain counts.

**Guarantee.** Fetching and parsing run in parallel, but outcomes are committed
(sampling, dedup, writes) strictly in plan order (`order` of the task, a
follow-up task right after its parent). A terminal failure or skip releases its
turn; a task in transport fallback keeps it. So the kept set does not depend on
worker count, latency or which transport answered first: it is identical to a
`workers: 1` run.

**Which candidates are sampled.** An item that already exists in the store
(same id or same canonical URL) is a known item: it is not sampled, uses no
quota or cap, and gets its new observation as usual. Among the new ones, a
repeated id and several ids sharing one canonical URL form one candidate, so
aliases cannot use several slots; it is decided on the member with the highest
counter (ties: smaller URL, then smaller id), and a later alias of a decided
candidate follows that decision without a line of its own.

Every distinct candidate gets exactly one line in `runs/<id>/sampling.jsonl`:
`candidate`, `decision` (`kept` or `dropped`), `rule` when dropped, `band`,
`url`, `domain`, `seed`, `connector`, `taskId`, `at`. A dropped candidate writes no
item, no observation, no pickup, no seen key, and no actor only it
referenced, and is not counted as new, so coverage counts kept items only.

A task's lines are written in one append (`appendSamplingBatch`) before any
counter moves; if that write fails the run stops with a run error and nothing of
that task is ingested. On `resume` the counters are rebuilt from
`sampling.jsonl`, and a task that has its decisions but is not `done` reuses
them by candidate id; a candidate that is new after the refetch is decided
fresh. A decision kept for a candidate that a changed page no longer returns
stays reserved against its quota or cap (accepted: the page changed between
attempts). The report adds, per connector,
`sampled: { candidates, kept, dropped: { [rule]: n } }`.
