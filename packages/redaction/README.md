# @agentproto/redaction

Vendor-neutral **Redactor** port for scrubbing outbound payloads at an egress
boundary — loggers, telemetry sinks, session tracers — before they leave the
process.

This package is a **leaf**: it owns the port and depends on no runtime.
Consumers depend on it. It is also dependency-free and has no network access
or credential handling in v1 — every built-in redactor is a pure, local
transform. Being "off by default" is the CONSUMER's job; this package only
provides the transforms.

## The port

```ts
import type { Redactor, RedactionContext, JsonValue } from "@agentproto/redaction"

interface Redactor {
  readonly slug: string
  redact(value: JsonValue, ctx: RedactionContext): JsonValue
}
```

`RedactionContext` carries the `field` being redacted (`"prompt"`, `"input"`,
`"output"`, `"tool-args"`, `"tool-result"`, `"metadata"`) and an optional
`sessionId`.

## Built-in redactors

- `noneRedactor` — passthrough, returns the value unchanged.
- `denyListRedactor(opts?)` — deep, immutable walk that masks the value of any
  object entry whose key matches a deny pattern (`password`, `token`,
  `secret`, `authorization`, `cookie`, `credential`, etc, case-insensitive).
  Recurses into nested objects and array elements. Never mutates the input.
- `truncateRedactor(opts?)` — caps long strings (default 2000 chars) and long
  arrays (default 100 elements), leaving a `"…[+N chars]"` / `"…[+N items]"`
  marker. Recurses into nested structures. Never mutates the input.
- `chainRedactors(redactors, slug?)` — applies each redactor in order, output
  feeding the next.

```ts
import { chainRedactors, denyListRedactor, truncateRedactor } from "@agentproto/redaction"

const redactor = chainRedactors([denyListRedactor(), truncateRedactor()])
const safe = redactor.redact(payload, { field: "tool-args" })
```

## Catalog and resolver

`REDACTOR_CATALOG` lists the built-in backends (`none`, `deny-list`,
`truncate`) by slug, each with a `description`, `needsCreds` flag, and a
`build(options?)` factory. `resolveRedactor(spec?)` turns a declarative
`RedactorSpec` into a `Redactor`:

```ts
import { resolveRedactor } from "@agentproto/redaction"

resolveRedactor() // noneRedactor
resolveRedactor("deny-list")
resolveRedactor({ slug: "truncate", options: { maxStringLength: 500 } })
resolveRedactor(["deny-list", "truncate"]) // chained, in order
```

External/PII-detection providers (e.g. Presidio) are intentionally OUT of
v1 — they would resolve over the network and carry `needsCreds: true` in a
future catalog entry.

## License

MIT
