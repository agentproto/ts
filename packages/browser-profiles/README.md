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
