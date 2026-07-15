# @agentproto/providers-store

The `~/.agentproto/providers.json` LLM provider API-key store (mode 0600),
written by `agentproto auth provider set`, and the `injectProviderKeysIntoEnv`
helper that lets a process boot with those keys in its environment.

Before this store existed, the only way to give a process a provider key was
an ambient `export FOO_API_KEY=…` in whatever shell launched it — invisible,
easy to forget, per-shell. Set once via the CLI, every process that calls
`injectProviderKeysIntoEnv` at boot picks it up.

This package is a **leaf**: node builtins + `@agentproto/model-catalog` only,
so any standalone process (not just the `@agentproto/runtime` daemon) can
depend on it without dragging in a full gateway.

## Usage

```ts
import { injectProviderKeysIntoEnv } from "@agentproto/providers-store"

// Call once at process boot, before anything reads provider env vars.
// Explicit env always wins — a var already set is never overwritten.
const injected = await injectProviderKeysIntoEnv(process.env)
if (injected.length > 0) {
  console.error(`loaded ${injected.length} provider key(s) from store: ${injected.join(", ")}`)
}
```

Keys never leave the store except into the caller's own process env; they are
never logged — only provider *names*, never values, should reach output.

## API

- `loadProviders()` / `setProviderKey(provider, apiKey, baseUrl?)` /
  `removeProviderKey(provider)` / `getProviderKey(provider)` — read/write
  `providers.json`.
- `injectProviderKeysIntoEnv(env?)` — injects stored keys into `env`
  (default `process.env`), skipping any name already set. Returns the list of
  provider names actually injected.
- `providerEnvVar(provider)` / `PROVIDER_ENV_VARS` — canonical provider →
  env-var-name mapping (derived from `@agentproto/model-catalog`'s
  `PROVIDER_KEY_ENV`, plus the non-catalog gateway providers this store also
  fronts).
- `providersPath()` — resolves `~/.agentproto/providers.json`.

`@agentproto/runtime` re-exports this package's surface unchanged (including
the `@agentproto/runtime/providers-store` subpath) for existing consumers.

## License

Apache-2.0
