---
name: auth
description:
  Authenticate an agentproto agent or MCP connector to a service via
  @agentproto/auth's credential broker — declare an auth provider
  (pat / service-auth / device-code), store the credential ONCE in a
  CredentialStore, and resolve fresh Authorization headers at call/connect
  time. Use to wire a Bearer/OAuth API (agentpush, a hosted MCP server, an
  internal service) into an agent WITHOUT putting secrets in env vars or
  .mcp.json.
metadata:
  tags: agentproto, auth, aip-50, credentials, broker, mcp, secrets, bearer, oauth
---

## When to use

Reach for this whenever an agent (or a child MCP it mounts) must present a
credential to a remote service and you don't want that secret sprayed into the
daemon's global env or hardcoded in a config file. The hallmark: "how do I give
this agent access to `<service>` without leaking the key to every other agent?"

- A tool/agent calls a Bearer API (agentpush, Stripe, an internal API).
- A hosted/remote MCP server needs an `Authorization` header.
- You want ONE place to store a key, scoped per service, resolved fresh (with
  refresh) at use-time instead of a long-lived env var.

Do NOT use for the daemon's own tunnel login (that's `agentproto auth login`, a
device-code flow already wired) — though it uses the same substrate underneath.

## The model — one source of truth, resolved on demand

```
auth provider (declares WHERE/HOW)  ──┐
CredentialStore (holds the secret)  ──┤─▶ CredentialBroker.resolveHeaders({ path, audience })
                                       │        → { Authorization: "Bearer …" }  (fresh, per call)
```

- **Provider** — a manifest declaring a service's `id`, `apiBase`, and `auth`
  flow. Config only, never the secret. Registered once (`registerAuthProvider`).
- **CredentialStore** — where the secret lives: `KeychainStore` (macOS CLI),
  `FileStore` (AES-256-GCM, headless — key from `AGENTPROTO_STORE_KEY`),
  `MemoryStore` (tests). Swap the backend, same interface.
- **Broker** — `resolveHeaders({ path, audience?, signal? })` turns a provider
  `path` into ready-to-use headers: serves a fresh stored bearer, else runs the
  flow. `audience` (`api` / `mcp` / `tunnel`) scopes the credential so it can't
  be reused cross-plane.
- **Flows** — pick one per service: `pat` (static token you store/paste),
  `service-auth` (auth.md claim ceremony → short oat + durable assertion),
  `device-code` (RFC 8628 → durable daemon token + refresh).

## Recipe

### 1. Declare + register the provider

TS literal (builtin/tests):
```ts
import { defineAuthProvider, registerAuthProvider } from "@agentproto/auth"

registerAuthProvider(defineAuthProvider({
  id: "agentpush",
  description: "AgentPush API — paste a personal API key.",
  apiBase: "https://api.agentpush.example",
  audience: "mcp",                       // or "api"
  auth: { flow: "pat", tokenStore: { keychain: "agentpush", account: "{server}" } },
}))
```
Or ship a vendor `*.auth.md` and `parseAuthProviderManifest(...)` → `registerAuthProvider(...)` — a host adds providers without editing this package.

### 2. Store the secret ONCE (out of env, into the store)

```ts
import { KeychainStore, resolveStoreRef, getAuthProvider } from "@agentproto/auth"

const p = getAuthProvider("agentpush")!
const store = new KeychainStore()               // or FileStore for headless
await store.write(resolveStoreRef(p.auth.tokenStore, p.apiBase, p.audience),
                  { value: process.env.AGENTPUSH_API_KEY!, kind: "pat" })
```
Do this once (onboarding / a `secrets set` step) — then delete the env var.

### 3. Resolve at use-time

```ts
import { CredentialBroker, getAuthProvider } from "@agentproto/auth"

const broker = new CredentialBroker({ store, getProvider: getAuthProvider })
const headers = await broker.resolveHeaders({ path: "agentpush", audience: "mcp" })
// → { Authorization: "Bearer …" }  — attach to your fetch / MCP transport
```
Fresh every call; for `service-auth`/`device-code` it auto-refreshes. No secret
touches env or `.mcp.json`.

## Two consumption paths

**A. Agent calls the service in its own code/tool.** Works TODAY: resolve via the
broker (step 3) and attach the header. Nothing else to wire.

**B. Service exposed as a child MCP the agent mounts.** `agent_start.mcpServers[]`
entries carry `{ name, transport, ref?, headers?, credentialRef? }`
(`packages/runtime/src/agent-tools.ts`). Set `credentialRef` to a broker path
and `session-spawn.ts`'s `resolveMcpCredentialHeaders` resolves it into
`headers` at spawn time — merged ON TOP of any static `headers` on the same
entry, then the `credentialRef` itself is dropped before the child ever sees
it (the secret never lives in the child's env or config). Runtime stays
auth-free: it calls a `resolveMcpCredentialHeaders` hook it doesn't implement
(`packages/runtime/src/mcp-credential-deps.ts`, `setMcpCredentialDeps`); the
CLI wires that hook to a real `CredentialBroker` in
`packages/cli/src/commands/serve.ts` (`resolveHeaders({ path: credentialRef,
audience: "mcp" })`). Resolution failures (missing provider, no keychain,
expired credential) are caught and logged as warnings — they never kill the
spawn, so an agent that can't resolve its credential mounts the MCP without
that header rather than failing to start.

## Worked example — agentpush

agentpush uses a static Bearer key. Clean-auth wiring:
1. Register `agentpush` as a `pat` provider (step 1), `audience: "mcp"`.
2. Move `AGENTPUSH_API_KEY` from the daemon env into the store (step 2).
3. In-code callers resolve `broker.resolveHeaders({ path: "agentpush" })` (path A) —
   works now, key out of the global env, scoped to this agent.
4. For agentpush-as-child-MCP (path B), pass
   `credentialRef: "agentpush"` on the `agent_start.mcpServers[]` entry —
   the daemon resolves it to an `Authorization` header at spawn time, no
   other wiring needed.

## Common mistakes

- **Storing the key in the daemon's global env** — every spawned agent inherits
  it. The whole point of the store is per-service, per-spawn scoping.
- **Skipping `audience`** — set it (`api`/`mcp`/`tunnel`) so a credential minted
  for one plane can't be presented on another (defense-in-depth; the normative
  boundary is server-side).
- **Caching `resolveHeaders` output** — resolve per call; the broker owns
  freshness/refresh. A cached header defeats `service-auth`/`device-code` refresh.
- **`pat` where the service issues short-lived tokens** — use `service-auth`
  (mint + refresh) instead of pasting a token that expires.
- **Wrong header shape** — `resolveHeaders` returns a header map; a service that
  wants `X-Api-Key` (not `Authorization`) needs the provider/flow to emit that
  shape, not a Bearer.
