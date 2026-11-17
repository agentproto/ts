# Write a sentinel provider

Status: Experimental (the contract is stable, no third-party provider exists yet)

A sentinel is a watch: "send me the events matching this subject until this
condition". The sentinel does not fetch events itself. A **provider** does:
it knows one external system (GitHub over `gh`, GitHub webhooks, agentpush,
this daemon's own sessions) and turns it into a stream of normalized events.

You need a new provider only when the events come from a system no built-in
provider covers (another forge, a CI service, a queue, a monitoring tool).
If you only want to watch something new on GitHub or on a session, you do not
write code: call `sentinel_watch` with a `subject` and `types` (see the
[sentinels guide](./sentinels.md) and [signals-and-wake](./signals-and-wake.md)).

## Sentinel, provider, delivery: who does what

| Layer | Its job | Lives in |
|-------|---------|----------|
| Provider | Talks to the external system, emits normalized events | `@agentproto/sentinel` (`sentinel-providers/`) or your package |
| Sentinel | Keeps the events that match its `match` clauses, until `until`, and hands them to its `target` | `@agentproto/sentinel` (store + runtime) |
| Delivery | Decides how loud each event is (level 0 to 3: drop, `fyi`, `next-turn`, `steer`), coalesces repeats, writes the delivery ledger | `@agentproto/delivery` (+ `@agentproto/delivery-github` classifiers) |

A provider never decides urgency and never writes to an inbox. It emits
events; the sentinel runtime matches them; the delivery kernel sets the level.

## The event a provider emits

Every event is a CloudEvents 1.0 structured JSON object (`SentinelEvent` in
`packages/sentinel/src/sentinel-providers/types.ts`), plus agentproto fields:

```json
{
  "specversion": "1.0",
  "id": "evt_<unique, stable across re-polls>",
  "source": "//agentproto.local/sentinel/<your-slug>",
  "type": "<scheme>.<object>.<action>",
  "subject": "<scheme>:<path>",
  "subjects": ["<scheme>:<path>", "<scheme>:<parent>", "<scheme>:<root>"],
  "time": "2026-11-17T00:51:15.615Z",
  "datacontenttype": "application/json",
  "data": { "...": "provider-specific payload, never secrets" },
  "summary": "one human line, shown in the inbox notice",
  "terminal": false
}
```

- `type` grammar is `<scheme>.<object>.<action>`, for example
  `github.pull_request.closed`. Users filter on it with globs.
- `subject` is the most specific routing key; `subjects` is the full hierarchy,
  most specific first. A sentinel clause ending in `*` prefix-matches any entry
  of `subjects`.
- `id` is the dedup key (per sentinel). Re-emitting the same fact with the same
  id is harmless; a new id is a new event.
- `terminal: true` means the subject is finished (a PR merged, a session
  exited): a sentinel with `until: subject_terminal` expires after delivering it.

## The provider contract

A provider is a `SentinelProviderHandle` (same file). It extends the
provider-kit `AdapterHandle` (`slug`, `name`, `version`, `description`,
`requiresSetup`, `check()`) with:

| Member | Required | What it does |
|--------|----------|--------------|
| `capabilities` | yes | Metadata shown by `list_sentinel_adapters`: `subjects` (schemes it watches, or `["*"]`), `push`, `poll`, `durable`, `needsPublicUrl`, `requiresAuth`, `typicalLatencyMs` |
| `defaultTypes(subject)` | yes | The `types` a clause gets when the caller gives none |
| `create(spec, delivery, ctx)` | yes | Start watching; return a `SentinelHandle` (`remoteId`, `cursor`, `state`), persisted on the sentinel |
| `attach(handle, delivery)` | yes | Resume after a daemon restart (re-point a callback, keep the cursor) |
| `cancel(handle)` | yes | Stop watching and release remote resources |
| `status(handle)` | yes | `{ ok, detail?, pending? }` for `sentinel status` |
| `poll(handle, limit)` + `ack(handle, cursor)` | poll mode | Return events after `handle.cursor`, oldest first, plus the new cursor; report unparseable items in `malformed` (they are quarantined, never silently skipped) |
| `parseInbound(req, handle)` | push mode | Verify and parse one inbound HTTP request (`POST /inbound/sentinel-<hookKey>`) into events |
| `preferredDelivery(intervalMs)` | no | When the provider supports both modes and has a preference |
| `readiness()` | no | `{ ready, reason }` (public URL known, token scope, ...); never throws |
| `renew(handle, until)` | no | Extend a remote subscription that has its own lifetime |
| `setupFields` | no | Credential fields accepted by `setup_sentinel_provider` |
| `exclusiveRemote` | no | `true` when each handle owns its own remote resource, so a failed cancel is retried |

The smallest complete example is the in-memory test provider,
`packages/sentinel/src/sentinel-providers/fake.ts`. The `session` provider
(`session.ts`) is the simplest real one (poll, no credentials); `local-gh.ts`
shows snapshot diffing; `webhook.ts` shows push mode.

## Ship it as a package

The daemon discovers providers on disk with the shared provider-kit walker
(`packages/provider-kit/src/discover.ts`):

1. **Name the package** `@<scope>/agentproto-adapter-<slug>` (first-party:
   `@agentproto/adapter-<slug>`). The walker also accepts the
   `agentproto-harness-<slug>` spellings, but those are meant for harnesses.
   The `agentproto-sentinel-<name>` convention in the AIP-60 design doc is not
   matched at all.
2. **Export the provider** as a factory `(creds) => handle` or a ready handle,
   under one of: `<camelSlug>SentinelProvider`, `<camelSlug>`, `default`, or
   `handle` (`registry.ts`, `importThirdPartyProvider`). A module that exports
   none of these, or a value that is not a valid provider, is skipped.
3. **Install it where the daemon can see it.** The walker climbs from the
   daemon's working directory and from the provider-kit install, looking in
   every `node_modules` (and `node_modules/.pnpm/node_modules`) on the way up.
4. **Check it:** `list_sentinel_adapters` lists it with its `status`
   (`ready`, `available` when it needs setup, `supported`). If it needs
   credentials, store them with `setup_sentinel_provider` (provider `<slug>`,
   one value per `setupFields` entry); they reach your factory as `creds`.
5. **Use it:** `sentinel_watch` with `provider: "<slug>"` and a subject in a
   scheme your `capabilities.subjects` declares.

A third-party provider runs inside the daemon with the daemon's rights. Treat
installing one like installing any other daemon adapter.

## Checklist

- Event ids are stable: polling twice must not produce two events for one fact.
- `data` never carries a token or a secret; `summary` is one readable line.
- `terminal` is set only on events that really end the subject.
- `poll` reports what it cannot parse in `malformed` instead of dropping it.
- `readiness()` explains what is missing in a sentence the operator can act on.
- `cancel` is safe to call twice and after a restart.
