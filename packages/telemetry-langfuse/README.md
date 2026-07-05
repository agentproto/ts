# `@agentproto/telemetry-langfuse`

A dependency-free sink that forwards agentproto eval events to the [Langfuse](https://langfuse.com) public ingestion REST API. No Langfuse SDK is required — the implementation uses `fetch` directly.

## Usage

```ts
import { langfuseTelemetry } from "@agentproto/telemetry-langfuse"

const sink = langfuseTelemetry({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: "https://cloud.langfuse.com",
  environment: "production",
})

runEval({ suite, sink })

await sink.flush()
```

## Event mapping

| EvalEvent kind | Langfuse action | Notes |
|---|---|---|
| `eval.started` | `trace-create` | One trace per `runId`; name is `eval:${suiteId}`. |
| `eval.case.scored` | `score-create` | One score per case/scorer tuple. |
| `eval.finished` | `score-create` | Two scores: `eval.meanValue` and `eval.passRate`. |
| unknown | ignored | Forward compatibility. |

Events are buffered in memory until `flush()` POSTs them as a single batch to `POST ${baseUrl}/api/public/ingestion` with Basic auth.

## Security

Credentials are used only for Basic auth headers. They are never logged or returned from `flush()`.
