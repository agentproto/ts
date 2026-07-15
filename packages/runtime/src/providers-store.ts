/**
 * Re-exports `@agentproto/providers-store` unchanged. Moved out of `runtime`
 * so a standalone process (e.g. `@agentproto/llm-endpoint`, which has zero
 * runtime deps) can read the provider-key store without depending on the
 * whole daemon. Kept as a same-named module (rather than deleting it) so the
 * `@agentproto/runtime/providers-store` subpath and every existing relative
 * `./providers-store.js` import in this package keep working.
 */
export * from "@agentproto/providers-store"
