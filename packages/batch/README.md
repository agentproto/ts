# @agentproto/batch

One contract over provider batch-inference APIs — submit N Anthropic
Messages-shaped requests, poll, and collect results keyed by `custom_id`,
without caring which provider runs them. No SDK deps: raw `fetch` + zod.

## Why

Anthropic and OpenRouter both expose an async Batch API at 50% of token
price: submit up to 100k requests, get a batch id back, poll it, collect
results within a 24h window. Batch is **not a model** — it's a delivery mode
wrapped around the same Messages body (`model`, `system`, `messages`,
`max_tokens`, `tools`…). This package gives callers (distillation, eval
judging, dataset generation, proxy fan-out) one `BatchDriver` contract so
they don't have to special-case each provider's envelope.

## The contract

```ts
interface BatchDriver {
  readonly id: string
  submit(requests: readonly BatchRequest[], opts?: BatchSubmitOptions): Promise<BatchHandle>
  status(handle: BatchHandle): Promise<BatchStatus>
  results(handle: BatchHandle): AsyncIterable<BatchResult>
  cancel(handle: BatchHandle): Promise<void>
}
```

- `BatchRequest = { customId, body: MessagesBody }` — `body` is the same
  Anthropic Messages shape you'd send synchronously.
- `BatchHandle.id` is ours (`b_<ulid>`), stable across process restarts;
  `provider.batchIds` is whatever the underlying API assigned (a driver may
  fan out to several — see OpenRouter below).
- Results are keyed by `customId`, **never by position** — batch APIs return
  them in arbitrary order.
- `expired` is not a failure. It means the item never ran inside the 24h
  window and should be resubmitted; use `expiredCustomIds(results)` to find
  which ones.

```ts
import {
  anthropicBatchDriver,
  pollUntilEnded,
  collectResults,
  expiredCustomIds,
} from "@agentproto/batch"

const driver = anthropicBatchDriver({ apiKey: process.env.ANTHROPIC_API_KEY! })
const handle = await driver.submit([
  { customId: "doc-1", body: { model: "claude-sonnet-5", max_tokens: 1024, messages: [...] } },
])
await pollUntilEnded(driver, handle, { onTick: s => console.error(s.counts) })
const results = await collectResults(driver, handle)
const toResubmit = expiredCustomIds(results.values())
```

## Pre-submit validation

`validateForBatch(request)` rejects fields a batch envelope can't carry —
`stream`, `speed`, `fallbacks`, `max_tokens < 1`, and a forced `tool_choice`
of `any`/`tool` — naming the offending `customId`. `validateBatchRequests`
also rejects duplicate `customId`s across a submit (results would be
ambiguous otherwise). Every driver's `submit()` runs this before talking to
a provider.

## Durable store

`BatchStore` persists a batch to `<stateDir>/batches/<id>/{manifest.json,
requests.jsonl, results.jsonl}` so it outlives the process — anyone with the
id can re-attach via `store.load(id)`. `stateDir` is an explicit constructor
option; this package never defaults to a real home directory.

```ts
import { BatchStore } from "@agentproto/batch"
const store = new BatchStore({ stateDir: "/path/to/workspace/.batch" })
```

## Drivers

### `anthropicBatchDriver({ apiKey, baseUrl?, fetch? })`

One provider batch per submit. `results()` streams `results_url`'s JSONL
line by line. `cancel()` posts the documented cancel endpoint.

### `openrouterBatchDriver({ apiKey, baseUrl?, fetch? })`

OpenRouter's batch API (beta) scopes one provider batch to one model, so a
submit with mixed models fans out to N provider batches — grouped by
`body.model`, one POST per group with `endpoint: "/v1/messages"` (Anthropic
body shape, passed through as-is). The request body's key order
(`endpoint`, `model`, `requests`) is intentional — OpenRouter stream-parses
it. `cancel()` throws `BatchUnsupportedError` rather than pretend it
works — OpenRouter's beta docs don't document one.

Status/count aggregation across a submit's provider batches is exact when
the driver instance that submitted is still resident (its per-group
`customId` lists are cached in memory); across a process restart with no
cache, `status()` still sums to the handle's total request count but can't
attribute partial progress to a specific still-running group.

### `localQueueDriver({ complete, concurrency?, store, retry? })`

Emulation for providers with no batch API of their own (Requesty, Moonshot,
Groq, xAI, a local llm-endpoint…). Runs every request through the injected
`complete(body)` with bounded concurrency, retrying a thrown
`RetryableCompletionError` (the signal a `complete` implementation uses for
a 429/5xx from its underlying provider) with backoff up to `retry.max`
attempts before recording a permanent `errored` result. Every result is
appended to `store` as it lands. **Full price — there is no provider-side
batch to get the 50% discount from.**

`submit()` runs every pending item to completion before resolving (there's
no external service to poll). If the process crashes mid-run, a fresh
`localQueueDriver` pointed at the same store can call the extra
`resume(handle)` method — not part of the shared `BatchDriver` contract — to
reload the original requests and re-run only the ones still missing a
result.

## Helpers

- `pollUntilEnded(driver, handle, { intervalMs?, timeoutMs?, onTick? })` —
  polls `status()` until `ended`/`failed` (default 24h timeout, matching
  every provider's batch window).
- `collectResults(driver, handle)` — drains `results()` into a
  `Map<customId, BatchResult>`.

## What this package deliberately doesn't do

No OpenAI/Gemini/Mistral native batch drivers, no daemon MCP/CLI tools, no
cron polling, no model-catalog batch-pricing fields. `MessagesBody` covers
the Anthropic Messages request shape only — the batch envelope, not a
provider-agnostic request format.

## License

Apache-2.0
