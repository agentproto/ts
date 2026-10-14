# File-based ("use my existing login") subscription auth

This note documents the second shape of subscription billing-auth added on top
of #640's bearer-injection path, and records exactly what each remaining CLI
needs to adopt it.

## Two shapes of "use my existing login"

A subscription (non-API-credit) login can reach a daemon-spawned CLI two ways:

1. **Bearer-injection** — the runtime reads the OAuth bearer fresh from the
   local login and INJECTS it into an env var the CLI consumes
   (`authSubscription.setEnv`). Claude Code: `claude-code-oauth` recipe →
   `CLAUDE_CODE_OAUTH_TOKEN`. This is #640.

2. **File-based / external** — the CLI reads its OWN login file itself; there is
   no env-bearer channel. The runtime injects NOTHING. It only:
   - **verifies** the login is present (fail-loud) before the spawn, and
   - **scrubs** the api-key env vars so a stray key can't silently flip the
     spawn to per-token API billing under a "subscription" label.

   Declared by `authSubscription: { external: true }` (no `setEnv`). Resolves to
   a `ResolvedAuthSpec` with `externalCredential: true`, empty `setEnv`, no
   `credential`, and `unsetEnv = [provider api-key var, ...conflictEnv]`. The
   driver applies the scrub and skips the credential requirement. Echo:
   `credentialSource: "cli-local-login"`, fingerprint `subscription · local-login`.

   **Money-safety is structural**: no bearer is ever written into any env var,
   so an OAuth token cannot land in an api-key channel — the failure mode this
   whole surface exists to prevent. The worst case (a scrub miss) degrades to
   the CLI's own auth precedence, never to an injected mis-billing.

## Codex — shipped (this PR)

Codex's ChatGPT/subscription login lives in `~/.codex/auth.json`
(`tokens.access_token`), read by the bundled runtime itself; `OPENAI_API_KEY`
is a separate api-key rail. So codex is a textbook file-based case:

- `adapters/codex`: `authSubscription: { external: true, conflictEnv: ["CODEX_API_KEY"] }`
  (provider `openai` ⇒ `OPENAI_API_KEY` scrubbed automatically).
- Login presence verified via the existing `codex` provision recipe
  (`packages/secrets/.../builtins.ts`), reused as a fail-loud probe.
- VSCode connect action "Use my existing Codex login" (`source: "codex"`,
  endpoint `openai`).

An unconfigured codex spawn stays ambient — codex's own precedence already
prefers a ChatGPT login over an ambient `OPENAI_API_KEY` — so this only ADDS an
explicit, verified, billing-guaranteed, observable opt-in.

## Gemini — shipped (`@agentproto/adapter-gemini`)

Gemini's subscription login (`~/.gemini/oauth_creds.json` + the
`GOOGLE_GENAI_USE_GCA` code-assist path) is ALSO file-based and reuses the
exact primitive above. `@agentproto/adapter-gemini` shipped in this release
with:

1. A native AIP-45 adapter wrapping `gemini --experimental-acp`.
2. `provider: "google"` and `authSubscription: { external: true, conflictEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] }`
   scrubbing both sibling api-key vars so a leftover key can't override the
   OAuth login.
3. Login presence verified fail-loud via the `gemini` provision recipe.
4. VSCode connect action "Use my existing Gemini login" (`source: "gemini"`,
   endpoint `google`, `method: "oauth-bearer"`, `credentialFile:
   "~/.gemini/oauth_creds.json"`).

Nothing in the daemon primitive is Gemini-specific; it dropped in as a third
row once the native adapter existed.

## Inside a sandbox box — the box-login bridge (codex, opencode)

A sandbox box boots with a fresh filesystem, so the host's login file is not
there. For codex and opencode, an adapter's `authSubscription.boxLogin`
declaration (`recipe`, optional `methodId`, a `keep` allowlist of dotted JSON
paths, optional `expiresPath`) tells the host to copy a **redacted** login
file into the box before the agent starts
(`packages/runtime/src/box-login-bridge.ts`):

- only the `keep` paths survive, and refresh-like keys never carry material
  into the box (a kept refresh key such as codex's `tokens.refresh_token`
  is written as an empty string so the CLI's parser still finds the field);
- the file lands at the same home-relative path as on the host
  (`~/.codex/auth.json`, `~/.local/share/opencode/auth.json`); an absolute or
  `..` path, an unparseable file, an empty result or an already-expired login
  is refused;
- on a session restart / re-attach the copy is re-uploaded, and while a
  session is working the host refreshes it in place (at most every 5 minutes),
  re-uploading only when its digest changed;
- the `auth` block forwarded to the box carries `loginFile: true`, a marker
  that the file is in place — never a token — so no credential lands in the
  session record. The marker is stamped by the host per spawn and is not
  settable from config (`defaults.adapters.*.auth.loginFile` is accepted and
  ignored).

When the copy cannot be made (login missing or unreadable on the host, bad
path, expired), no marker is stamped and the box falls back to verifying its
own login, which fails loud — the session never starts silently
unauthenticated.
