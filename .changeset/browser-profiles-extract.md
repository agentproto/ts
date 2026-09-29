---
"@agentproto/browser-profiles": minor
"@agentproto/plugin-local-browser": patch
---

Add `@agentproto/browser-profiles`: the public half of the browser session and profile model. Saveable session descriptors with zod schemas (descriptors written by earlier code load unchanged), Chrome `Local State` parsing and profile discovery, in-memory cookie reads from a synthetic or local Chrome user-data-dir, camofox tab reuse per `userId`, and three typed injection seams: `AuthSignalRegistry` (per-site "signed in" detectors, none built in), an optional `accountSwitcher` hook (default none), and a `SessionSource` registry (register, list, resolve by kind; an unknown kind throws `SessionSourceUnknownError`). Launching Chrome against a default profile stays refused by the kit (`browser:profile-refused`). `@agentproto/plugin-local-browser` now imports its `Local State` parsing from this package instead of keeping a second copy.
