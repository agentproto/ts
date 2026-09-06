# @agentproto/transcript-fixtures

Canonical **RAW** daemon-transcript fixtures — typed data, zero runtime
dependencies. This package is the *producer* (source of truth) for the
`{seq, ts, kind, ...}` records the agentproto daemon's transcript writer
emits, so that two consumers in two different repos can run conformity
tests against exactly the same bytes.

## What this is for — the anti-drift contract

The transcript record format lives in `packages/runtime/src/transcript-writer.ts`
(this repo). Any change there — renaming a field, adding a kind, changing an
optionality — that breaks this file breaks the conformity suites of **both**
consumers below. That is the point.

- **Consumer B (this repo):** the future `/sessions/:id/chat` route's test
  suite in `packages/runtime`.
- **Consumer A (agentik-studio repo):** `packages/react-agentproto`'s
  `normalize.ts`, pulled in as `workspace:*`.

> **Any modification to a kind or a field in `transcript-writer.ts` MUST be
> reflected here.** A field rename that breaks this file breaks both suites.
> When you change the writer, regenerate the fixture and update the types.

## Format (RAW, not normalized)

These are the RAW records the daemon writes to events.jsonl — **not** the
client-side normalized format that `normalize.ts` produces. Each record has
`{seq, ts, kind}` plus kind-specific fields.

| `kind` | Fields |
| --- | --- |
| `user-prompt` | `sessionId`, `text`, `source?` |
| `thought` | `sessionId`, `text`, `partial?` |
| `text-delta` | `sessionId`, `text`, `partial?` |
| `tool-call` | `sessionId`, `toolCallId`, `toolName`, `arguments`, `isUpdate?` |
| `tool-result` | `sessionId`, `toolCallId`, `result` (RAW, unwrapped), `isError?` |
| `tool-call-record` | `sessionId`, `tool`, `command?`, `args?`, `isError`, `durationMs?`, `createdPrUrl?`, `createdPrNumber?` |
| `permission-resolved` | `sessionId`, `toolCallId`, `decision`, `optionId?` |
| `turn-end` | `sessionId`, `reason?` |
| `notice` | `sessionId`, `text` |

> **`notice` is the "unknown kind" exercise.** Agentik-studio's
> `normalize.ts` does not handle it explicitly — it falls through to the
> client's `"other"` fallback. This deliberately exercises the "unknown kind"
> behavior of both consumers' test suites.

## Files

- `src/records.ts` — the TS types for each RAW record plus the canonical
  fixture as a typed array (`CANONICAL_SESSION_RECORDS`). **The single source
  of truth.**
- `fixtures/canonical-session.jsonl` — the same fixture as one JSON object per
  line, for anyone seeding an events.jsonl file or replaying a stream. It is
  *generated* from the array (never authored by hand) and verified against it
  by the test suite, so the two can never diverge.
- `src/index.ts` — exports the types, `CANONICAL_SESSION_RECORDS`, and
  `CANONICAL_SESSION_JSONL` (the JSONL string pre-assembled for direct replay).

## Usage

```ts
import {
  CANONICAL_SESSION_RECORDS,
  CANONICAL_SESSION_JSONL,
} from "@agentproto/transcript-fixtures"

// typed array (RAW records)
for (const rec of CANONICAL_SESSION_RECORDS) {
  /* rec.kind is narrowed across the union */
}

// ready-to-replay JSONL string (one JSON object per line)
const stream: string = CANONICAL_SESSION_JSONL
```

## Regenerating the JSONL file

```sh
pnpm --filter @agentproto/transcript-fixtures build
pnpm --filter @agentproto/transcript-fixtures generate:fixtures
```

The `generate:fixtures` script loads the built `dist` and writes
`fixtures/canonical-session.jsonl` from the array. If you edit the array and
don't regenerate, the test suite fails — that is the sync guarantee.

## License

Apache-2.0 — see [LICENSE](./LICENSE).