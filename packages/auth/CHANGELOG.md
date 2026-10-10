# @agentproto/auth

## 1.2.0

### Minor Changes

- 00fed67: Generalize opencode console workspaces into provider-agnostic sub-accounts. An auth profile can pin `subaccount: { kind, id, name? }` (an org / workspace / project of its account); a registry in `@agentproto/auth` (`registerSubaccountProvider`, `SubaccountProvider` with `list(account)` / `resolve(profile)`) applies the pin at spawn, so the runtime and auth packages no longer name any vendor. The opencode console implementation moved from `@agentproto/runtime` to `@agentproto/adapter-opencode` and is registered by the CLI at start-up. New `agentproto auth subaccounts list <profile|account> [--create [--prefix]]` and `auth profile create --subaccount <kind>:<id>`; `auth profile opencode-orgs` stays as a deprecated alias and legacy `source: "opencode-console:<orgId>"` profiles are migrated on read. Usage-limit failures name the profile and sub-account. `@agentproto/runtime` drops the `./opencode-console-source` export added by #1831 (never published in a release); use `@agentproto/adapter-opencode` instead. Consumers of `@agentproto/auth` outside the CLI must call `registerSubaccountProvider` before resolving or validating sub-account profiles (including legacy `opencode-console:` sources). `@agentproto/driver-agent-cli` honours `isolateDataHome: false` from a provider.
- c982376: opencode console workspaces (orgs) are now distinct, truthful wallets. opencode merges the active console org's provider block over every other config on start, so each spawn billed the active org whatever auth profile it named. A new source-backed api-key profile (`source: "opencode-console:<orgId>"`, no stored token) reads the console session read-only from `opencode.db`, fetches that org's provider block and injects the bearer plus block into the spawn; the new driver field `credentialDataHome` (opencode: `XDG_DATA_HOME`) runs an engaged-credential spawn in a login-less data dir, which also makes a plain api-key profile really bill its own key. An expired console session fails loud (never refreshed: the refresh token rotates). `agentproto auth profile opencode-orgs [--create] [--prefix <p>]` lists the console orgs and creates one profile per org. A `Go usage limit exceeded` failure (error event, session output, turn error) now names the wallet profile that hit it. Session usage and transcripts are read from the isolated opencode db when it exists.
- 00fed67: Generalize opencode console workspaces into provider-agnostic sub-accounts. An auth profile can pin `subaccount: { kind, id, name? }` (an org / workspace / project of its account); a registry in `@agentproto/auth` (`registerSubaccountProvider`, `SubaccountProvider` with `list(account)` / `resolve(profile)`) applies the pin at spawn, so the runtime and auth packages no longer name any vendor. The opencode console implementation moved from `@agentproto/runtime` to `@agentproto/adapter-opencode` and is registered by the CLI at start-up. New `agentproto auth subaccounts list <profile|account> [--create [--prefix]]` and `auth profile create --subaccount <kind>:<id>`; `auth profile opencode-orgs` stays as a deprecated alias and legacy `source: "opencode-console:<orgId>"` profiles are migrated on read. Usage-limit failures name the profile and sub-account. `@agentproto/runtime` drops the `./opencode-console-source` export added by #1831; it was never published (absent from 5.15.0), so use `@agentproto/adapter-opencode`. Consumers of `@agentproto/auth` outside the CLI must call `registerSubaccountProvider` before resolving or validating sub-account profiles (including legacy `opencode-console:` sources). `@agentproto/driver-agent-cli` honours `isolateDataHome: false` from a provider.

## 1.1.2

### Patch Changes

- 91d29b3: Windows P1 onboarding fixes (recap D7/E9/B4): the auth key store grows a Windows backend (one DPAPI-protected file per slot under `~/.agentproto/keychain-dpapi/`, .NET `ProtectedData` at `CurrentUser` scope via PowerShell — zero npm deps); `agentproto setup`/doctor gains a "Connect machines" step that prints the exact pairing commands for the chosen direction (pilot vs be piloted), and `/health` now reports the daemon's start-time PATH so the doctor's agents step can diagnose "installed in your shell but not visible to the daemon" with a `agentproto daemon restart` hint; the "no host matched" device error carries a pairing-direction hint.

## 1.1.1

### Patch Changes

- Updated dependencies [461df5e]
  - @agentproto/define-doctype@0.1.3

## 1.1.0

### Minor Changes

- 4612eda: Add `updateAuthProfile` (metadata-only patch for `label`/`costBudget`) to @agentproto/auth, exposed as the `auth_profile_update` MCP tool and a `PATCH /auth/profiles/:id` HTTP route in @agentproto/runtime. Tri-state per field: omit to leave, `null` to clear. Never touches credentials or `credentialRef`.

## 1.0.3

### Patch Changes

- bced1de: Document the full model-identity match set for `mode: "allow"` curation in `AuthProfile.models` JSDoc.
- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).

## 1.0.2

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/define-doctype@0.1.2

## 1.0.1

### Patch Changes

- 7a96351: Fix curation drift on `mode: "allow"` auth profiles: an allowlist generated once at create/import time was a frozen snapshot of the catalog that day — new models the catalog picked up later never became usable through the profile, and retired ones lingered forever, with nothing surfacing the mismatch. Adds an explicit, opt-in re-sync: `refreshAuthProfileModels` (`@agentproto/auth`) recomputes a profile's `ids` against a caller-supplied current-catalog snapshot, exposed as the `auth_profile_refresh_models` MCP tool and the `agentproto auth profile refresh-models <id>` CLI verb. Nothing calls this automatically — a profile is only touched when refreshed by name — and it rejects a `mode: "all"` profile outright, since that mode already tracks the live catalog on every read.
- f0c51a7: Weekly dependency bump: update 9 minor/patch dependencies to latest versions.
  - @anthropic-ai/claude-agent-sdk 0.3.241 → 0.3.251
  - @ast-grep/napi 0.45.2 → 0.45.3
  - @earendil-works/pi-tui 0.84.2 → 0.84.4
  - @tanstack/react-query 5.102.2 → 5.102.8
  - @testing-library/react 16.3.2 → 16.3.3
  - e2b 2.45.0 → 2.46.1
  - tsx 4.23.12 → 4.23.13
  - turbo 2.10.11 → 2.10.12
  - zod 4.4.3 → 4.5.4

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.

## 1.0.0

### Major Changes

- 8367648: rename auth 'vendor' axis to 'endpoint' in profiles and manifests. The v1
  `~/.agentproto/auth-profiles.json` disk format deliberately keeps `vendor` for
  backward compatibility; the public TypeScript API exposes only `endpoint`.

### Minor Changes

- 6ff42b4: feat(auth,runtime): auth-profile create/delete flow. Provision named subscription and api-key auth profiles from the daemon via the `auth_profile_create` / `auth_profile_delete` MCP verbs, backed by a `profile-provision` helper that writes the profile descriptor and stores the credential in the OS keychain. Surfaced in VS Code as a create/delete UI on the auth-profiles tree.
- 645279d: Add support for source-backed auth profiles — named profiles that resolve credentials fresh from self-refreshing sources (e.g. `claude-code-oauth`) instead of storing a static secret. Session spawn resolves source-backed profiles via Mode 3 credential resolution on every spawn; session restart explicitly rejects them (out of scope for restart, follow-up planned).
  - `AuthProfile.credentialRef` now optional, new mutually-exclusive `source` field
  - `validateCreateInput` enforces exactly one of `credential`/`source` for oauth-bearer, requires `credential` for api-key
  - Session spawn: source-backed profiles resolve fresh credential each time via `resolveSubscriptionCredential`
  - Session restart: source-backed profiles fail loud with `RestartOverrideError`
  - New tests: profile provisioning with source, session spawn with source, restart rejection of source

- f3f5e82: Add profile enable/disable (WS2), per-model curation (WS3), and server-side credential identity display (WS5) features.

  **WS2 — Whole-profile disable**: New `disabled?: boolean` field on `AuthProfile` and `setAuthProfileEnabled()` function enable/disable a profile entirely, dropping all its models to non-runnable. The `eligibleProfiles()` predicate skips disabled profiles at the endpoint/method gate.

  **WS3 — Per-model curation**: New `models?: ModelCuration` field on `AuthProfile` and `setAuthProfileModels()` function restrict a profile to specific models via an allow-list. Curated profiles stay endpoint-eligible but only their chosen refs become runnable. The curation filter is applied downstream in the catalog join.

  **WS5 — Credential identity**: New `credentialIdentity()` function computes a read-only identity (fingerprint + last4 tail) server-side from the keychain, never exposing the secret. `auth_profile_list` MCP tool output now includes key status (`stored` / `self-refreshing` / `unavailable`) and identity for stored secrets. VS Code UI displays the tail and fingerprint in the profile row.

  All changes maintain backward compatibility: absent `disabled` means enabled; absent `models` means mode "all". Profiles without these fields parse and round-trip byte-identically to pre-feature versions.

- 655b4b6: Add windowed cost-budget caps and opt-in live remaining-quota enrichment for usage rollup

## 0.2.0

### Minor Changes

- a0b94fd: Republish auth (eligibleProfiles export, added in #470 but never versioned)
  and app-kit (WorkspaceShorthand / optional `workspace` on AppDefinition,
  added in #468 but never versioned) to fix npm publish skew — #468 touched
  `packages/app-kit/src/types.ts`, not `@agentproto/workspace`, so app-kit is
  the stale published artifact, not workspace.

## 0.1.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/define-doctype@0.1.1

## 0.1.0

### Minor Changes

- c359894: Add pluggable CredentialStore (Keychain/Memory/File) and CredentialBroker.resolveHeaders
- 83ce80f: Add device-code RFC 8628 flow engine with daemon credential persistence
- c69d424: Add optional audience scoping to auth providers and CredentialBroker
- d993560: Add openBrowser opt-out to FlowRunOptions; dedupe legacyRef via resolveStoreRefs
- 9fe8586: Add refreshOnly mode + CeremonyRequiredError; honor --no-browser; silent serve refresh

### Patch Changes

- 829a6c0: Document credential store, broker resolveHeaders, and mcp-header exposure
- 547c796: Extract shared RFC 8628 device-grant poll primitive into internal flow-engines/device-grant.ts
- e94757d: Add broker-resolved provision auth headers; export resolveProvisionHeaders and main
- da9f77a: Add auth skill doc and include skill/ dir in package files
