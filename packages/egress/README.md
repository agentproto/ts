# @agentproto/egress

Outbound traffic control for agent sandboxes. Mode registry, provider allowlist, transport-agnostic proxy core.

```bash
npm install @agentproto/egress
```

## Concept

Agent CLIs make outbound HTTP calls to upstream APIs (OpenAI, Anthropic, custom MCP servers, …). Letting the agent hold raw API keys means a `printenv` or prompt-injection-driven exfil leaks them. This package implements **the egress side of "agent uses the credential but never sees it"**: cooperative mode injects `$$SECRET[NAME]$$` placeholders into the agent's env; the host's egress proxy substitutes the real value at the network boundary.

## Modes

```
off          no controls — raw creds in agent env (today's default)
cooperative  $$SECRET[NAME]$$ placeholders + BASE_URL envs + HTTP_PROXY env
strict       cooperative + sandbox-level enforcement (NAT or runtime mandate)
paranoid     strict + TLS-MITM (catches anything new)
```

Hosts pick which modes their tier policy exposes. Bootstrap consumers branch on the mode's **declarative flags** (`emitsPlaceholders`, `emitsBaseUrlEnvs`, …) — never on the id, so adding a new mode never edits a switch.

## Usage (host adapter)

```ts
import {
  proxyEgressRequest,
  COMMON_EGRESS_PROVIDERS,
  EgressError,
} from "@agentproto/egress"

// In your HTTP framework (Hono / Express / Bun):
const result = await proxyEgressRequest({
  request: {
    providerId: "openai",
    path: "/chat/completions",
    method: "POST",
    headers: req.headers,
    body: req.body,
    search: req.search,
  },
  providers: COMMON_EGRESS_PROVIDERS,
  resolver: async (name) => yourVault.lookup(guildId, name),
})

const upstream = await fetch(result.url, {
  method: result.method,
  headers: result.headers,
  body: result.body,
})

// Audit the substitutions
for (const r of result.substitutions) {
  yourAudit.log({ guildId, secretName: r.name, resolved: r.resolved })
}

return upstream
```

## Modules

- **`./modes`** — `EgressModeRegistry` + `DEFAULT_EGRESS_MODES`
- **`./providers`** — `EgressProvider` + `COMMON_EGRESS_PROVIDERS` (openai, anthropic) + `composeEgressProviders` for extending
- **`./proxy`** — `proxyEgressRequest` + `EgressError`

## Related

- **`@agentproto/secrets`** — declares `SecretExposure` shapes (env / file / egress-substitute) and the `$$SECRET[NAME]$$` substitution engine. This package depends on it.
- **AIP-19** — SECRETS.md doctype declares what secrets exist + how they're exposed
- **AIP-X (future)** — would standardize the egress mode taxonomy and the cooperative-mode wire shape

## License

MIT
