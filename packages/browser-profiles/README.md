# @agentproto/browser-profiles

The public half of the browser session and profile model.

- **Session descriptors.** `SessionDescriptor` and its zod schemas: which backend a saved session uses, who it is for, and where its cookies come from (`chrome-cookie`, `authed-storageState`, `stored-credential`, or a registered source). Descriptors written by earlier code load unchanged; unknown keys are kept and `parseSessionDescriptor` returns the document as written.
- **Stores.** `fileSessionStore` (0700 directory, 0600 files), `compositeSessionStore`, and `catalogSessionStore` (read-only view over a managed catalog).
- **Chrome profiles.** `parseLocalState` and `readLocalState` (the one `Local State` implementation, also used by `@agentproto/plugin-local-browser`), `scanChromeIdentities`, and `createLocalBrowserSession` for in-memory, per-domain cookie reads. Nothing is persisted and cookie values are never logged or written into descriptors.
- **Camofox.** `openSession` reuses one tab per `userId`: cookie injection, navigation, evaluation, basic input, screenshots and server-side network capture. `fetch` and the state file are injectable.
- **Resolve.** `resolveSession(descriptor, deps)` turns a descriptor into a live driver or camofox session.
- **Launch safety.** `assertChromeLaunchDirSafe` delegates to the kit's F11 refusal (`browser:profile-refused`). This package only reads profiles; it never launches Chrome against a default user-data-dir.

## Injection seams

```ts
import {
  createAuthSignalRegistry,
  createSessionSourceRegistry,
  resolveSession,
} from "@agentproto/browser-profiles"

// 1. "Am I signed in" detectors. None ship; the host knows its sites.
const authSignals = createAuthSignalRegistry([
  { domain: "example.com", cookieNames: ["session_id"] },
])

// 2. A registry of cookie sources that live somewhere this package knows nothing about.
const sources = createSessionSourceRegistry([
  { kind: "vault", materialize: async ({ sessionRef, domains }) => [/* cookies */] },
])

// 3. Optional sub-account switcher. Default: none. A descriptor that pins an
//    account without a hook is a typed error (AccountSwitcherMissingError).
const session = await resolveSession(descriptor, {
  authSignals,
  sources,
  accountSwitcher: (platform, jar, userId) => jar,
})
```

A detector sees cookie names and expiry only, never values. A domain with no registered detector is `unknown`, never `authed`. A failed cookie-store read is `unknown` too, never "not logged in".

## Consent, grants and the ledger

Importing cookies from a Chrome profile is a recorded, revocable grant (AIP-63 draft, number provisional).

- **Explicit domains only.** `validateGrantDomains` rejects `*`, `*.example.com`, a bare TLD, a leading dot, a public suffix and an empty list, each with a typed `GrantDomainError`.
- **Per-domain consent.** `createConsentHost({ prompt })` asks a human once per domain through the injected `ConsentPrompt`, after a presence scan that reports counts only. Without a `prompt` the host is non-interactive: `importFromChrome` fails with `NonInteractiveConsentError` unless the caller passes `domains` and `yes`.
- **Remote sinks.** A grant that also feeds a remote sink needs an explicit sink acknowledgement, recorded as its own ledger row.
- **Per device.** A grant carries the paired device fingerprint. `host.cookieSourceFor({ deviceId })` serves only that device's active grants; another device gets `browser:consent_required`. Revoking a pairing stops honoring its grants (`isDevicePaired`).
- **Full profile.** `grantFullProfile` records `fullProfile: true`, local sink only, and returns `FULL_PROFILE_WARNING`. `host.fullProfileProof(...)` is what `@agentproto/driver-browser` asks for before it honors `--full-profile`. The kit still never launches against the default user-data-dir, and revocation takes effect at the next launch.
- **Ledger.** `createConsentLedger({ path })` appends one JSON row per grant, revoke, sink acknowledgement and agent denial to `~/.agentproto/bureau/consent.jsonl` by default (file 0600, directory 0700). Rows are hash-chained (`seq`, `prev`), carry counts and salted cookie-name hashes, and never a cookie value. `verifyChain()` detects edits.
- **Revoke.** `host.revoke(grantId)` deletes the derived cookie jar, recomputes the session descriptor, calls the optional `deleteExtraDerived` hook (for example a profile clone) and appends a revoke row. It is idempotent.
- **Agents.** `createAgentConsentSurface(host)` lets an agent refresh and revoke. It cannot grant, add a domain, add a sink or change the profile; each refusal appends a `deny` row and throws `AgentGrantRefusedError`.
- **Doctor.** `runDoctor({ port, profile })` checks that `Local State` is readable and the Cookies db is copyable. EPERM is reported as a missing Full Disk Access grant and names the exact binary. The Keychain is probed only with `checkKeychain: true`. Any failure recommends native login.

Cookie values are never logged, returned or written to the ledger. Grants and derived cookies are stored unencrypted (encryption at rest is out of scope for now).

## What stays private

Kept out of this package on purpose:

- Any concrete managed-session backend (a host registers its own `SessionSource`).
- Credential capture and outreach tooling.
- Account-switching policy (this package only defines the hook).
- Per-site auth registries and site knowledge.
- Human-mode pacing and anti-bot handling in the camofox client.

Encryption of stored sessions is out of scope.

## Tests

Tests use synthetic temp directories only. A vitest setup file wraps the fs and child_process entry points and fails any test that touches a real Chrome, Chromium, Brave or Edge profile directory or asks the macOS Keychain for a key.
