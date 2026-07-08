# @agentproto/connector

The portable, host-agnostic description of an MCP connector: how its server
runs / is reached, and what credentials it needs. Lifted out of guilde (where
it lived as a private flat-bag interface) so any host — not just guilde — can
describe an MCP connector against an open standard.

This package is a **leaf**: it owns the type + a Zod schema and depends on no
runtime. What does NOT live here: catalog/marketplace metadata (category,
logo, vendor, billing), vault wiring, DB persistence, or host-specific
resolution — those stay in the consumer.

## `ConnectorMcpDescriptor`

A discriminated union over `kind`, so each kind only carries its valid
fields:

```ts
import type { ConnectorMcpDescriptor } from "@agentproto/connector"
```

| Kind | Meaning |
|---|---|
| `hosted` | The platform runs the MCP server at a known `serverUrl`; credentials are injected. |
| `sandbox` | Ephemeral per-install process spawned from a package / entry point (DXT-parallel). |
| `external` | The user points the platform at their own MCP URL. |
| `local-daemon` | The MCP server runs on the user's own agentproto daemon, reached over a reverse tunnel — no URL/creds on the descriptor, dispatch is pinned to a daemon identity and routed by `importAlias`. |

## Guards + validation

```ts
import {
  isHostedConnector,
  isSandboxConnector,
  isExternalConnector,
  isLocalDaemonConnector,
  connectorMcpSchema,
  parseConnectorMcp,
  safeParseConnectorMcp,
} from "@agentproto/connector"
```

The type guards are the ergonomic narrowing path in TypeScript; the Zod
schema (`connectorMcpSchema` / `parseConnectorMcp` / `safeParseConnectorMcp`)
is for runtime validation at trust boundaries — parsing a descriptor from
JSON, an API response, or a config file.

## Credential requirements

`ConnectorCredentialRequirement` and `ConnectorSecretKind` describe what
credentials a connector needs, independent of how those credentials are
actually stored or resolved (see `@agentproto/secrets` for the
broker/exposure side of that).
