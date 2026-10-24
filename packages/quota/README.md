# @agentproto/quota

Unified quota status contract of AIP-67 (`quota/v1`):

- `QuotaStatus` with a mandatory `basis` (`provider` | `probe` | `observed` | `estimated`)
- `QuotaWindow.remainingPct` (0-100) is required; a window that cannot state it is omitted
- `QuotaReader`: never throws, never fabricates, unknown resolves to `undefined`
- `QuotaReaderRegistry` / `defineQuotaReader`

Core readers MUST NOT emit `basis: "probe"`.
