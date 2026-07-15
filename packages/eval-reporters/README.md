# `@agentproto/eval-reporters`

provider-kit family for eval reporter backends. It mirrors the tunnel-provider adapter family in `@agentproto/runtime`: each backend is identified by a slug, may require credentials stored in a 0600 creds file, and exposes a `Telemetry<EvalEvent>` sink.

## Backends

| slug | Needs creds | Description |
|---|---|---|
| `langfuse` | yes | Langfuse public ingestion API (`@agentproto/telemetry-langfuse`). |
| `stderr` | no | Human-readable events to `process.stderr`. |
| `array` | no | In-memory array for tests / inspection. |

## Setup flow

```ts
import { makeEvalReporterTools } from "@agentproto/eval-reporters"

const tools = makeEvalReporterTools()

// Configure Langfuse
await tools.setup_eval_reporter.handler({
  slug: "langfuse",
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: "https://cloud.langfuse.com",
  environment: "production",
})

// List backends — status is now `ready` for langfuse
const list = await tools.list_eval_reporters.handler()
console.log(JSON.parse(list.content[0].text))

// Resolve and sink
const { makeEvalReporterResolver, makeEvalReporterCredsStore } = await import("@agentproto/eval-reporters")
const resolver = makeEvalReporterResolver(makeEvalReporterCredsStore())
const handle = await resolver("langfuse")
const sink = handle!.sink()

runEval({ suite, sink })
await sink.flush?.()
```

## Security

Credentials live only in `~/.agentproto/eval-reporter-creds/<slug>.json` with mode `0600`. `list_eval_reporters` and `EvalReporterHandle.info()` expose only capability metadata — never a secret value.
