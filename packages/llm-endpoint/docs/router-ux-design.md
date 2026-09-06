# Local Router: llm-endpoint as a first-class panel provider

**Status:** Draft / for discussion — not a commitment to build.
**Audience:** the maintainer deciding whether and how to build this.
**TL;DR:** Model the `llm-endpoint` proxy as one self-hosted "Local Router"
provider (your own OpenRouter), picked on the normal auth page like any other.
Quarantine all of its setup complexity behind a dedicated Settings surface.
Link each upstream to an *existing* credential instead of re-entering keys.
Fronting a **subscription** (not an API key) is **not** a separate heavy
workstream: it falls out of the same "unify the credential source" work,
because a linked `oauth-bearer` auth-profile already carries a stored
`Authorization: Bearer` token. One credential model, one header-shape branch
(`api-key` → `x-api-key`; `oauth-bearer` → `Bearer`).

---

## Status (implemented)

The core of this proposal has shipped. Where the design below and the shipped
code diverge, the code wins — the notable correction is the credential
mechanism (§2.3/§2.4): upstreams resolve from the named **`AuthProfile` store +
`KeychainStore`**, *not* a `CredentialBroker` (that broker is for AIP-50
CLI-login flows and doesn't handle `anthropic`).

| Slice | PR | State |
|---|---|---|
| Daemon-supervised proxy lifecycle (start/stop/status verbs) | **#693** | merged |
| Credential unification — upstreams resolved from named profiles; `api-key` + anthropic `oauth-bearer` sub support, **fail-closed** (OAuth is only ever sent to the `anthropic` upstream; every other path 401s) | **#694** | merged |
| VS Code "Local Router" panel node — status, start/stop, live `/v1/models` discovery + `owned_by`-aware pricing | **#695** | merged |
| Packs UI + validation + hot-reload | **PR-4** | pending |
| Register the `agproxy` catalog route so proxy models are selectable/runnable in the picker | **PR-5** | pending |
| Config UX — credential-linking dropdowns + per-upstream key status/test | **PR-6** | pending |

**Deferrals.** Source-backed self-refreshing profiles (e.g. a
`claude-code-local` profile that re-mints its own token) are **not yet
supported by the proxy** — stored-token subscriptions work, a live self-refresh
source does not. `KeychainStore` is **macOS-only**; on other platforms the proxy
falls back to the per-provider env key.

---

## 1. What the proxy actually is today

Ground truth from a source audit. State these accurately — the design leans on
every one of them.

- **API-key-only multiplexer over 7 upstreams.** `anthropic, openai, moonshot,
  openrouter, requesty, zai` (Zhipu/GLM), `groq, xai`. Provider switch at
  `src/index.ts:202-222` (`getChatCompletionsEndpoint`) and `:1571-1735` (the
  Messages routing switch). Keys resolved one env var per provider —
  `resolveSecretKeys` `src/index.ts:181-192`.
- **No subscription / OAuth support.** `grep -i 'oauth|OAT|subscription'` over
  the package = zero hits. Anthropic upstream sends `x-api-key`
  (`src/index.ts:1577`); every other upstream sends `Authorization: Bearer
  <api-key>`. **A Claude Max/Pro subscription cannot be fronted through the
  proxy today.**
- **The subscription capability is real, but lives in a *different*
  subsystem.** `@agentproto/auth` profiles (`oauth-bearer`,
  `source:"claude-code-oauth"`, `profile-types.ts:17-21,81-87`) resolved by
  `resolveAuthSpec` at session spawn (`packages/runtime/src/spawn-defaults.ts:392-433`),
  which spawns the `claude` CLI **directly** against Anthropic. No proxy is in
  that path. This is exactly what a `claude-code-local` profile is.
- **Two separate credential stores.**
  - Proxy keys: `~/.agentproto/providers.json`
    (`packages/providers-store/src/index.ts:68-80`), shape
    `{ apiKey, baseUrl, updatedAt }` — note there is **no token-kind field**.
    Injected as env at proxy boot (`cli.ts:41-48`).
  - Auth profiles: `auth-profiles.json` + keychain. **Different store,
    different shape, different lifecycle.**
- **Packs.** `ModelPack` / `ModelRoute` (`packs.ts:10-46`), `PACK_REGISTRY`
  (`packs.ts:249-257`). The local override `packs.local.json` is
  **hand-authored, unvalidated** (`index.ts:73`, literally `// TODO: validate`)
  and **restart-only reload** (`packs.local.example.ts:28-30`).
- **Thin discovery.** `GET /v1/models` (`index.ts:1471-1516`) returns ids +
  `owned_by` and **zero pricing/capabilities** (`capabilities:{}`).
- **Access gate is off by default and mis-wired.** Server reads
  `LLM_ENDPOINT_ACCESS_TOKENS` (`index.ts:1157-1195`); the client-side preset
  reads `keyEnv: "LLM_ENDPOINT_API_KEY"`
  (`provider-presets/src/anthropic-gateways.ts:88-100`). If a user turns the
  gate on, the two env-var names don't match → **silent 401**.
- **Not in the daemon lifecycle.** The proxy is a **manual sidecar**
  (`pnpm --filter @agentproto/llm-endpoint serve`). The daemon only knows it as
  a base-URL preset (`anthropic-gateways.ts:88-100`); nothing starts, stops, or
  health-checks it.

**One-line takeaway:** the routing engine is solid; everything *around* it —
credentials, lifecycle, discovery, packs authoring — is raw.

---

## 2. The proposal

### 2.1 Model the proxy as one "Local Router" provider

On the normal auth-profiles page, the proxy shows up as a **single provider**
(proposed id `agproxy`), chosen exactly like `openrouter`. A user who just wants
to route through it picks it, points at a model, done. **All setup complexity is
quarantined** in a separate Settings surface (§2.2). The mental model is "my own
self-hosted OpenRouter."

### 2.2 Two-surface split

```
┌─ Auth Profiles (normal page) ───────────────┐   ┌─ Settings ▸ Local Router ───────────────────────────┐
│                                              │   │  proxy: ● running   :18090   [Stop] [Restart] [Logs]│
│  Provider:  [ agproxy  ▼ ]                   │   │  access token: ******   base URL: http://localhost │
│  Model:     [ kimi-k2.7-code       ▼ ]       │   │─────────────────────────────────────────────────────│
│             ↑ runnable state derived         │   │  Upstreams                                          │
│               from Settings ▸ Local Router   │   │   anthropic   ● link ▸ [claude-code-local ▼] ✓ sub  │
│                                              │   │   openai      ● link ▸ [openai-primary     ▼] ✓ test│
│  [ Create profile ]                          │   │   moonshot    ● own  ▸ key ****            ✓ test   │
│                                              │   │   openrouter  ○ (unlinked)                          │
│  agproxy behaves like any other provider.    │   │   requesty    ○ (unlinked)                          │
│  No proxy internals leak onto this page.     │   │   zai         ● link ▸ [zhipu-main   ▼]    ✓ test   │
│                                              │   │   groq        ○ (unlinked)                          │
│                                              │   │   xai         ● own  ▸ key ****            ✗ 401    │
│                                              │   │─────────────────────────────────────────────────────│
│                                              │   │  Packs   [default ▼]  [Edit JSON] [Validate] [Reload]│
└──────────────────────────────────────────────┘   └─────────────────────────────────────────────────────┘
```

- **Normal page:** `agproxy` = a plain provider. Per-model runnability is
  *derived* — a model whose upstream has no linked/owned credential renders as
  not-runnable, with a link back to Settings.
- **Local Router page:** everything hairy — lifecycle, the 7 upstreams (8 if
  `zai` env-alias variants are surfaced separately), each with its credential
  link + a pre-flight test, the packs editor with validation, and access
  token / base URL / port.

### 2.3 Credential-linking (link-or-own)

Each upstream either **links an existing auth-profile** (matched by endpoint) or
**owns a proxy-specific key**. Default = link; escape hatch = own.

```
  upstream (anthropic)
      │  default
      ▼
  link ──▶ auth-profile "claude-code-local"   ← reuse what's already configured
      │
      └─ own ──▶ proxy-specific key            ← escape hatch, stored for the proxy only
```

**The enabler is unifying the credential source.** Today the proxy reads
`providers.json` and the panel reads `auth-profiles.json` — two stores, so any
key the user already set for direct spawning has to be **re-entered** for the
proxy. As shipped (#694), the proxy resolves each upstream's credential from the
named **`AuthProfile` store + `KeychainStore`** — the same path the daemon's own
call sites use — keyed by an env var `LLM_ENDPOINT_PROFILE_<PROVIDER>=<profileId>`
that names which profile backs each upstream. When no profile is linked, the
proxy falls back to the per-provider env key, killing the double-entry without
breaking the old flow.

> **Not the `CredentialBroker`.** An earlier draft routed this through
> `@agentproto/auth`'s `CredentialBroker.resolveHeaders`. That was wrong: the
> broker is for AIP-50 CLI-login flows (only `"guilde"` is registered; it
> *throws* on `"anthropic"`). The shipped path is the `AuthProfile` store +
> `KeychainStore`, not the broker.

**"Link" now covers subscriptions too, not just API keys.** An auth-profile
carries the credential *kind* as `method: "oauth-bearer" | "api-key"`
(`profile-types.ts:17-21`). Resolving an `oauth-bearer` profile (a Claude sub,
`source:"claude-code-oauth"`) from the store yields a stored
`Authorization: Bearer` token just as an `api-key` profile yields its key — so
linking a subscription is the same gesture as linking a key. The profile's
`method` then **drives the outbound header shape automatically** (see §2.4): the
proxy never has to ask the user "key or sub?" — the linked profile already says
which. **Fail-closed:** the resolved OAuth bearer is only ever sent to the
`anthropic` upstream; any other upstream receiving an `oauth-bearer` credential
401s rather than leaking it.

### 2.4 Subscriptions ≠ API keys — but it's one header branch, not a new workstream

Earlier drafts treated "front a subscription through the proxy" as a distinct,
heavy feature. It isn't. Once §2.3 resolves every upstream from the
`AuthProfile` store, subscription support is **one branch on the credential
kind**, sharing the exact same resolve path as an API key.

- **The store already holds a valid token.** An `oauth-bearer` profile carries
  its stored bearer token (via `KeychainStore` on macOS), and the proxy reads it
  straight from the store — the same way the daemon's own call sites do. A
  stored subscription token arrives at the proxy ready to send. *(Note the
  deferral: the proxy does not yet drive a **self-refreshing source** to re-mint
  an expired token — see §5.1 and the Deferrals note above.)*
- **All the proxy adds is a header-shape branch.** Today anthropic sends
  `x-api-key` (`index.ts:1577`); every other upstream sends `Bearer <api-key>`.
  The unified path becomes: resolve the credential from the store, then branch
  on the profile's `method` (`profile-types.ts:17-21`):
  - `api-key` → `x-api-key` (anthropic) / `Authorization: Bearer` (others), as today.
  - `oauth-bearer` → `Authorization: Bearer <oat>` **plus**, for anthropic, the
    OAuth beta header (see Job-1 finding below). Fail-closed: this branch is
    **anthropic-only** — an `oauth-bearer` credential aimed at any other upstream
    401s instead of being forwarded.
- **The one anthropic-specific header is known in-repo, not opaque.** An
  OAuth-bearer request to `api.anthropic.com/v1/messages` needs
  `anthropic-beta: oauth-2025-04-20` alongside `anthropic-version: 2023-06-01`
  and the `Bearer` — and this repo **already constructs exactly that request**
  in `remaining-quota.ts:267-283` (constants at `:179,:181`; the `:180` comment:
  *"Beta header Claude Code's OAuth bearer requires on the messages endpoint"*).
  It's a *live, working* probe against the real endpoint, so the proxy
  **mirrors the exact header** rather than reverse-engineering it.
- **`providers.json` still needs no token-kind field.** The kind lives on the
  auth-profile (`method`), which is what the proxy branches on — the per-provider
  env key stays the own-key fallback only.

The existing direct-spawn path (`resolveAuthSpec`, `spawn-defaults.ts:392-433`)
still routes a subscription straight to Anthropic with no proxy, and remains the
right answer when you don't want the proxy in the path. Proxying a sub is now a
*choice*, not a blocked capability.

---

## 3. Friction → fix (from the audit)

| # | Friction (source) | Fix |
|---|---|---|
| 1 | Access-token env-var mismatch: server reads `LLM_ENDPOINT_ACCESS_TOKENS` (`index.ts:1157-1195`), preset sends `LLM_ENDPOINT_API_KEY` (`anthropic-gateways.ts:88-100`) → silent 401 | Single source of truth for the token name; panel sets both sides from one field |
| 2 | Packs `packs.local.json` hand-authored, unvalidated (`index.ts:73` `// TODO: validate`) | Schema-validate on write; packs editor rejects bad JSON before save |
| 3 | Packs reload is restart-only (`packs.local.example.ts:28-30`) | Hot-reload endpoint / file-watch; "Reload" button in the packs editor |
| 4 | No lifecycle mgmt — manual `pnpm … serve` sidecar; daemon only knows a base-URL preset | Daemon-managed start/stop/status (§4 step 1) |
| 5 | No set-key MCP verb — keys only via `providers.json` on disk | Add a `set-key` verb writing through the unified store |
| 6 | Discovery `/v1/models` has no pricing/capabilities — `capabilities:{}` (`index.ts:1471-1516`) | Cross-reference the model-catalog for pricing at render time |
| 7 | `/v1/{pack}/v1/messages` silent-fallback trap — a mistyped/unknown pack segment routes to the default pack instead of erroring | Validate pack id in the router; 404/400 on unknown pack rather than silent default |

---

## 4. Recommended build sequence

Each step is a clean, independently-shippable PR. Steps 1–3 have shipped (see
the Status table); the PR numbers are noted inline.

1. **Daemon-managed lifecycle + status.** Start/stop/restart/health for the
   proxy as a supervised process instead of a manual sidecar. Unblocks
   everything else — the panel needs something to talk to. (Fixes §3.4.)
   — **shipped, #693.**
2. **Local Router card + live discovery + catalog cross-ref.** Render the card,
   call `/v1/models`, join against the model-catalog for `owned_by`-aware
   pricing/capabilities the discovery endpoint lacks. (Fixes §3.6.)
   — **shipped, #695.**
3. **Credential unification (store-resolved upstreams) + subscription support.**
   Resolve every upstream's credential from the named `AuthProfile` store +
   `KeychainStore` (kills double-entry, §2.3), keyed by
   `LLM_ENDPOINT_PROFILE_<PROVIDER>`, with a per-provider env-key fallback and
   per-upstream ✓/✗ from a real ping. Because the store resolves `oauth-bearer`
   and `api-key` the same way, **subscription support is folded in here**, not
   deferred: the only added code is the header-shape branch on the profile's
   `method` — and for anthropic `oauth-bearer`, the known
   `anthropic-beta: oauth-2025-04-20` header mirrored from
   `remaining-quota.ts:267-283`, sent **only** to the anthropic upstream
   (fail-closed). (Fixes §3.5, §3.1; delivers §2.4.) — **shipped, #694.**
4. **Packs UI + validation + hot reload.** Editor that validates against the
   `ModelPack` schema and reloads without a restart. (Fixes §3.2, §3.3, §3.7.)
   — **pending (PR-4).**
5. **`agproxy` catalog route.** Register the route so proxy models are
   selectable/runnable in the picker. — **pending (PR-5).**
6. **Config UX.** Credential-linking dropdowns + per-upstream key status/test.
   — **pending (PR-6).**

Steps 1–4 deliver the "self-hosted OpenRouter" experience for API keys **and**
subscriptions — there is no separate heavy PR for OAT. The subscription header
shape is one branch inside step 3's credential-unification work.

---

## 5. Open questions

1. **Does forwarding a stored `Bearer` OAT to `api.anthropic.com` need an extra
   header — and is it discoverable?** *(Was: "is OAT-through-proxy in scope?")*
   **Resolved, shipped in #694.** Yes, one extra header is required beyond
   `Authorization: Bearer <oat>` — `anthropic-beta: oauth-2025-04-20` (with
   `anthropic-version: 2023-06-01`). It is **not** opaque inside the `claude`
   binary: this repo already builds that exact OAuth-bearer request against the
   real messages endpoint in `remaining-quota.ts:267-283` (constants `:179,:181`,
   comment `:180`). The shipped proxy mirrors those three headers verbatim, and
   sends them **only** to the anthropic upstream (fail-closed). The only residual
   risk is drift if Anthropic bumps the beta tag — a one-constant change.

   *Note on durability — the live deferral.* OATs expire. The proxy reads a
   **stored** `oauth-bearer` token from the `AuthProfile` store, so a stored
   subscription token works while it is valid, but the proxy does **not yet**
   drive a **self-refreshing source** (`source:"claude-code-oauth"`, e.g. a
   `claude-code-local` profile) to re-mint an expired one. A stored token and a
   self-refreshing source are consumed the same way once resolved (same `Bearer`
   header, same branch); wiring the proxy to *trigger* the refresh is the
   outstanding piece.
2. **Where does the Settings surface live?** A native VS Code view vs a webview.
   Lifecycle controls and a JSON packs editor push toward a webview; a simple
   status list is fine as a native tree.
3. **Pricing source of truth for discovered models.** `/v1/models` returns none;
   the model-catalog is the obvious join, but discovered/local-pack models may
   have no catalog entry. Fall back to "unknown price," or require a
   catalog match before a model is marked runnable?
4. **`zai` counting — 7 upstreams or 8?** `resolveSecretKeys` treats Zhipu as a
   single `zai` provider with two env aliases (`ZHIPUAI_API_KEY` /
   `ZAI_API_KEY`, `index.ts:187`). The UI can present 7 real upstreams; whether
   the alias pair warrants a second row is a cosmetic call.
5. **Own-key vs linked precedence.** If an upstream has *both* a linked profile
   and an owned key, which wins? Proposal: explicit own-key overrides the link,
   but this should be a visible toggle, not implicit.
